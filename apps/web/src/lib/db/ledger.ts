import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from './tenant';
import { accounts } from './schema';
import type { PostingEntry } from '@/lib/accounting/posting';
import type { GstInvoiceResult } from '@/lib/accounting/gst';
import type { SupplyTypeValue, VoucherType } from './schema';
import { notFound, conflict } from '@/lib/errors';

/**
 * Every write to the voucher core, in one place.
 *
 * Each function takes the `Tx` handed out by `withTenant`, so the tenant GUC is
 * already set and RLS is doing the isolating. None of these functions opens its
 * own transaction: a voucher, its lines, its tax lines and its ledger entries
 * must be one atomic unit, and the deferred balance trigger only fires at the
 * commit of the transaction the caller controls.
 */

/**
 * Resolves stable account codes to this company's account ids.
 *
 * The posting engine names accounts by code because a code is stable across
 * companies and can be asserted in a unit test; the database needs an id. A
 * missing code is an error rather than a skipped entry — a chart that lacks
 * Output CGST cannot record a sale, and silently dropping the line would
 * produce an unbalanced voucher.
 */
export async function resolveAccountIds(
  tx: Tx,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(codes)];
  if (wanted.length === 0) return new Map();

  // The query builder, not a raw `any(...)`: drizzle's sql template inlines a
  // JS array as a record rather than as one array parameter.
  const rows = await tx
    .select({ code: accounts.code, id: accounts.id })
    .from(accounts)
    .where(and(inArray(accounts.code, wanted), eq(accounts.isActive, true)));

  const found = new Map(rows.map((r) => [r.code, r.id]));
  const missing = wanted.filter((c) => !found.has(c));
  if (missing.length > 0) {
    throw notFound(
      `This company's chart of accounts is missing ${missing.join(', ')}. ` +
        `It cannot record this entry until those accounts exist.`,
    );
  }
  return found;
}

export async function allocateVoucherNumber(
  tx: Tx,
  input: { voucherType: VoucherType; fyLabel: string; prefix: string; width?: number },
): Promise<string> {
  const { rows } = await tx.execute<{ no: string }>(sql`
    select app_next_voucher_number(
      ${input.voucherType}, ${input.fyLabel}, ${input.prefix}, ${input.width ?? 4}
    ) as no
  `);
  const row = rows[0];
  if (!row) throw new Error('app_next_voucher_number returned no row');
  return row.no;
}

export interface VoucherLineInput {
  itemId: string | null;
  description: string;
  hsnSac: string | null;
  unit: string | null;
  quantity: bigint;
  unitPricePaise: bigint;
  discountPaise: bigint;
  gstRateBps: number;
  cessRateBps: number;
  reverseCharge: boolean;
}

export interface CreateVoucherInput {
  voucherType: VoucherType;
  voucherNo: string;
  fyLabel: string;
  voucherDate: string;
  partyId: string | null;
  supplierStateCode: string | null;
  placeOfSupplyStateCode: string | null;
  supplyType: SupplyTypeValue | null;
  reference: string | null;
  supplierInvoiceNo?: string | null;
  supplierInvoiceDate?: string | null;
  narration: string | null;
  calculation: GstInvoiceResult | null;
  lines: readonly VoucherLineInput[];
  entries: readonly PostingEntry[];
  /** Total the voucher settles for, when there is no GST calculation. */
  totalPaise?: bigint;
  sourceDocumentId?: string | null;
  /** Set on a reversal, naming the voucher it cancels. */
  reversesVoucherId?: string | null;
  /** Set on a replacement posted by "Edit", naming the voucher it corrects. */
  correctsVoucherId?: string | null;
}

export interface CreatedVoucher {
  id: string;
  voucherNo: string;
  totalPaise: bigint;
}

/**
 * Writes a voucher and everything that belongs to it, as a draft.
 *
 * Deliberately always a draft. Posting is a separate call, so the transition
 * that makes a voucher immutable is always an explicit, separately
 * capability-gated act rather than a side effect of creating one.
 */
