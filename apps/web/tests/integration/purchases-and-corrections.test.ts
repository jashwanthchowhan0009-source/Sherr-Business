import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import {
  allocateVoucherNumber,
  createVoucher,
  findDuplicateBill,
  lockedUpto,
  markReversed,
  postVoucher,
  voucherPostings,
} from '../../src/lib/db/ledger';
import { calculateInvoice, determineSupplyType } from '../../src/lib/accounting/gst';
import {
  contraEntries,
  journalEntries,
  paymentEntries,
  purchaseBillEntries,
  reverseChargeLiabilityEntries,
  reverseEntries,
} from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import { cleanup, expectDbRejection, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * Step C against real Postgres: purchase bills and their duplicate guard,
 * payments, journals, contras, reversal-only corrections, and period locking.
 *
 * The fixture companies are in Karnataka (state 29).
 */
describe('purchases and corrections', () => {
  let owner: Pool;
  let fx: Fixture;
  let supplier: string;

  const postings = (orgId: string, voucherId: string) =>
    withTenant({ orgId, userId: null }, (tx) => voucherPostings(tx, voucherId));

  const netOf = async (orgId: string, voucherId: string, code: string) => {
    const entries = await postings(orgId, voucherId);
    return entries
      .filter((e) => e.accountCode === code)
      .reduce((acc, e) => acc + e.debitPaise - e.creditPaise, 0n);
  };

  /** Enters and posts a purchase bill the way the server action does. */
  const bill = (
    orgId: string,
    input: {
      supplierInvoiceNo: string;
      date?: string;
      fyLabel?: string;
      rupees?: bigint;
      rateBps?: number;
      reverseCharge?: boolean;
      post?: boolean;
    },
  ) =>
    withTenant({ orgId, userId: null }, async (tx) => {
      const supplyType = determineSupplyType({
        supplierStateCode: '29',
        placeOfSupplyStateCode: '29',
      });
      const lines = [
        {
          itemId: null,
          description: 'Goods purchased',
          hsnSac: '1006',
          unit: 'NOS',
          quantity: QTY_SCALE,
          unitPricePaise: (input.rupees ?? 10_000n) * 100n,
          discountPaise: 0n,
          gstRateBps: input.rateBps ?? 1800,
          cessRateBps: 0,
          reverseCharge: input.reverseCharge ?? false,
        },
      ];
      const calculation = calculateInvoice(lines, supplyType);
      const fyLabel = input.fyLabel ?? '25-26';
      const voucherDate = input.date ?? '2025-07-10';
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'purchase',
        fyLabel,
        prefix: 'BILL',
      });
      const created = await createVoucher(tx, {
        voucherType: 'purchase',
        voucherNo,
        fyLabel,
        voucherDate,
        partyId: supplier,
        supplierStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType,
        reference: input.supplierInvoiceNo,
        supplierInvoiceNo: input.supplierInvoiceNo,
        supplierInvoiceDate: voucherDate,
        narration: null,
        calculation,
        lines,
        entries: purchaseBillEntries(calculation),
      });
      if (input.post !== false) await postVoucher(tx, { voucherId: created.id, userId: null });
      return { ...created, calculation };
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `pc${Date.now()}`);
    supplier = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, name, state_code, place_of_supply_state_code)
        values (app_current_org_id(), 'supplier', 'Sunrise Traders', '29', '29')
        returning id
      `);
      return rows[0]!.id;
    });
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  describe('purchase bills', () => {
    it('posts a bill with input tax as an asset', async () => {
      const b = await bill(fx.orgA, { supplierInvoiceNo: 'SUN/001' });
      expect(await netOf(fx.orgA, b.id, 'PURCHASES')).toBe(10_000_00n);
      expect(await netOf(fx.orgA, b.id, 'INPUT_CGST')).toBe(900_00n);
      expect(await netOf(fx.orgA, b.id, 'INPUT_SGST')).toBe(900_00n);
      expect(await netOf(fx.orgA, b.id, 'SUNDRY_CREDITORS')).toBe(-11_800_00n);
    });

    it('refuses the same supplier reference twice in a financial year', async () => {
      await bill(fx.orgA, { supplierInvoiceNo: 'SUN/DUP' });
      await expectDbRejection(
        bill(fx.orgA, { supplierInvoiceNo: 'SUN/DUP', date: '2025-08-01' }),
        /vouchers_supplier_ref_key|duplicate key/i,
      );
    });

    it('catches a duplicate entered in a different case', async () => {
      await bill(fx.orgA, { supplierInvoiceNo: 'SUN/CASE' });
      await expectDbRejection(
        bill(fx.orgA, { supplierInvoiceNo: 'sun/case', date: '2025-08-02' }),
        /duplicate key/i,
      );
    });

    it('allows the same reference in the next financial year', async () => {
      // Suppliers restart their numbering every April, so the same number a
      // year later is a different bill.
      await bill(fx.orgA, { supplierInvoiceNo: 'SUN/YEARLY' });
      const next = await bill(fx.orgA, {
        supplierInvoiceNo: 'SUN/YEARLY',
        date: '2026-07-10',
        fyLabel: '26-27',
      });
      expect(next.id).toBeDefined();
    });

    it('names the clashing bill rather than surfacing a constraint', async () => {
      const first = await bill(fx.orgA, { supplierInvoiceNo: 'SUN/NAMED' });
      const found = await withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
        findDuplicateBill(tx, {
          partyId: supplier,
          supplierInvoiceNo: 'sun/named',
          fyLabel: '25-26',
        }),
      );
      expect(found?.voucherNo).toBe(first.voucherNo);
      expect(found?.totalPaise).toBe(first.totalPaise);
    });

    it('does not treat a draft as a duplicate', async () => {
      // A draft has not been entered into the books, so it must not block the
      // real entry of the same bill.
      await bill(fx.orgA, { supplierInvoiceNo: 'SUN/DRAFT', post: false });
      const posted = await bill(fx.orgA, {
        supplierInvoiceNo: 'SUN/DRAFT',
        date: '2025-08-03',
      });
      expect(posted.id).toBeDefined();
    });

    it("lets another company use the same supplier's reference", async () => {
      await bill(fx.orgA, { supplierInvoiceNo: 'SHARED/001' });
      const otherSupplier = await withTenant({ orgId: fx.orgB, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, name, state_code)
          values (app_current_org_id(), 'supplier', 'Sunrise Traders', '29')
          returning id
        `);
        return rows[0]!.id;
      });
      expect(otherSupplier).toBeDefined();
      // The index is scoped by org_id, so org B is unaffected by org A's entry.
      const clash = await withTenant({ orgId: fx.orgB, userId: null }, (tx) =>
        findDuplicateBill(tx, {
          partyId: otherSupplier,
          supplierInvoiceNo: 'SHARED/001',
          fyLabel: '25-26',
        }),
      );
      expect(clash).toBeNull();
    });
  });

  describe('reverse charge', () => {
    it('leaves the bill untaxed and raises the liability separately', async () => {
      const b = await bill(fx.orgA, {
        supplierInvoiceNo: 'SUN/RCM',
        rupees: 1_00_000n,
        reverseCharge: true,
      });

      // The bill shows what the supplier's document shows: no tax.
      expect(await netOf(fx.orgA, b.id, 'INPUT_CGST')).toBe(0n);
      expect(await netOf(fx.orgA, b.id, 'SUNDRY_CREDITORS')).toBe(-1_00_000_00n);

      // The liability is its own voucher, and nets to nothing overall.
      const rc = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const asIfTaxed = calculateInvoice(
          [
            {
              quantity: QTY_SCALE,
              unitPricePaise: 1_00_000_00n,
              gstRateBps: 1800,
            },
          ],
          'intra_state',
        );
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'journal',
          fyLabel: '25-26',
          prefix: 'RCM',
        });
        const created = await createVoucher(tx, {
          voucherType: 'journal',
          voucherNo,
          fyLabel: '25-26',
          voucherDate: '2025-07-10',
          partyId: supplier,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: b.voucherNo,
          narration: `Reverse charge on ${b.voucherNo}`,
          calculation: null,
          lines: [],
          entries: reverseChargeLiabilityEntries({
            cgstPaise: asIfTaxed.cgstPaise,
            sgstPaise: asIfTaxed.sgstPaise,
            igstPaise: asIfTaxed.igstPaise,
          }),
          totalPaise: asIfTaxed.totalTaxPaise,
        });
        await postVoucher(tx, { voucherId: created.id, userId: null });
        return created;
      });

      expect(await netOf(fx.orgA, rc.id, 'INPUT_CGST')).toBe(9_000_00n);
      expect(await netOf(fx.orgA, rc.id, 'OUTPUT_CGST')).toBe(-9_000_00n);
    });
  });

  describe('payments', () => {
    it('clears the creditor and credits the bank', async () => {
      const paid = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'payment',
          fyLabel: '25-26',
          prefix: 'PMT',
        });
        const created = await createVoucher(tx, {
          voucherType: 'payment',
          voucherNo,
          fyLabel: '25-26',
          voucherDate: '2025-07-20',
          partyId: supplier,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: 'UTR12345',
          narration: null,
          calculation: null,
          lines: [],
          entries: paymentEntries({ amountPaise: 11_800_00n, fromAccountCode: 'BANK' }),
          totalPaise: 11_800_00n,
        });
        await postVoucher(tx, { voucherId: created.id, userId: null });
        return created;
      });

      expect(await netOf(fx.orgA, paid.id, 'SUNDRY_CREDITORS')).toBe(11_800_00n);
      expect(await netOf(fx.orgA, paid.id, 'BANK')).toBe(-11_800_00n);
    });
  });

  describe('contras', () => {
    const contra = (from: string, to: string) =>
      withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'contra',
          fyLabel: '25-26',
          prefix: 'CTR',
        });
        const created = await createVoucher(tx, {
          voucherType: 'contra',
          voucherNo,
          fyLabel: '25-26',
          voucherDate: '2025-07-21',
          partyId: null,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: null,
          narration: 'Cash drawn from bank',
          calculation: null,
          lines: [],
          entries: contraEntries({
            fromAccountCode: from,
            toAccountCode: to,
            amountPaise: 25_000_00n,
          }),
          totalPaise: 25_000_00n,
        });
        await postVoucher(tx, { voucherId: created.id, userId: null });
        return created;
      });

    it('moves money between bank and cash', async () => {
      const c = await contra('BANK', 'CASH');
      expect(await netOf(fx.orgA, c.id, 'CASH')).toBe(25_000_00n);
      expect(await netOf(fx.orgA, c.id, 'BANK')).toBe(-25_000_00n);
    });

    // A contra touching a revenue account would be a disguised sale, so the
    // database refuses it rather than trusting the form to.
    it('refuses to touch an account that is not cash or bank', async () => {
      await expectDbRejection(
        contra('SALES', 'CASH'),
        /moves money between cash and bank only/i,
      );
    });
  });

  describe('journals', () => {
    it('posts a multi-line entry that balances in aggregate', async () => {
      const jv = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'journal',
          fyLabel: '25-26',
          prefix: 'JV',
        });
        const created = await createVoucher(tx, {
          voucherType: 'journal',
          voucherNo,
          fyLabel: '25-26',
          voucherDate: '2025-07-22',
          partyId: null,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: null,
          narration: 'Salary for July, net of TDS',
          calculation: null,
          lines: [],
          entries: journalEntries([
            { accountCode: 'SALARIES', debitPaise: 1_00_000_00n, creditPaise: 0n },
            { accountCode: 'TDS_PAYABLE', debitPaise: 0n, creditPaise: 10_000_00n },
            { accountCode: 'BANK', debitPaise: 0n, creditPaise: 90_000_00n },
          ]),
          totalPaise: 1_00_000_00n,
        });
        await postVoucher(tx, { voucherId: created.id, userId: null });
        return created;
      });

      expect(await netOf(fx.orgA, jv.id, 'SALARIES')).toBe(1_00_000_00n);
      expect(await netOf(fx.orgA, jv.id, 'TDS_PAYABLE')).toBe(-10_000_00n);
      expect(await netOf(fx.orgA, jv.id, 'BANK')).toBe(-90_000_00n);
    });
  });

  describe('reversal, the only correction', () => {
    const reverse = (voucherId: string, date = '2025-09-01') =>
      withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const original = await tx.execute<{ voucher_type: string; voucher_no: string; total_paise: string }>(
          sql`select voucher_type, voucher_no, total_paise::text from vouchers where id = ${voucherId}::uuid`,
        );
        const row = original.rows[0]!;
        const entries = reverseEntries(await voucherPostings(tx, voucherId));
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: row.voucher_type as 'purchase',
          fyLabel: '25-26',
          prefix: 'REV',
        });
        const created = await createVoucher(tx, {
          voucherType: row.voucher_type as 'purchase',
          voucherNo,
          fyLabel: '25-26',
          voucherDate: date,
          partyId: supplier,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: row.voucher_no,
          narration: `Reversal of ${row.voucher_no}: entered in error`,
          calculation: null,
          lines: [],
          entries,
          totalPaise: BigInt(row.total_paise),
          reversesVoucherId: voucherId,
        });
        await postVoucher(tx, { voucherId: created.id, userId: null });
        await markReversed(tx, { originalVoucherId: voucherId, reversalVoucherId: created.id });
        return created;
      });

    it('cancels the original exactly, leaving both in the books', async () => {
      const original = await bill(fx.orgA, { supplierInvoiceNo: 'SUN/REV' });
      const reversal = await reverse(original.id);

      const both = [
        ...(await postings(fx.orgA, original.id)),
        ...(await postings(fx.orgA, reversal.id)),
      ];
      for (const code of new Set(both.map((e) => e.accountCode))) {
        const net = both
          .filter((e) => e.accountCode === code)
          .reduce((acc, e) => acc + e.debitPaise - e.creditPaise, 0n);
        expect(net, `${code} must net to zero`).toBe(0n);
      }

      // Both vouchers survive: the mistake is part of the record.
      const rows = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ n: string }>(sql`
          select count(*)::text as n from vouchers
           where id in (${original.id}::uuid, ${reversal.id}::uuid) and status = 'posted'
        `);
        return Number(rows[0]!.n);
      });
      expect(rows).toBe(2);
    });

    it('reverses the entries that were posted, not a recomputation of the amounts', async () => {
      // A journal has no GST calculation at all: its accounts exist only as
      // ledger entries. Reversing one correctly therefore proves the reversal
      // is built from the entries rather than re-derived from the voucher's
      // tax columns, which for a journal are all zero.
      const jv = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'journal',
          fyLabel: '25-26',
          prefix: 'JV',
        });
        const created = await createVoucher(tx, {
          voucherType: 'journal',
          voucherNo,
          fyLabel: '25-26',
          voucherDate: '2025-07-25',
          partyId: null,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: null,
          narration: 'Rent for July',
          calculation: null,
          lines: [],
          entries: journalEntries([
            { accountCode: 'RENT', debitPaise: 50_000_00n, creditPaise: 0n },
            { accountCode: 'BANK', debitPaise: 0n, creditPaise: 50_000_00n },
          ]),
          totalPaise: 50_000_00n,
        });
        await postVoucher(tx, { voucherId: created.id, userId: null });
        return created;
      });

      // Every tax column on this voucher is zero, so a reversal derived from
      // them would post nothing at all.
      const header = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ taxable: string; total: string }>(sql`
          select taxable_paise::text as taxable, total_paise::text as total
            from vouchers where id = ${jv.id}::uuid
        `);
        return rows[0]!;
      });
      expect(header.taxable).toBe('0');

      const reversal = await reverse(jv.id, '2025-09-02');
      expect(await netOf(fx.orgA, reversal.id, 'RENT')).toBe(-50_000_00n);
      expect(await netOf(fx.orgA, reversal.id, 'BANK')).toBe(50_000_00n);
    });

    it('refuses a second reversal of the same voucher', async () => {
      const original = await bill(fx.orgA, { supplierInvoiceNo: 'SUN/TWICE' });
      await reverse(original.id, '2025-09-03');
      await expectDbRejection(
        reverse(original.id, '2025-09-04'),
        /vouchers_one_reversal_key|duplicate key/i,
      );
    });

    it('records the reversal on the original', async () => {
      const original = await bill(fx.orgA, { supplierInvoiceNo: 'SUN/LINK' });
      const reversal = await reverse(original.id, '2025-09-05');
      const row = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ reversed_by: string | null }>(sql`
          select reversed_by_voucher_id as reversed_by from vouchers where id = ${original.id}::uuid
        `);
        return rows[0];
      });
      expect(row?.reversed_by).toBe(reversal.id);
    });

    it('refuses a voucher that reverses itself', async () => {
      const original = await bill(fx.orgA, { supplierInvoiceNo: 'SUN/SELF' });
      await expectDbRejection(
        withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
          tx.execute(sql`
            update vouchers set reverses_voucher_id = id where id = ${original.id}::uuid
          `),
        ),
        // Immutability refuses the write before the self-reversal check is
        // reached; either refusal is correct, and both are the point.
        /posted and cannot be edited|vouchers_no_self_reversal/i,
      );
    });
  });

  describe('period locking', () => {
    afterAll(async () => {
      await owner.query('delete from period_locks where org_id = $1', [fx.orgA]);
    });

    it('reports nothing locked to begin with', async () => {
      const upto = await withTenant({ orgId: fx.orgA, userId: null }, (tx) => lockedUpto(tx));
      expect(upto).toBeNull();
    });

    it('refuses a posting dated inside a locked period', async () => {
      await owner.query(
        `insert into period_locks (org_id, locked_upto, reason) values ($1, date '2025-09-30', 'Q2 filed')
         on conflict (org_id) do update set locked_upto = excluded.locked_upto`,
        [fx.orgA],
      );

      await expectDbRejection(
        bill(fx.orgA, { supplierInvoiceNo: 'SUN/LOCKED', date: '2025-09-15' }),
        /books are locked to 2025-09-30/i,
      );
    });

    it('allows a posting dated after the lock', async () => {
      const b = await bill(fx.orgA, { supplierInvoiceNo: 'SUN/AFTER', date: '2025-10-01' });
      expect(b.id).toBeDefined();
    });

    it('allows a draft inside a locked period, since a draft is not in the books', async () => {
      const b = await bill(fx.orgA, {
        supplierInvoiceNo: 'SUN/LOCKEDDRAFT',
        date: '2025-09-20',
        post: false,
      });
      expect(b.id).toBeDefined();
    });

    it('reports the lock date so a form can say what is closed', async () => {
      const upto = await withTenant({ orgId: fx.orgA, userId: null }, (tx) => lockedUpto(tx));
      expect(upto).toBe('2025-09-30');
    });

    it("does not lock another company's books", async () => {
      const upto = await withTenant({ orgId: fx.orgB, userId: null }, (tx) => lockedUpto(tx));
      expect(upto).toBeNull();
    });
  });
});
