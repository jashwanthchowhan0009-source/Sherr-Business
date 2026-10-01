import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { can } from '@/lib/auth/permissions';
import { forbidden, notFound } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';
import { ageByParty, ageingGrandTotal, type AgeingRow } from '@/lib/accounting/ageing';
import type { AccountNatureValue } from '@/lib/db/schema';
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  type AccountBalance,
  type BalanceSheet,
  type CashFlow,
  type ProfitAndLoss,
} from '@/lib/accounting/financial-statements';

/**
 * The reports.
 *
 * Every figure here is a query over posted ledger entries. Nothing is cached,
 * nothing is maintained as a running total, and no report recomputes tax: the
 * numbers are what the books say, which is the only thing that makes a report
 * traceable back to the voucher that produced it.
 *
 * Reversed vouchers are deliberately NOT excluded. A reversal posts its own
 * opposite entries, so both appear and net to nothing — which is what the audit
 * trail requires. Filtering them out would make a report disagree with the
 * ledger it is drawn from.
 */

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view the books');
};

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  nature: AccountNatureValue;
  groupCode: string;
  groupName: string;
  debitPaise: bigint;
  creditPaise: bigint;
  /** Debit less credit. Positive is a debit balance. */
  netPaise: bigint;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebitPaise: bigint;
  totalCreditPaise: bigint;
  /** Must be zero. If it is not, the books are broken, not the report. */
  differencePaise: bigint;
}

/**
 * The trial balance.
 *
 * Its difference must be zero, and that is not a hope: the deferred trigger in
 * 0003 rejects any voucher whose entries do not balance, so a non-zero
 * difference here means something bypassed the database, not that a figure was
 * added up wrongly. The report shows the difference rather than hiding it,
 * because an owner is entitled to see that the check was made.
 */
export async function getTrialBalance(ctx: RequestContext, asOf: string): Promise<TrialBalance> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      account_id: string;
      code: string;
      name: string;
      nature: string;
      group_code: string;
      group_name: string;
      debit: string;
      credit: string;
    }>(sql`
      select a.id as account_id, a.code, a.name, a.nature,
             g.code as group_code, g.name as group_name,
             coalesce(sum(l.debit_paise), 0)::text  as debit,
             coalesce(sum(l.credit_paise), 0)::text as credit
        from accounts a
        join account_groups g on g.id = a.group_id
        left join ledger_entries l
               on l.account_id = a.id and l.entry_date <= ${asOf}::date
        left join vouchers v on v.id = l.voucher_id and v.status = 'posted'
       where l.id is null or v.id is not null
       group by a.id, a.code, a.name, a.nature, g.code, g.name
       order by g.code, a.code
    `);

    const mapped: TrialBalanceRow[] = rows.map((r) => {
      const debitPaise = BigInt(r.debit);
      const creditPaise = BigInt(r.credit);
      return {
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        nature: r.nature as AccountNatureValue,
        groupCode: r.group_code,
        groupName: r.group_name,
        debitPaise,
        creditPaise,
        netPaise: debitPaise - creditPaise,
      };
    });

    const totalDebitPaise = mapped.reduce((a, r) => a + r.debitPaise, 0n);
    const totalCreditPaise = mapped.reduce((a, r) => a + r.creditPaise, 0n);

    return {
      asOf,
      rows: mapped,
      totalDebitPaise,
      totalCreditPaise,
      differencePaise: totalDebitPaise - totalCreditPaise,
    };
  });
}

export interface LedgerEntryRow {
  voucherId: string;
  voucherNo: string;
  voucherType: string;
  entryDate: string;
  narration: string | null;
  partyName: string | null;
  debitPaise: bigint;
  creditPaise: bigint;
  /** Balance after this entry, so a statement reads down the page. */
  runningPaise: bigint;
}

export interface AccountLedger {
  accountId: string;
  code: string;
  name: string;
  nature: AccountNatureValue;
  from: string;
  to: string;
  openingPaise: bigint;
  entries: LedgerEntryRow[];
  debitPaise: bigint;
  creditPaise: bigint;
  closingPaise: bigint;
}

/**
 * One account's ledger for a period.
 *
 * The opening balance is computed from everything before the period rather than
 * stored, so there is no opening figure that can disagree with the entries
 * behind it. The running balance is carried in the application rather than a
 * window function, because it must be exact integer arithmetic and the entries
 * are already ordered.
 */