export async function createVoucher(tx: Tx, input: CreateVoucherInput): Promise<CreatedVoucher> {
  const calc = input.calculation;
  const totalPaise = calc ? calc.totalPaise : (input.totalPaise ?? 0n);

  const { rows } = await tx.execute<{ id: string }>(sql`
    insert into vouchers (
      org_id, voucher_type, voucher_no, fy_label, voucher_date, party_id,
      supplier_state_code, place_of_supply_state_code, supply_type,
      reference, supplier_invoice_no, supplier_invoice_date, narration,
      taxable_paise, cgst_paise, sgst_paise, igst_paise, cess_paise,
      round_off_paise, total_paise, status, source_document_id, reverses_voucher_id,
      corrects_voucher_id
    ) values (
      app_current_org_id(), ${input.voucherType}, ${input.voucherNo}, ${input.fyLabel},
      ${input.voucherDate}::date, ${input.partyId}::uuid,
      ${input.supplierStateCode}, ${input.placeOfSupplyStateCode}, ${input.supplyType},
      ${input.reference}, ${input.supplierInvoiceNo ?? null},
      ${input.supplierInvoiceDate ?? null}::date, ${input.narration},
      ${calc?.taxablePaise ?? 0n}, ${calc?.cgstPaise ?? 0n}, ${calc?.sgstPaise ?? 0n},
      ${calc?.igstPaise ?? 0n}, ${calc?.cessPaise ?? 0n}, ${calc?.roundOffPaise ?? 0n},
      ${totalPaise}, 'draft', ${input.sourceDocumentId ?? null}::uuid,
      ${input.reversesVoucherId ?? null}::uuid, ${input.correctsVoucherId ?? null}::uuid
    ) returning id
  `);
  const voucher = rows[0];
  if (!voucher) throw new Error('Voucher insert returned no row');

  // Lines carry the per-line calculation, so an invoice reprints identically
  // years later even if a rate or a price has since changed.
  for (const [index, line] of input.lines.entries()) {
    const result = calc?.lines[index];
    await tx.execute(sql`
      insert into voucher_lines (
        org_id, voucher_id, line_no, item_id, description, hsn_sac, unit,
        quantity, unit_price_paise, discount_paise, gst_rate_bps, cess_rate_bps,
        taxable_paise, cgst_paise, sgst_paise, igst_paise, cess_paise,
        line_total_paise, reverse_charge
      ) values (
        app_current_org_id(), ${voucher.id}::uuid, ${index + 1}, ${line.itemId}::uuid,
        ${line.description}, ${line.hsnSac}, ${line.unit},
        ${line.quantity}, ${line.unitPricePaise}, ${line.discountPaise},
        ${line.gstRateBps}, ${line.cessRateBps},
        ${result?.taxablePaise ?? 0n}, ${result?.cgstPaise ?? 0n}, ${result?.sgstPaise ?? 0n},
        ${result?.igstPaise ?? 0n}, ${result?.cessPaise ?? 0n}, ${result?.linePaise ?? 0n},
        ${line.reverseCharge}
      )
    `);
  }

  if (calc) await insertTaxLines(tx, voucher.id, calc, input.lines);
  await insertLedgerEntries(tx, {
    voucherId: voucher.id,
    entryDate: input.voucherDate,
    partyId: input.partyId,
    entries: input.entries,
  });

  return { id: voucher.id, voucherNo: input.voucherNo, totalPaise };
}

/**
 * One tax line per head per rate — the shape GSTR-1 reports in, so the return
 * is a query over stored rows rather than a recalculation months later.
 *
 * The rates come from the line inputs, not from dividing tax by taxable value.
 * Deriving a rate back out of two rounded integers can land a paisa either
 * side of the slab and put ₹9,000 of CGST under a rate of 1799 basis points.
 */
