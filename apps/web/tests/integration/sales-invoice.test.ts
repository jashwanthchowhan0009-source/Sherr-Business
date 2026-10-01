import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import {
  allocateReceipt,
  allocateVoucherNumber,
  createVoucher,
  markReversed,
  postVoucher,
  resolveAccountIds,
} from '../../src/lib/db/ledger';
import { calculateInvoice, determineSupplyType } from '../../src/lib/accounting/gst';
import {
  receiptEntries,
  reverseEntries,
  salesInvoiceEntries,
} from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import { cleanup, expectDbRejection, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * The full sales path against real Postgres, through the same repository code
 * the server actions call — not a re-implementation of it in the test.
 *
 * The fixture companies are in Karnataka (state 29), set by seedTwoOrgs.
 */
describe('sales invoice', () => {
  let owner: Pool;
  let fx: Fixture;
  let customerKa: string;
  let customerMh: string;

  const raise = async (
    orgId: string,
    input: {
      placeOfSupply: string;
      partyId: string;
      date?: string;
      lines: { rupees: bigint; rateBps: number; qty?: bigint }[];
      post?: boolean;
    },
  ) =>
    withTenant({ orgId, userId: null }, async (tx) => {
      const supplyType = determineSupplyType({
        supplierStateCode: '29',
        placeOfSupplyStateCode: input.placeOfSupply,
      });
      const lines = input.lines.map((l) => ({
        itemId: null,
        description: `${l.rupees} at ${l.rateBps}bps`,
        hsnSac: '1006',
        unit: 'NOS',
        quantity: (l.qty ?? 1n) * QTY_SCALE,
        unitPricePaise: l.rupees * 100n,
        discountPaise: 0n,
        gstRateBps: l.rateBps,
        cessRateBps: 0,
        reverseCharge: false,
      }));
      const calculation = calculateInvoice(lines, supplyType);
      const voucherDate = input.date ?? '2025-06-15';
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'sales',
        fyLabel: '25-26',
        prefix: 'INV',
      });
      const created = await createVoucher(tx, {
        voucherType: 'sales',
        voucherNo,
        fyLabel: '25-26',
        voucherDate,
        partyId: input.partyId,
        supplierStateCode: '29',
        placeOfSupplyStateCode: input.placeOfSupply,
        supplyType,
        reference: null,
        narration: null,
        calculation,
        lines,
        entries: salesInvoiceEntries(calculation),
      });
      if (input.post !== false) await postVoucher(tx, { voucherId: created.id, userId: null });
      return { ...created, calculation };
    });

  const ledgerOf = async (orgId: string, voucherId: string) =>
    withTenant({ orgId, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ code: string; debit: string; credit: string }>(sql`
        select a.code, l.debit_paise::text as debit, l.credit_paise::text as credit
          from ledger_entries l
          join accounts a on a.id = l.account_id
         where l.voucher_id = ${voucherId}::uuid
         order by a.code
      `);
      return rows.map((r) => ({
        code: r.code,
        debit: BigInt(r.debit),
        credit: BigInt(r.credit),
      }));
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `inv${Date.now()}`);

    const mkParty = (orgId: string, name: string, state: string, gstin: string | null) =>
      withTenant({ orgId, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, name, gstin, state_code, place_of_supply_state_code)
          values (app_current_org_id(), 'customer', ${name}, ${gstin}, ${state}, ${state})
          returning id
        `);
        return rows[0]!.id;
      });

    customerKa = await mkParty(fx.orgA, 'Karnataka Customer', '29', '29AAACP1234A1Z1');
    customerMh = await mkParty(fx.orgA, 'Maharashtra Customer', '27', '27AAACQ5678B1Z2');
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  it('posts the spec §11 intra-state invoice to the right accounts', async () => {
    const { id, calculation } = await raise(fx.orgA, {
      partyId: customerKa,
      placeOfSupply: '29',
      lines: [{ rupees: 100_000n, rateBps: 1800 }],
    });

    expect(calculation.cgstPaise).toBe(900_000n); // ₹9,000
    expect(calculation.sgstPaise).toBe(900_000n); // ₹9,000
    expect(calculation.totalPaise).toBe(11_800_000n); // ₹1,18,000

    const entries = await ledgerOf(fx.orgA, id);
    expect(entries).toEqual([
      { code: 'OUTPUT_CGST', debit: 0n, credit: 900_000n },
      { code: 'OUTPUT_SGST', debit: 0n, credit: 900_000n },
      { code: 'SALES', debit: 0n, credit: 10_000_000n },
      { code: 'SUNDRY_DEBTORS', debit: 11_800_000n, credit: 0n },
    ]);
  });

  it('posts the spec §11 inter-state invoice to IGST', async () => {
    const { id, calculation } = await raise(fx.orgA, {
      partyId: customerMh,
      placeOfSupply: '27',
      lines: [{ rupees: 100_000n, rateBps: 1800 }],
    });

    expect(calculation.igstPaise).toBe(1_800_000n); // ₹18,000
    const codes = (await ledgerOf(fx.orgA, id)).map((e) => e.code);
    expect(codes).toEqual(['OUTPUT_IGST', 'SALES', 'SUNDRY_DEBTORS']);
  });

  it('writes a ledger that balances, for every slab', async () => {
    for (const rateBps of [0, 500, 1200, 1800, 2800]) {
      const { id } = await raise(fx.orgA, {
        partyId: customerKa,
        placeOfSupply: '29',
        lines: [{ rupees: 7_777n, rateBps, qty: 3n }],
      });
      const entries = await ledgerOf(fx.orgA, id);
      const debit = entries.reduce((a, e) => a + e.debit, 0n);
      const credit = entries.reduce((a, e) => a + e.credit, 0n);
      expect(debit, `slab ${rateBps}`).toBe(credit);
      expect(debit).toBeGreaterThan(0n);
    }
  });

  it('stores tax lines at the half rate for CGST and SGST', async () => {
    const { id } = await raise(fx.orgA, {
      partyId: customerKa,
      placeOfSupply: '29',
      lines: [{ rupees: 100_000n, rateBps: 1800 }],
    });
    const rows = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ head: string; rate_bps: number; amount: string }>(sql`
        select head, rate_bps, amount_paise::text as amount
          from tax_lines where voucher_id = ${id}::uuid order by head
      `);
      return rows;
    });
    // An 18% supply shows CGST at 9% and SGST at 9%, not at 18%.
    expect(rows).toEqual([
      { head: 'cgst', rate_bps: 900, amount: '900000' },
      { head: 'sgst', rate_bps: 900, amount: '900000' },
    ]);
  });

  it('numbers invoices sequentially within the financial year', async () => {
    const a = await raise(fx.orgA, { partyId: customerKa, placeOfSupply: '29', lines: [{ rupees: 100n, rateBps: 500 }] });
    const b = await raise(fx.orgA, { partyId: customerKa, placeOfSupply: '29', lines: [{ rupees: 100n, rateBps: 500 }] });
    expect(a.voucherNo).toMatch(/^INV\/25-26\/\d{4}$/);
    const seq = (no: string) => Number(no.split('/')[2]);
    expect(seq(b.voucherNo)).toBe(seq(a.voucherNo) + 1);
  });

  it('restarts numbering in a new financial year', async () => {
    const no = await withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
      allocateVoucherNumber(tx, { voucherType: 'sales', fyLabel: '26-27', prefix: 'INV' }),
    );
    expect(no).toBe('INV/26-27/0001');
  });

  it('refuses to edit a posted invoice', async () => {
    const { id } = await raise(fx.orgA, {
      partyId: customerKa,
      placeOfSupply: '29',
      lines: [{ rupees: 500n, rateBps: 500 }],
    });
    await expectDbRejection(
      withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
        tx.execute(sql`update vouchers set narration = 'tampered' where id = ${id}::uuid`),
      ),
      /posted and cannot be edited/i,
    );
  });

  it('refuses to delete a posted invoice or change its ledger', async () => {
    const { id } = await raise(fx.orgA, {
      partyId: customerKa,
      placeOfSupply: '29',
      lines: [{ rupees: 500n, rateBps: 500 }],
    });
    await expectDbRejection(
      withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
        tx.execute(sql`delete from vouchers where id = ${id}::uuid`),
      ),
      /posted and cannot be deleted/i,
    );
    await expectDbRejection(
      withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
        tx.execute(sql`update ledger_entries set debit_paise = 1 where voucher_id = ${id}::uuid`),
      ),
      /cannot be changed/i,
    );
  });

  it('refuses to post an invoice whose entries do not balance', async () => {
    await expectDbRejection(
      withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'journal',
          fyLabel: '25-26',
          prefix: 'JV',
        });
        const accounts = await resolveAccountIds(tx, ['SUNDRY_DEBTORS']);
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into vouchers (org_id, voucher_type, voucher_no, fy_label, voucher_date, status)
          values (app_current_org_id(), 'journal', ${voucherNo}, '25-26', '2025-06-15', 'draft')
          returning id
        `);
        const voucherId = rows[0]!.id;
        await tx.execute(sql`
          insert into ledger_entries (org_id, voucher_id, account_id, entry_date, debit_paise)
          values (app_current_org_id(), ${voucherId}::uuid,
                  ${accounts.get('SUNDRY_DEBTORS')!}::uuid, '2025-06-15', 100000)
        `);
        // One-sided: the deferred trigger must reject this at COMMIT.
        await postVoucher(tx, { voucherId, userId: null });
      }),
      /does not balance/i,
    );
  });

  it('corrects a posted invoice by reversal, leaving both vouchers visible', async () => {
    const original = await raise(fx.orgA, {
      partyId: customerKa,
      placeOfSupply: '29',
      lines: [{ rupees: 1_000n, rateBps: 1800 }],
    });

    const reversal = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'credit_note',
        fyLabel: '25-26',
        prefix: 'CRN',
      });
      const created = await createVoucher(tx, {
        voucherType: 'credit_note',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: '2025-06-20',
        partyId: customerKa,
        supplierStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: 'intra_state',
        reference: original.voucherNo,
        narration: `Reversal of ${original.voucherNo}`,
        calculation: null,
        lines: [],
        entries: reverseEntries(salesInvoiceEntries(original.calculation)),
        totalPaise: original.totalPaise,
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      await markReversed(tx, {
        originalVoucherId: original.id,
        reversalVoucherId: created.id,
      });
      return created;
    });

    // The mistake and the fix both remain; nothing was edited away.
    const net = [
      ...(await ledgerOf(fx.orgA, original.id)),
      ...(await ledgerOf(fx.orgA, reversal.id)),
    ].reduce((acc, e) => acc + e.debit - e.credit, 0n);
    expect(net).toBe(0n);

    const [row] = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ reversed_by: string | null; status: string }>(sql`
        select reversed_by_voucher_id as reversed_by, status
          from vouchers where id = ${original.id}::uuid
      `);
      return rows;
    });
    expect(row?.reversed_by).toBe(reversal.id);
    expect(row?.status).toBe('posted');
  });

  it('allocates a receipt against the oldest open invoice first', async () => {
    const party = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, name, state_code, place_of_supply_state_code)
        values (app_current_org_id(), 'customer', 'Ageing Customer', '29', '29')
        returning id
      `);
      return rows[0]!.id;
    });

    // ₹1,180 then ₹2,360, raised on different days.
    const first = await raise(fx.orgA, {
      partyId: party, placeOfSupply: '29', date: '2025-05-01',
      lines: [{ rupees: 1_000n, rateBps: 1800 }],
    });
    const second = await raise(fx.orgA, {
      partyId: party, placeOfSupply: '29', date: '2025-05-20',
      lines: [{ rupees: 2_000n, rateBps: 1800 }],
    });

    // A receipt that covers the first invoice and part of the second.
    const result = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'receipt', fyLabel: '25-26', prefix: 'RCT',
      });
      const amountPaise = first.totalPaise + 100_000n; // first invoice + ₹1,000
      const created = await createVoucher(tx, {
        voucherType: 'receipt',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: '2025-06-01',
        partyId: party,
        supplierStateCode: null,
        placeOfSupplyStateCode: null,
        supplyType: null,
        reference: null,
        narration: null,
        calculation: null,
        lines: [],
        entries: receiptEntries({ amountPaise, intoAccountCode: 'BANK' }),
        totalPaise: amountPaise,
      });
      const allocation = await allocateReceipt(tx, {
        settlementVoucherId: created.id,
        partyId: party,
        amountPaise,
        explicitTargets: [],
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return { created, allocation, amountPaise };
    });

    expect(result.allocation.allocatedPaise).toBe(result.amountPaise);
    expect(result.allocation.unallocatedPaise).toBe(0n);

    const allocations = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ target: string; amount: string }>(sql`
        select target_voucher_id as target, amount_paise::text as amount
          from voucher_allocations
         where settlement_voucher_id = ${result.created.id}::uuid
         order by amount_paise desc
      `);
      return rows;
    });

    // The older invoice is cleared in full before the newer one is touched.
    expect(allocations).toEqual([
      { target: first.id, amount: first.totalPaise.toString() },
      { target: second.id, amount: '100000' },
    ]);
  });

  it('records an advance as unallocated rather than refusing it', async () => {
    const party = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, name, state_code)
        values (app_current_org_id(), 'customer', 'Advance Customer', '29')
        returning id
      `);
      return rows[0]!.id;
    });

    const allocation = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'receipt', fyLabel: '25-26', prefix: 'RCT',
      });
      const created = await createVoucher(tx, {
        voucherType: 'receipt',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: '2025-06-01',
        partyId: party,
        supplierStateCode: null,
        placeOfSupplyStateCode: null,
        supplyType: null,
        reference: null,
        narration: 'Advance against future supply',
        calculation: null,
        lines: [],
        entries: receiptEntries({ amountPaise: 500_000n, intoAccountCode: 'CASH' }),
        totalPaise: 500_000n,
      });
      return allocateReceipt(tx, {
        settlementVoucherId: created.id,
        partyId: party,
        amountPaise: 500_000n,
        explicitTargets: [],
      });
    });

    expect(allocation.allocatedPaise).toBe(0n);
    expect(allocation.unallocatedPaise).toBe(500_000n);
  });

  it('keeps org B from seeing or numbering against org A', async () => {
    const { id } = await raise(fx.orgA, {
      partyId: customerKa,
      placeOfSupply: '29',
      lines: [{ rupees: 100n, rateBps: 500 }],
    });

    const seen = await withTenant({ orgId: fx.orgB, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from vouchers where id = ${id}::uuid
      `);
      return Number(rows[0]!.n);
    });
    expect(seen).toBe(0);

    // Org B's own series starts at 1 regardless of how many org A has raised.
    const no = await withTenant({ orgId: fx.orgB, userId: null }, (tx) =>
      allocateVoucherNumber(tx, { voucherType: 'sales', fyLabel: '25-26', prefix: 'INV' }),
    );
    expect(no).toBe('INV/25-26/0001');
  });

  // Postgres resolves a foreign key with an internal check that ignores row
  // level security, so a plain `references parties (id)` let org B's voucher
  // point at org A's customer. The composite (id, org_id) keys in 0003 close
  // it; this is the case that found it.
  it('refuses to raise an invoice against another company’s customer', async () => {
    await expectDbRejection(
      raise(fx.orgB, {
        partyId: customerKa,
        placeOfSupply: '29',
        lines: [{ rupees: 100n, rateBps: 500 }],
      }),
      /violates foreign key constraint/i,
    );
  });

  it('refuses to post a ledger entry against another company’s account', async () => {
    const foreignAccount = await withTenant({ orgId: fx.orgB, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        select id from accounts where code = 'SALES'
      `);
      return rows[0]!.id;
    });

    await expectDbRejection(
      withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'journal', fyLabel: '25-26', prefix: 'JV',
        });
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into vouchers (org_id, voucher_type, voucher_no, fy_label, voucher_date, status)
          values (app_current_org_id(), 'journal', ${voucherNo}, '25-26', '2025-06-15', 'draft')
          returning id
        `);
        await tx.execute(sql`
          insert into ledger_entries (org_id, voucher_id, account_id, entry_date, debit_paise)
          values (app_current_org_id(), ${rows[0]!.id}::uuid, ${foreignAccount}::uuid,
                  '2025-06-15', 100000)
        `);
      }),
      /violates foreign key constraint/i,
    );
  });
});