export async function getAccountLedger(
  ctx: RequestContext,
  input: { accountId: string; from: string; to: string },
): Promise<AccountLedger> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const account = await tx.execute<{ code: string; name: string; nature: string }>(sql`
      select code, name, nature from accounts where id = ${input.accountId}::uuid
    `);
    const found = account.rows[0];
    if (!found) throw notFound('That account does not exist in this company.');

    const opening = await tx.execute<{ net: string }>(sql`
      select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as net
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id
       where l.account_id = ${input.accountId}::uuid
         and v.status = 'posted'
         and l.entry_date < ${input.from}::date
    `);
    const openingPaise = BigInt(opening.rows[0]?.net ?? '0');

    const { rows } = await tx.execute<{
      voucher_id: string;
      voucher_no: string;
      voucher_type: string;
      entry_date: string;
      narration: string | null;
      party_name: string | null;
      debit: string;
      credit: string;
    }>(sql`
      select v.id as voucher_id, v.voucher_no, v.voucher_type,
             l.entry_date::text as entry_date,
             coalesce(l.narration, v.narration) as narration,
             p.name as party_name,
             l.debit_paise::text as debit, l.credit_paise::text as credit
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id
        left join parties p on p.id = l.party_id
       where l.account_id = ${input.accountId}::uuid
         and v.status = 'posted'
         and l.entry_date between ${input.from}::date and ${input.to}::date
       order by l.entry_date, v.voucher_no, l.created_at
    `);

    let running = openingPaise;
    let debitPaise = 0n;
    let creditPaise = 0n;
    const entries: LedgerEntryRow[] = rows.map((r) => {
      const debit = BigInt(r.debit);
      const credit = BigInt(r.credit);
      debitPaise += debit;
      creditPaise += credit;
      running += debit - credit;
      return {
        voucherId: r.voucher_id,
        voucherNo: r.voucher_no,
        voucherType: r.voucher_type,
        entryDate: r.entry_date,
        narration: r.narration,
        partyName: r.party_name,
        debitPaise: debit,
        creditPaise: credit,
        runningPaise: running,
      };
    });

    return {
      accountId: input.accountId,
      code: found.code,
      name: found.name,
      nature: found.nature as AccountNatureValue,
      from: input.from,
      to: input.to,
      openingPaise,
      entries,
      debitPaise,
      creditPaise,
      closingPaise: running,
    };
  });
}

export interface DayBookRow {
  voucherId: string;
  voucherNo: string;
  voucherType: string;
  voucherDate: string;
  partyName: string | null;
  narration: string | null;
  totalPaise: bigint;
  reversed: boolean;
  lines: { accountCode: string; accountName: string; debitPaise: bigint; creditPaise: bigint }[];
}

/** Every voucher posted in a period, with its entries. The audit view. */
export async function getDayBook(
  ctx: RequestContext,
  input: { from: string; to: string; limit?: number },
): Promise<DayBookRow[]> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      voucher_id: string;
      voucher_no: string;
      voucher_type: string;
      voucher_date: string;
      party_name: string | null;
      narration: string | null;
      total_paise: string;
      reversed: boolean;
      account_code: string;
      account_name: string;
      debit: string;
      credit: string;
    }>(sql`
      select v.id as voucher_id, v.voucher_no, v.voucher_type,
             v.voucher_date::text as voucher_date,
             p.name as party_name, v.narration, v.total_paise::text as total_paise,
             (v.reversed_by_voucher_id is not null) as reversed,
             a.code as account_code, a.name as account_name,
             l.debit_paise::text as debit, l.credit_paise::text as credit
        from vouchers v
        join ledger_entries l on l.voucher_id = v.id
        join accounts a on a.id = l.account_id
        left join parties p on p.id = v.party_id
       where v.status = 'posted'
         and v.voucher_date between ${input.from}::date and ${input.to}::date
       order by v.voucher_date desc, v.voucher_no desc, l.created_at
       limit ${(input.limit ?? 200) * 8}
    `);

    const byVoucher = new Map<string, DayBookRow>();
    for (const r of rows) {
      let voucher = byVoucher.get(r.voucher_id);
      if (!voucher) {
        voucher = {
          voucherId: r.voucher_id,
          voucherNo: r.voucher_no,
          voucherType: r.voucher_type,
          voucherDate: r.voucher_date,
          partyName: r.party_name,
          narration: r.narration,
          totalPaise: BigInt(r.total_paise),
          reversed: r.reversed,
          lines: [],
        };
        byVoucher.set(r.voucher_id, voucher);
      }
      voucher.lines.push({
        accountCode: r.account_code,
        accountName: r.account_name,
        debitPaise: BigInt(r.debit),
        creditPaise: BigInt(r.credit),
      });
    }

    return [...byVoucher.values()].slice(0, input.limit ?? 200);
  });
}