async function insertTaxLines(
  tx: Tx,
  voucherId: string,
  calc: GstInvoiceResult,
  lines: readonly VoucherLineInput[],
): Promise<void> {
  const grouped = new Map<string, { head: string; rateBps: number; taxable: bigint; amount: bigint }>();

  const add = (head: string, rateBps: number, taxable: bigint, amount: bigint) => {
    if (amount === 0n) return;
    const key = `${head}:${rateBps}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.taxable += taxable;
      existing.amount += amount;
    } else {
      grouped.set(key, { head, rateBps, taxable, amount });
    }
  };

  for (const [index, result] of calc.lines.entries()) {
    const input = lines[index];
    if (!input) continue;
    // CGST and SGST each carry half the slab, which is the rate that belongs on
    // the tax line: an 18% supply shows CGST at 9%, not at 18%.
    const half = Math.round(input.gstRateBps / 2);
    add('cgst', half, result.taxablePaise, result.cgstPaise);
    add('sgst', half, result.taxablePaise, result.sgstPaise);
    add('igst', input.gstRateBps, result.taxablePaise, result.igstPaise);
    add('cess', input.cessRateBps, result.taxablePaise, result.cessPaise);
  }

  for (const entry of grouped.values()) {
    await tx.execute(sql`
      insert into tax_lines (org_id, voucher_id, head, rate_bps, taxable_paise, amount_paise)
      values (app_current_org_id(), ${voucherId}::uuid, ${entry.head}, ${entry.rateBps},
              ${entry.taxable}, ${entry.amount})
    `);
  }
}

export async function insertLedgerEntries(
  tx: Tx,
  input: {
    voucherId: string;
    entryDate: string;
    partyId: string | null;
    entries: readonly PostingEntry[];
  },
): Promise<void> {
  const accountIds = await resolveAccountIds(
    tx,
    input.entries.map((e) => e.accountCode),
  );

  for (const entry of input.entries) {
    await tx.execute(sql`
      insert into ledger_entries (
        org_id, voucher_id, account_id, party_id, entry_date,
        debit_paise, credit_paise, narration
      ) values (
        app_current_org_id(), ${input.voucherId}::uuid,
        ${accountIds.get(entry.accountCode)!}::uuid,
        ${entry.withParty ? input.partyId : null}::uuid,
        ${input.entryDate}::date, ${entry.debitPaise}, ${entry.creditPaise},
        ${entry.narration ?? null}
      )
    `);
  }
}

/**
 * Posts a draft voucher.
 *
 * After this returns the voucher is immutable: the database triggers reject any
 * further UPDATE or DELETE on it, its lines or its entries. The balance is
 * re-asserted at COMMIT by the deferred trigger, so a caller cannot post an
 * unbalanced voucher even by writing entries directly.
 */
export async function postVoucher(
  tx: Tx,
  input: { voucherId: string; userId: string | null },
): Promise<{ voucherNo: string; totalPaise: bigint }> {
  const { rows } = await tx.execute<{ status: string; voucher_no: string; total_paise: string }>(sql`
    select status, voucher_no, total_paise::text from vouchers where id = ${input.voucherId}::uuid
  `);
  const voucher = rows[0];
  if (!voucher) throw notFound('That voucher does not exist in this company.');
  if (voucher.status === 'posted') {
    throw conflict(`${voucher.voucher_no} is already posted.`);
  }

  await tx.execute(sql`
    update vouchers
       set status = 'posted', posted_at = now(), posted_by = ${input.userId}::uuid, updated_at = now()
     where id = ${input.voucherId}::uuid and status = 'draft'
  `);

  return { voucherNo: voucher.voucher_no, totalPaise: BigInt(voucher.total_paise) };
}

/**
 * Records that a posted voucher has been reversed.
 *
 * This is the only column a posted voucher may have written to it, and the
 * trigger in 0003 enforces that. It is written on the original, not the
 * reversal, so a report can exclude reversed vouchers with one predicate.
 */
export async function markReversed(
  tx: Tx,
  input: { originalVoucherId: string; reversalVoucherId: string },
): Promise<void> {
  await tx.execute(sql`
    update vouchers
       set reversed_by_voucher_id = ${input.reversalVoucherId}::uuid
     where id = ${input.originalVoucherId}::uuid
  `);
}

/**
 * Allocates a receipt or a payment against the party's open documents.
 *
 * Oldest first when the caller names no targets, which is the convention every
 * Indian accountant expects and what makes the ageing report meaningful. A
 * settlement larger than the outstanding balance is allowed and leaves the
 * remainder unallocated — an advance is a real thing, and refusing one would
 * make the app unable to record a deposit.
 *
 * One function for both directions because the logic is identical and the only
 * difference is which voucher type is being settled; two copies would drift,
 * and the one that drifted would be payables, which is the one that costs money.
 */
export async function allocateSettlement(
  tx: Tx,
  input: {
    settlementVoucherId: string;
    partyId: string;
    amountPaise: bigint;
    /** 'sales' for a receipt clearing invoices, 'purchase' for a payment clearing bills. */
    settles: 'sales' | 'purchase';
    explicitTargets: readonly string[];
  },
): Promise<{ allocatedPaise: bigint; unallocatedPaise: bigint }> {
  // A credit note reduces what a customer owes, and a debit note what we owe a
  // supplier. Both are allocated through this same function when they are
  // posted, so they appear in voucher_allocations and the outstanding figure
  // below already nets them off. Nothing special-cases them here.
  const { rows } = await tx.execute<{ id: string; outstanding: string }>(sql`
    select v.id,
           (v.total_paise
             - coalesce((select sum(a.amount_paise) from voucher_allocations a
                          where a.target_voucher_id = v.id), 0))::text as outstanding
      from vouchers v
     where v.party_id = ${input.partyId}::uuid
       and v.voucher_type = ${input.settles}
       and v.status = 'posted'
       and v.reversed_by_voucher_id is null
       ${
         input.explicitTargets.length > 0
           ? sql`and v.id = any(${sql.param([...input.explicitTargets])}::uuid[])`
           : sql``
       }
       and v.total_paise
             - coalesce((select sum(a.amount_paise) from voucher_allocations a
                          where a.target_voucher_id = v.id), 0) > 0
     order by v.voucher_date, v.voucher_no
  `);

  let remaining = input.amountPaise;
  for (const row of rows) {
    if (remaining <= 0n) break;
    const outstanding = BigInt(row.outstanding);
    const applied = outstanding < remaining ? outstanding : remaining;
    await tx.execute(sql`
      insert into voucher_allocations (org_id, settlement_voucher_id, target_voucher_id, amount_paise)
      values (app_current_org_id(), ${input.settlementVoucherId}::uuid, ${row.id}::uuid, ${applied})
      on conflict (settlement_voucher_id, target_voucher_id) do nothing
    `);
    remaining -= applied;
  }

  return { allocatedPaise: input.amountPaise - remaining, unallocatedPaise: remaining };
}

/** Receipts settle sales invoices. */
export async function allocateReceipt(
  tx: Tx,
  input: {
    settlementVoucherId: string;
    partyId: string;
    amountPaise: bigint;
    explicitTargets: readonly string[];
  },
): Promise<{ allocatedPaise: bigint; unallocatedPaise: bigint }> {
  return allocateSettlement(tx, { ...input, settles: 'sales' });
}

/** Payments settle purchase bills. */
export async function allocatePayment(
  tx: Tx,
  input: {
    settlementVoucherId: string;
    partyId: string;
    amountPaise: bigint;
    explicitTargets: readonly string[];
  },
): Promise<{ allocatedPaise: bigint; unallocatedPaise: bigint }> {
  return allocateSettlement(tx, { ...input, settles: 'purchase' });
}

/**
 * Reads a posted voucher's ledger entries back as postings, by account code.
 *
 * Used to build a reversal. The entries are read from the database rather than
 * recomputed from the voucher's amounts, so a reversal undoes what was actually
 * posted — including anything a later version of the engine would now compute
 * differently. That is the point of a reversal: it cancels the original, not a
 * fresh opinion of what the original should have been.
 */
export async function voucherPostings(
  tx: Tx,
  voucherId: string,
): Promise<readonly PostingEntry[]> {
  const { rows } = await tx.execute<{
    code: string;
    debit: string;
    credit: string;
    party_id: string | null;
    narration: string | null;
  }>(sql`
    select a.code, l.debit_paise::text as debit, l.credit_paise::text as credit,
           l.party_id, l.narration
      from ledger_entries l
      join accounts a on a.id = l.account_id
     where l.voucher_id = ${voucherId}::uuid
     order by l.created_at, a.code
  `);

  return rows.map((r) => ({
    accountCode: r.code,
    debitPaise: BigInt(r.debit),
    creditPaise: BigInt(r.credit),
    ...(r.party_id ? { withParty: true as const } : {}),
    ...(r.narration ? { narration: r.narration } : {}),
  }));
}

/**
 * Finds a posted bill already entered with the same supplier reference.
 *
 * The unique index in 0004 is what actually prevents the duplicate, including
 * against a concurrent second entry. This exists so the person entering it gets
 * told which bill it clashes with rather than a constraint name.
 */
export async function findDuplicateBill(
  tx: Tx,
  input: { partyId: string; supplierInvoiceNo: string; fyLabel: string },
): Promise<{ id: string; voucherNo: string; voucherDate: string; totalPaise: bigint } | null> {
  const { rows } = await tx.execute<{
    id: string;
    voucher_no: string;
    voucher_date: string;
    total_paise: string;
  }>(sql`
    select id, voucher_no, voucher_date::text, total_paise::text
      from vouchers
     where party_id = ${input.partyId}::uuid
       and upper(supplier_invoice_no) = upper(${input.supplierInvoiceNo})
       and fy_label = ${input.fyLabel}
       and voucher_type in ('purchase', 'debit_note')
       and status = 'posted'
       and reversed_by_voucher_id is null
     limit 1
  `);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        voucherNo: row.voucher_no,
        voucherDate: row.voucher_date,
        totalPaise: BigInt(row.total_paise),
      }
    : null;
}

/** The date the books are locked to, or null when nothing is locked. */
export async function lockedUpto(tx: Tx): Promise<string | null> {
  const { rows } = await tx.execute<{ locked_upto: string }>(sql`
    select locked_upto::text from period_locks limit 1
  `);
  return rows[0]?.locked_upto ?? null;
}