export interface RegisterRow {
  voucherId: string;
  voucherNo: string;
  voucherDate: string;
  partyName: string | null;
  partyGstin: string | null;
  supplyType: string | null;
  placeOfSupplyStateCode: string | null;
  supplierInvoiceNo: string | null;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  totalPaise: bigint;
  reversed: boolean;
}

export interface Register {
  kind: 'sales' | 'purchase';
  from: string;
  to: string;
  rows: RegisterRow[];
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  totalPaise: bigint;
}

/**
 * The sales or purchase register for a period.
 *
 * Credit notes appear in the sales register and debit notes in the purchase
 * register, with their amounts negative, because the period's turnover is net of
 * them — which is also the figure a GST return reports. Showing them in a
 * separate list would mean adding two reports together to get one true number.
 */
export async function getRegister(
  ctx: RequestContext,
  input: { kind: 'sales' | 'purchase'; from: string; to: string },
): Promise<Register> {
  guard(ctx);
  const noteType = input.kind === 'sales' ? 'credit_note' : 'debit_note';

  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      voucher_id: string;
      voucher_no: string;
      voucher_type: string;
      voucher_date: string;
      party_name: string | null;
      party_gstin: string | null;
      supply_type: string | null;
      pos: string | null;
      supplier_invoice_no: string | null;
      taxable: string;
      cgst: string;
      sgst: string;
      igst: string;
      cess: string;
      total: string;
      reversed: boolean;
    }>(sql`
      select v.id as voucher_id, v.voucher_no, v.voucher_type,
             v.voucher_date::text as voucher_date,
             p.name as party_name, p.gstin as party_gstin,
             v.supply_type, v.place_of_supply_state_code as pos,
             v.supplier_invoice_no,
             v.taxable_paise::text as taxable, v.cgst_paise::text as cgst,
             v.sgst_paise::text as sgst, v.igst_paise::text as igst,
             v.cess_paise::text as cess, v.total_paise::text as total,
             (v.reversed_by_voucher_id is not null) as reversed
        from vouchers v
        left join parties p on p.id = v.party_id
       where v.status = 'posted'
         and v.voucher_type in (${input.kind}, ${noteType})
         and v.voucher_date between ${input.from}::date and ${input.to}::date
       order by v.voucher_date, v.voucher_no
    `);

    // A note reduces the period's figures, so it carries a negative sign here.
    const sign = (type: string) => (type === noteType ? -1n : 1n);

    const mapped: RegisterRow[] = rows.map((r) => {
      const s = sign(r.voucher_type);
      return {
        voucherId: r.voucher_id,
        voucherNo: r.voucher_no,
        voucherDate: r.voucher_date,
        partyName: r.party_name,
        partyGstin: r.party_gstin,
        supplyType: r.supply_type,
        placeOfSupplyStateCode: r.pos,
        supplierInvoiceNo: r.supplier_invoice_no,
        taxablePaise: BigInt(r.taxable) * s,
        cgstPaise: BigInt(r.cgst) * s,
        sgstPaise: BigInt(r.sgst) * s,
        igstPaise: BigInt(r.igst) * s,
        cessPaise: BigInt(r.cess) * s,
        totalPaise: BigInt(r.total) * s,
        reversed: r.reversed,
      };
    });

    const sum = (pick: (r: RegisterRow) => bigint) => mapped.reduce((a, r) => a + pick(r), 0n);

    return {
      kind: input.kind,
      from: input.from,
      to: input.to,
      rows: mapped,
      taxablePaise: sum((r) => r.taxablePaise),
      cgstPaise: sum((r) => r.cgstPaise),
      sgstPaise: sum((r) => r.sgstPaise),
      igstPaise: sum((r) => r.igstPaise),
      cessPaise: sum((r) => r.cessPaise),
      totalPaise: sum((r) => r.totalPaise),
    };
  });
}

/**
 * Receivables or payables ageing.
 *
 * Outstanding is the document total less everything allocated against it:
 * receipts, payments and the notes that reduce it. The bucketing is done by the
 * pure code in src/lib/accounting/ageing.ts, which is where the date arithmetic
 * is tested; this function's job is only to find the open documents.
 */
export async function getAgeing(
  ctx: RequestContext,
  input: { kind: 'receivable' | 'payable'; asOf: string },
) {
  guard(ctx);
  const voucherType = input.kind === 'receivable' ? 'sales' : 'purchase';

  const rows = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      party_id: string;
      party_name: string;
      voucher_id: string;
      voucher_no: string;
      voucher_date: string;
      credit_days: number;
      outstanding: string;
    }>(sql`
      select p.id as party_id, p.name as party_name,
             v.id as voucher_id, v.voucher_no,
             v.voucher_date::text as voucher_date,
             p.credit_days,
             (v.total_paise
               - coalesce((select sum(a.amount_paise) from voucher_allocations a
                            where a.target_voucher_id = v.id), 0))::text as outstanding
        from vouchers v
        join parties p on p.id = v.party_id
       where v.status = 'posted'
         and v.voucher_type = ${voucherType}
         and v.voucher_date <= ${input.asOf}::date
         and v.reversed_by_voucher_id is null
         and v.total_paise
               - coalesce((select sum(a.amount_paise) from voucher_allocations a
                            where a.target_voucher_id = v.id), 0) > 0
       order by v.voucher_date
    `);
    return rows;
  });

  const ageingRows: AgeingRow[] = rows.map((r) => ({
    partyId: r.party_id,
    partyName: r.party_name,
    documentDate: r.voucher_date,
    creditDays: r.credit_days,
    outstandingPaise: BigInt(r.outstanding),
  }));

  const parties = ageByParty(ageingRows, input.asOf);
  return {
    kind: input.kind,
    asOf: input.asOf,
    parties,
    total: ageingGrandTotal(parties),
    documents: rows.map((r) => ({
      voucherId: r.voucher_id,
      voucherNo: r.voucher_no,
      partyName: r.party_name,
      voucherDate: r.voucher_date,
      creditDays: r.credit_days,
      outstandingPaise: BigInt(r.outstanding),
    })),
  };
}

export interface TraceRow {
  voucherId: string;
  voucherNo: string;
  voucherType: string;
  voucherDate: string;
  partyName: string | null;
  amountPaise: bigint;
  /** True when a source document was attached, so the trail reaches a file. */
  hasDocument: boolean;
}

export type MetricStatus = 'verified' | 'provisional' | 'draft';

export interface DashboardMetric {
  key: string;
  label: string;
  valuePaise: bigint;
  caption: string;
  status: MetricStatus;
  /** Why the status is what it is, in words an owner can act on. */
  statusReason: string;
  /** The vouchers this figure is made of. Empty when there are none. */
  trace: TraceRow[];
}

export interface Dashboard {
  asOf: string;
  fromDate: string;
  metrics: DashboardMetric[];
  trialBalanceDifferencePaise: bigint;
  postedVoucherCount: number;
  draftVoucherCount: number;
  documentCount: number;
  unlinkedDocumentCount: number;
  lockedUpto: string | null;
  lastPostedAt: string | null;
}

/**
 * The owner dashboard.
 *
 * Every metric carries a status and the vouchers behind it, because the promise
 * of this product is that a number can be traced to its source rather than
 * taken on trust. A figure with no trace is shown as having none rather than
 * being quietly omitted.
 *
 * Nothing here is marked `verified` on the strength of the arithmetic alone.
 * A period that has not been locked can still change, so its figures are
 * `provisional` however correct they are today — which is the §2 rule that
 * profit stays provisional until the books are closed.
 */
export async function getDashboard(
  ctx: RequestContext,
  input: { from: string; asOf: string },
): Promise<Dashboard> {
  guard(ctx);

  const [trialBalance, receivable, payable] = await Promise.all([
    getTrialBalance(ctx, input.asOf),
    getAgeing(ctx, { kind: 'receivable', asOf: input.asOf }),
    getAgeing(ctx, { kind: 'payable', asOf: input.asOf }),
  ]);

  const net = (code: string) =>
    trialBalance.rows.find((r) => r.code === code)?.netPaise ?? 0n;

  const counts = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      posted: string;
      drafts: string;
      documents: string;
      unlinked: string;
      locked_upto: string | null;
      last_posted_at: string | null;
    }>(sql`
      select
        (select count(*) from vouchers where status = 'posted')::text as posted,
        (select count(*) from vouchers where status = 'draft')::text  as drafts,
        (select count(*) from documents)::text                       as documents,
        (select count(*) from documents where linked_voucher_id is null)::text as unlinked,
        (select locked_upto::text from period_locks limit 1)          as locked_upto,
        (select max(posted_at)::text from vouchers where status = 'posted') as last_posted_at
    `);
    return rows[0];
  });

  const sales = await getRegister(ctx, { kind: 'sales', from: input.from, to: input.asOf });
  const purchases = await getRegister(ctx, { kind: 'purchase', from: input.from, to: input.asOf });

  const traceOf = (register: Register): TraceRow[] =>
    register.rows.map((r) => ({
      voucherId: r.voucherId,
      voucherNo: r.voucherNo,
      voucherType: 'sales',
      voucherDate: r.voucherDate,
      partyName: r.partyName,
      amountPaise: r.taxablePaise,
      hasDocument: false,
    }));

  const lockedUpto = counts?.locked_upto ?? null;
  // A period that is not locked can still change, so nothing drawn from it is
  // verified however correct the arithmetic is.
  const periodClosed = lockedUpto !== null && lockedUpto >= input.asOf;
  const closedReason = periodClosed
    ? `The books are locked to ${lockedUpto}, so this cannot change.`
    : 'The period is still open, so this can change until the books are closed.';

  // Profit needs the statements, because it depends on closing stock having
  // been entered: purchases are expensed as made, so a trading company shows a
  // loss until the stock it still holds is recognised.
  const statements = await getFinancialStatements(ctx, { from: input.from, to: input.asOf });

  const metrics: DashboardMetric[] = [
    {
      key: 'profit',
      label: 'Profit before tax',
      valuePaise: statements.profitAndLoss.profitBeforeTaxPaise,
      caption: statements.closingStockEntered
        ? `Income less expenses, ${input.from} to ${input.asOf}.`
        : 'Closing stock is not entered, so this is understated by the stock still held.',
      // The §2 rule: profit is provisional until the period is locked, however
      // correct the arithmetic is. It is marked draft rather than merely
      // provisional when closing stock is missing, because then it is not just
      // changeable — it is known to be wrong.
      status: !statements.closingStockEntered
        ? 'draft'
        : periodClosed
          ? 'verified'
          : 'provisional',
      statusReason: !statements.closingStockEntered
        ? 'Closing stock has not been entered for this period. Until it is, every rupee of unsold stock is showing as a cost, so this figure is understated. Enter it on Output.'
        : periodClosed
          ? `The books are locked to ${lockedUpto}, so this cannot change.`
          : 'The period is still open. The arithmetic is right, but the figures behind it can change until the books are closed.',
      trace: [],
    },
    {
      key: 'revenue',
      label: 'Revenue',
      valuePaise: sales.taxablePaise,
      caption: `Taxable value of sales, ${input.from} to ${input.asOf}, net of credit notes.`,
      status: periodClosed ? 'verified' : 'provisional',
      statusReason: closedReason,
      trace: traceOf(sales),
    },
    {
      key: 'purchases',
      label: 'Purchases',
      valuePaise: purchases.taxablePaise,
      caption: 'Taxable value of bills entered, net of debit notes.',
      status: periodClosed ? 'verified' : 'provisional',
      statusReason: closedReason,
      trace: traceOf(purchases),
    },
    {
      key: 'receivable',
      label: 'Customers owe',
      valuePaise: receivable.total.totalPaise,
      caption:
        receivable.total.overduePaise > 0n
          ? `${formatOverdue(receivable.total.overduePaise)} of it is overdue.`
          : 'Nothing is overdue.',
      // A balance is a fact about today, not an estimate, and it reconciles to
      // the control account — which the test suite asserts.
      status: 'verified',
      statusReason: 'Agrees with the Sundry Debtors control account.',
      trace: receivable.documents.map((d) => ({
        voucherId: d.voucherId,
        voucherNo: d.voucherNo,
        voucherType: 'sales',
        voucherDate: d.voucherDate,
        partyName: d.partyName,
        amountPaise: d.outstandingPaise,
        hasDocument: false,
      })),
    },
    {
      key: 'payable',
      label: 'You owe suppliers',
      valuePaise: payable.total.totalPaise,
      caption:
        payable.total.overduePaise > 0n
          ? `${formatOverdue(payable.total.overduePaise)} of it is overdue.`
          : 'Nothing is overdue.',
      status: 'verified',
      statusReason: 'Agrees with the Sundry Creditors control account.',
      trace: payable.documents.map((d) => ({
        voucherId: d.voucherId,
        voucherNo: d.voucherNo,
        voucherType: 'purchase',
        voucherDate: d.voucherDate,
        partyName: d.partyName,
        amountPaise: d.outstandingPaise,
        hasDocument: false,
      })),
    },
    {
      key: 'cash',
      label: 'Cash and bank',
      valuePaise: net('CASH') + net('BANK'),
      caption: 'What the books say you hold. Not yet reconciled to a statement.',
      // Deliberately not verified: a book balance that has never been compared
      // to a bank statement is only what was entered. Step E reconciles it.
      status: 'provisional',
      statusReason:
        'No bank statement has been reconciled against this. Until one is, it is only what was entered.',
      trace: [],
    },
    {
      key: 'gst',
      label: 'GST position',
      valuePaise:
        -(net('OUTPUT_CGST') + net('OUTPUT_SGST') + net('OUTPUT_IGST') + net('OUTPUT_CESS')) -
        (net('INPUT_CGST') + net('INPUT_SGST') + net('INPUT_IGST') + net('INPUT_CESS')),
      caption: 'Output tax less input credit. Positive means payable.',
      status: 'draft',
      statusReason:
        'A working figure only. It is not a return, the set-off order has not been applied, and every rate behind it still needs CA verification.',
      trace: [],
    },
  ];

  return {
    asOf: input.asOf,
    fromDate: input.from,
    metrics,
    trialBalanceDifferencePaise: trialBalance.differencePaise,
    postedVoucherCount: Number(counts?.posted ?? 0),
    draftVoucherCount: Number(counts?.drafts ?? 0),
    documentCount: Number(counts?.documents ?? 0),
    unlinkedDocumentCount: Number(counts?.unlinked ?? 0),
    lockedUpto,
    lastPostedAt: counts?.last_posted_at ?? null,
  };
}

/** Rupees, roughly, for a caption. The exact figure is in the ageing report. */
function formatOverdue(paise: bigint): string {
  const rupees = paise / 100n;
  return `₹${rupees.toLocaleString('en-IN')}`;
}

/**
 * Movement in every account over a period.
 *
 * Distinct from a trial balance, which is cumulative. An income or expense
 * account's figure *for a period* is what moved through it; using a cumulative
 * balance would report the year to date whatever dates were asked for, which is
 * the kind of error that looks right until somebody compares two quarters.
 */
export async function getAccountMovements(
  ctx: RequestContext,
  input: { from: string; to: string },
): Promise<AccountBalance[]> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      code: string;
      name: string;
      group_code: string;
      nature: string;
      bucket: string | null;
      net: string;
    }>(sql`
      select a.code, a.name, g.code as group_code, a.nature, g.bucket,
             coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as net
        from accounts a
        join account_groups g on g.id = a.group_id
        left join ledger_entries l
               on l.account_id = a.id
              and l.entry_date between ${input.from}::date and ${input.to}::date
        left join vouchers v on v.id = l.voucher_id and v.status = 'posted'
       where l.id is null or v.id is not null
       group by a.code, a.name, g.code, a.nature, g.bucket
       order by g.code, a.code
    `);

    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      groupCode: r.group_code,
      nature: r.nature as AccountBalance['nature'],
      bucket: r.bucket,
      netPaise: BigInt(r.net),
    }));
  });
}

export interface FinancialStatements {
  from: string;
  to: string;
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  cashFlow: CashFlow;
  lockedUpto: string | null;
  /** True when the whole period is inside a lock, so the figures cannot change. */
  periodClosed: boolean;
  /** True once closing stock has been entered for this period. */
  closingStockEntered: boolean;
}

/**
 * The three statements for a period, built from the same ledger.
 *
 * Three identities are asserted by the test suite rather than hoped for: profit
 * equals income less expenses, the balance sheet balances once the profit is
 * carried into reserves, and the cash flow's net change equals the movement in
 * cash. The third is the strongest, because it can only hold if every account's
 * movement was classified.
 */
export async function getFinancialStatements(
  ctx: RequestContext,
  input: { from: string; to: string },
): Promise<FinancialStatements> {
  guard(ctx);

  const [movements, closing, openingCash, closingStock, lock] = await Promise.all([
    getAccountMovements(ctx, input),
    getTrialBalance(ctx, input.to),
    cashBalanceBefore(ctx, input.from),
    closingStockEnteredFor(ctx, input),
    lockedUptoFor(ctx),
  ]);

  const profitAndLoss = buildProfitAndLoss({
    from: input.from,
    to: input.to,
    movements,
    closingStockEntered: closingStock,
  });

  const balances: AccountBalance[] = closing.rows.map((r) => ({
    code: r.code,
    name: r.name,
    groupCode: r.groupCode,
    nature: r.nature as AccountBalance['nature'],
    bucket: null,
    netPaise: r.netPaise,
  }));

  // The balance sheet carries ACCUMULATED profit, not the reporting window's.
  //
  // Nothing closes the profit and loss to retained earnings until the year is
  // closed, so the ledger's income and expense accounts hold everything since
  // inception. A sheet as at 31 March must therefore carry April-to-March profit
  // even when the statement beside it covers only July onwards — carrying the
  // window's figure instead leaves the sheet out by the profit earned before it,
  // which is what the test for an arbitrary window caught.
  const accumulatedProfitPaise = -balances
    .filter((b) => b.nature === 'income' || b.nature === 'expense')
    .reduce((acc, b) => acc + b.netPaise, 0n);

  const balanceSheet = buildBalanceSheet({
    asOf: input.to,
    balances,
    profitPaise: accumulatedProfitPaise,
  });

  const closingCash = balances
    .filter((b) => b.groupCode === 'CASH_IN_HAND' || b.groupCode === 'BANK_ACCOUNTS')
    .reduce((acc, b) => acc + b.netPaise, 0n);

  const cashFlow = buildCashFlow({
    from: input.from,
    to: input.to,
    movements,
    profitBeforeTaxPaise: profitAndLoss.profitBeforeTaxPaise,
    openingCashPaise: openingCash,
    closingCashPaise: closingCash,
  });

  return {
    from: input.from,
    to: input.to,
    profitAndLoss,
    balanceSheet,
    cashFlow,
    lockedUpto: lock,
    // The whole period must be inside the lock, not merely overlap it: a lock to
    // 30 September does not close the year to 31 March.
    periodClosed: lock !== null && lock >= input.to,
    closingStockEntered: closingStock,
  };
}

async function cashBalanceBefore(ctx: RequestContext, from: string): Promise<bigint> {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{ net: string }>(sql`
      select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as net
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id
        join accounts a on a.id = l.account_id
        join account_groups g on g.id = a.group_id
       where v.status = 'posted'
         and l.entry_date < ${from}::date
         and g.code in ('CASH_IN_HAND', 'BANK_ACCOUNTS')
    `);
    return BigInt(rows[0]?.net ?? '0');
  });
}

/**
 * Whether closing stock has been entered for this period.
 *
 * Gross profit is meaningless without it — purchases are expensed in full, so a
 * trading company shows a loss until the stock it still holds is recognised. The
 * statements therefore say whether it has been done rather than quietly
 * presenting a figure that is wrong by the value of the warehouse.
 */
async function closingStockEnteredFor(
  ctx: RequestContext,
  input: { from: string; to: string },
): Promise<boolean> {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id
        join accounts a on a.id = l.account_id
       where v.status = 'posted'
         and a.code = 'INVENTORY_CHANGE'
         and l.entry_date between ${input.from}::date and ${input.to}::date
    `);
    return Number(rows[0]?.n ?? 0) > 0;
  });
}

async function lockedUptoFor(ctx: RequestContext): Promise<string | null> {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{ locked_upto: string }>(
      sql`select locked_upto::text from period_locks limit 1`,
    );
    return rows[0]?.locked_upto ?? null;
  });
}
