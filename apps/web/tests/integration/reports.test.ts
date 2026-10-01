import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import {
  allocatePayment,
  allocateReceipt,
  allocateVoucherNumber,
  createVoucher,
  postVoucher,
} from '../../src/lib/db/ledger';
import { calculateInvoice } from '../../src/lib/accounting/gst';
import {
  paymentEntries,
  purchaseBillEntries,
  receiptEntries,
  salesInvoiceEntries,
} from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import {
  getAccountLedger,
  getAgeing,
  getDayBook,
  getRegister,
  getTrialBalance,
} from '../../src/server/reports';
import { cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';
import type { RequestContext } from '../../src/lib/auth/context';

/**
 * The reports, against a small set of real postings.
 *
 * The assertion that matters most is that the trial balance balances. Every
 * other figure in the product is derived from the same entries, so if the two
 * sides of the ledger agree, the reports are reading a consistent book.
 */
describe('reports', () => {
  let owner: Pool;
  let fx: Fixture;
  let customer: string;
  let supplier: string;
  let ctx: RequestContext;
  let ctxB: RequestContext;

  const asContext = (orgId: string, userId: string): RequestContext =>
    ({
      orgId,
      userId,
      role: 'owner',
      clerkUserId: 'test',
      ip: null,
      userAgent: null,
    }) as unknown as RequestContext;

  const invoice = (input: { date: string; rupees: bigint; rateBps?: number; pos?: string }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const pos = input.pos ?? '29';
      const supplyType = pos === '29' ? 'intra_state' : 'inter_state';
      const lines = [
        {
          itemId: null,
          description: 'Goods sold',
          hsnSac: '1006',
          unit: 'NOS',
          quantity: QTY_SCALE,
          unitPricePaise: input.rupees * 100n,
          discountPaise: 0n,
          gstRateBps: input.rateBps ?? 1800,
          cessRateBps: 0,
          reverseCharge: false,
        },
      ];
      const calculation = calculateInvoice(lines, supplyType);
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'sales',
        fyLabel: '25-26',
        prefix: 'INV',
      });
      const created = await createVoucher(tx, {
        voucherType: 'sales',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: input.date,
        partyId: customer,
        supplierStateCode: '29',
        placeOfSupplyStateCode: pos,
        supplyType,
        reference: null,
        narration: null,
        calculation,
        lines,
        entries: salesInvoiceEntries(calculation),
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return { ...created, calculation };
    });

  const bill = (input: { date: string; rupees: bigint; ref: string }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const lines = [
        {
          itemId: null,
          description: 'Goods bought',
          hsnSac: '1006',
          unit: 'NOS',
          quantity: QTY_SCALE,
          unitPricePaise: input.rupees * 100n,
          discountPaise: 0n,
          gstRateBps: 1800,
          cessRateBps: 0,
          reverseCharge: false,
        },
      ];
      const calculation = calculateInvoice(lines, 'intra_state');
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'purchase',
        fyLabel: '25-26',
        prefix: 'BILL',
      });
      const created = await createVoucher(tx, {
        voucherType: 'purchase',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: input.date,
        partyId: supplier,
        supplierStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: 'intra_state',
        reference: input.ref,
        supplierInvoiceNo: input.ref,
        supplierInvoiceDate: input.date,
        narration: null,
        calculation,
        lines,
        entries: purchaseBillEntries(calculation),
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return created;
    });

  const settle = (
    kind: 'receipt' | 'payment',
    input: { date: string; amountPaise: bigint },
  ) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const isReceipt = kind === 'receipt';
      const partyId = isReceipt ? customer : supplier;
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: kind,
        fyLabel: '25-26',
        prefix: isReceipt ? 'RCT' : 'PMT',
      });
      const created = await createVoucher(tx, {
        voucherType: kind,
        voucherNo,
        fyLabel: '25-26',
        voucherDate: input.date,
        partyId,
        supplierStateCode: null,
        placeOfSupplyStateCode: null,
        supplyType: null,
        reference: null,
        narration: null,
        calculation: null,
        lines: [],
        entries: isReceipt
          ? receiptEntries({ amountPaise: input.amountPaise, intoAccountCode: 'BANK' })
          : paymentEntries({ amountPaise: input.amountPaise, fromAccountCode: 'BANK' }),
        totalPaise: input.amountPaise,
      });
      const allocate = isReceipt ? allocateReceipt : allocatePayment;
      await allocate(tx, {
        settlementVoucherId: created.id,
        partyId,
        amountPaise: input.amountPaise,
        explicitTargets: [],
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return created;
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `rep${Date.now()}`);
    ctx = asContext(fx.orgA, fx.userA);
    ctxB = asContext(fx.orgB, fx.userB);

    [customer, supplier] = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const mk = async (kind: string, name: string, creditDays: number) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, name, state_code, place_of_supply_state_code, credit_days)
          values (app_current_org_id(), ${kind}, ${name}, '29', '29', ${creditDays})
          returning id
        `);
        return rows[0]!.id;
      };
      return [await mk('customer', 'Anand Enterprises', 30), await mk('supplier', 'Sunrise', 15)];
    });

    // ₹1,00,000 + 18% on 1 May, ₹50,000 + 18% on 1 June, a ₹59,000 receipt in
    // July, a ₹20,000 bill, and a ₹10,000 payment.
    await invoice({ date: '2025-05-01', rupees: 1_00_000n });
    await invoice({ date: '2025-06-01', rupees: 50_000n });
    await invoice({ date: '2025-06-15', rupees: 10_000n, pos: '27' });
    await settle('receipt', { date: '2025-07-01', amountPaise: 59_000_00n });
    await bill({ date: '2025-05-10', rupees: 20_000n, ref: 'SUN/1' });
    await settle('payment', { date: '2025-07-02', amountPaise: 10_000_00n });
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  describe('trial balance', () => {
    it('balances exactly', async () => {
      const tb = await getTrialBalance(ctx, '2025-12-31');
      expect(tb.differencePaise).toBe(0n);
      expect(tb.totalDebitPaise).toBe(tb.totalCreditPaise);
      expect(tb.totalDebitPaise).toBeGreaterThan(0n);
    });

    it('balances at every date through the period', async () => {
      // Double entry is not a property of the end state; it holds after every
      // single voucher. A date on which it failed would name the voucher.
      for (const asOf of [
        '2025-04-30', '2025-05-01', '2025-05-10', '2025-06-01',
        '2025-06-15', '2025-07-01', '2025-07-02', '2026-03-31',
      ]) {
        const tb = await getTrialBalance(ctx, asOf);
        expect(tb.differencePaise, `unbalanced as at ${asOf}`).toBe(0n);
      }
    });

    it('shows the figures the postings imply', async () => {
      const tb = await getTrialBalance(ctx, '2025-12-31');
      const net = (code: string) => tb.rows.find((r) => r.code === code)?.netPaise ?? 0n;

      // Sales ₹1,60,000 credited; output tax on the two intra-state invoices.
      expect(net('SALES')).toBe(-1_60_000_00n);
      expect(net('OUTPUT_CGST')).toBe(-13_500_00n); // 9% of 1,50,000
      expect(net('OUTPUT_SGST')).toBe(-13_500_00n);
      expect(net('OUTPUT_IGST')).toBe(-1_800_00n); // 18% of 10,000
      expect(net('PURCHASES')).toBe(20_000_00n);
      // Debtors: 1,18,000 + 59,000 + 11,800 invoiced, 59,000 received.
      expect(net('SUNDRY_DEBTORS')).toBe(1_29_800_00n);
      // Creditors: 23,600 billed, 10,000 paid.
      expect(net('SUNDRY_CREDITORS')).toBe(-13_600_00n);
      expect(net('BANK')).toBe(49_000_00n); // 59,000 in, 10,000 out
    });

    it('lists accounts with no movement, rather than hiding an empty chart', async () => {
      const tb = await getTrialBalance(ctx, '2025-12-31');
      const untouched = tb.rows.find((r) => r.code === 'STOCK_IN_HAND');
      expect(untouched).toBeDefined();
      expect(untouched?.netPaise).toBe(0n);
    });

    it('is empty for a company with no postings', async () => {
      const tb = await getTrialBalance(ctxB, '2025-12-31');
      expect(tb.totalDebitPaise).toBe(0n);
      expect(tb.differencePaise).toBe(0n);
    });

    it('excludes draft vouchers', async () => {
      const before = await getTrialBalance(ctx, '2025-12-31');
      await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
        const voucherNo = await allocateVoucherNumber(tx, {
          voucherType: 'journal',
          fyLabel: '25-26',
          prefix: 'JV',
        });
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into vouchers (org_id, voucher_type, voucher_no, fy_label, voucher_date, status)
          values (app_current_org_id(), 'journal', ${voucherNo}, '25-26', '2025-08-01', 'draft')
          returning id
        `);
        const accounts = await tx.execute<{ id: string; code: string }>(sql`
          select id, code from accounts where code in ('CASH', 'BANK')
        `);
        const cash = accounts.rows.find((a) => a.code === 'CASH')!;
        const bank = accounts.rows.find((a) => a.code === 'BANK')!;
        for (const [account, column] of [[cash, 'debit_paise'], [bank, 'credit_paise']] as const) {
          await tx.execute(sql`
            insert into ledger_entries (org_id, voucher_id, account_id, entry_date, ${sql.raw(column)})
            values (app_current_org_id(), ${rows[0]!.id}::uuid, ${account.id}::uuid,
                    '2025-08-01', 500000)
          `);
        }
      });

      const after = await getTrialBalance(ctx, '2025-12-31');
      expect(after.totalDebitPaise).toBe(before.totalDebitPaise);
    });
  });

  describe('account ledger', () => {
    it('opens, moves and closes consistently', async () => {
      const debtors = (await getTrialBalance(ctx, '2025-12-31')).rows.find(
        (r) => r.code === 'SUNDRY_DEBTORS',
      )!;
      const ledger = await getAccountLedger(ctx, {
        accountId: debtors.accountId,
        from: '2025-06-01',
        to: '2025-12-31',
      });

      // Opening is everything before 1 June: the May invoice.
      expect(ledger.openingPaise).toBe(1_18_000_00n);
      expect(ledger.closingPaise).toBe(1_29_800_00n);
      // And the closing follows arithmetically from what it reports.
      expect(ledger.openingPaise + ledger.debitPaise - ledger.creditPaise).toBe(
        ledger.closingPaise,
      );
    });

    it('carries a running balance that ends at the closing figure', async () => {
      const debtors = (await getTrialBalance(ctx, '2025-12-31')).rows.find(
        (r) => r.code === 'SUNDRY_DEBTORS',
      )!;
      const ledger = await getAccountLedger(ctx, {
        accountId: debtors.accountId,
        from: '2025-04-01',
        to: '2026-03-31',
      });
      expect(ledger.openingPaise).toBe(0n);
      expect(ledger.entries.at(-1)?.runningPaise).toBe(ledger.closingPaise);
    });

    it('refuses an account from another company', async () => {
      const debtors = (await getTrialBalance(ctx, '2025-12-31')).rows.find(
        (r) => r.code === 'SUNDRY_DEBTORS',
      )!;
      await expect(
        getAccountLedger(ctxB, {
          accountId: debtors.accountId,
          from: '2025-04-01',
          to: '2026-03-31',
        }),
      ).rejects.toThrow(/does not exist in this company/i);
    });
  });

  describe('day book', () => {
    it('lists each posted voucher once, with its entries', async () => {
      const book = await getDayBook(ctx, { from: '2025-04-01', to: '2026-03-31' });
      expect(book.length).toBe(6);
      const numbers = book.map((v) => v.voucherNo);
      expect(new Set(numbers).size).toBe(numbers.length);
      for (const voucher of book) {
        expect(voucher.lines.length).toBeGreaterThanOrEqual(2);
        const debit = voucher.lines.reduce((a, l) => a + l.debitPaise, 0n);
        const credit = voucher.lines.reduce((a, l) => a + l.creditPaise, 0n);
        expect(debit, `${voucher.voucherNo} must balance`).toBe(credit);
      }
    });

    it('respects the date window', async () => {
      const book = await getDayBook(ctx, { from: '2025-05-01', to: '2025-05-31' });
      expect(book.map((v) => v.voucherDate).every((d) => d >= '2025-05-01' && d <= '2025-05-31')).toBe(true);
      expect(book.length).toBe(2); // one invoice, one bill
    });

    it('shows nothing for another company', async () => {
      expect(await getDayBook(ctxB, { from: '2025-04-01', to: '2026-03-31' })).toEqual([]);
    });
  });

  describe('registers', () => {
    it('totals the sales register to the invoices posted', async () => {
      const register = await getRegister(ctx, {
        kind: 'sales',
        from: '2025-04-01',
        to: '2026-03-31',
      });
      expect(register.rows).toHaveLength(3);
      expect(register.taxablePaise).toBe(1_60_000_00n);
      expect(register.cgstPaise).toBe(13_500_00n);
      expect(register.igstPaise).toBe(1_800_00n);
      expect(register.totalPaise).toBe(1_88_800_00n);
    });

    it('agrees with the trial balance on turnover', async () => {
      // Two independent paths to the same number: the register sums the voucher
      // headers, the trial balance sums the ledger entries behind them.
      const register = await getRegister(ctx, {
        kind: 'sales',
        from: '2025-04-01',
        to: '2026-03-31',
      });
      const tb = await getTrialBalance(ctx, '2026-03-31');
      const sales = tb.rows.find((r) => r.code === 'SALES')!;
      expect(register.taxablePaise).toBe(-sales.netPaise);
    });

    it('totals the purchase register', async () => {
      const register = await getRegister(ctx, {
        kind: 'purchase',
        from: '2025-04-01',
        to: '2026-03-31',
      });
      expect(register.rows).toHaveLength(1);
      expect(register.taxablePaise).toBe(20_000_00n);
      expect(register.rows[0]?.supplierInvoiceNo).toBe('SUN/1');
    });

    it('carries a party GSTIN through, since a GST return needs it', async () => {
      const register = await getRegister(ctx, {
        kind: 'sales',
        from: '2025-04-01',
        to: '2026-03-31',
      });
      // The fixture's parties are unregistered, so this proves the column is
      // populated rather than silently dropped.
      expect(register.rows[0]).toHaveProperty('partyGstin');
    });
  });

  describe('ageing', () => {
    it('ages receivables net of what has been received', async () => {
      const ageing = await getAgeing(ctx, { kind: 'receivable', asOf: '2025-07-15' });
      // Invoiced 1,88,800, received 59,000 against the oldest first.
      expect(ageing.total.totalPaise).toBe(1_29_800_00n);
    });

    it('agrees with the debtors control account', async () => {
      const ageing = await getAgeing(ctx, { kind: 'receivable', asOf: '2026-03-31' });
      const tb = await getTrialBalance(ctx, '2026-03-31');
      const debtors = tb.rows.find((r) => r.code === 'SUNDRY_DEBTORS')!;
      // The ageing report and the control account must agree, or one of them is
      // lying about what customers owe.
      expect(ageing.total.totalPaise).toBe(debtors.netPaise);
    });

    it('agrees with the creditors control account', async () => {
      const ageing = await getAgeing(ctx, { kind: 'payable', asOf: '2026-03-31' });
      const tb = await getTrialBalance(ctx, '2026-03-31');
      const creditors = tb.rows.find((r) => r.code === 'SUNDRY_CREDITORS')!;
      expect(ageing.total.totalPaise).toBe(-creditors.netPaise);
    });

    it('buckets by the due date, allowing for credit terms', async () => {
      // The customer is on 30 days' credit, so each invoice falls due a month
      // after it is raised. As at 10 July 2025:
      //
      //   1 May invoice     ₹1,18,000, due 31 May, ₹59,000 left after the
      //                     receipt was applied oldest-first → 40 days over
      //   1 June invoice    ₹59,000, due 1 July → 9 days over
      //   15 June invoice   ₹11,800, due 15 July → not due yet
      const ageing = await getAgeing(ctx, { kind: 'receivable', asOf: '2025-07-10' });
      const party = ageing.parties.find((p) => p.partyName === 'Anand Enterprises')!;

      expect(party.byBucket['31-60']).toBe(59_000_00n);
      expect(party.byBucket['0-30']).toBe(59_000_00n);
      // Not yet due is its own bucket, not folded into 0-30: "owes nothing yet"
      // and "overdue by nine days" are different facts.
      expect(party.byBucket.current).toBe(11_800_00n);
      expect(party.byBucket['61-90']).toBe(0n);
      expect(party.byBucket['90+']).toBe(0n);

      // The buckets account for every rupee outstanding.
      expect(
        party.byBucket.current +
          party.byBucket['0-30'] +
          party.byBucket['31-60'] +
          party.byBucket['61-90'] +
          party.byBucket['90+'],
      ).toBe(party.totalPaise);
      expect(party.totalPaise).toBe(1_29_800_00n);

      // Overdue excludes what is not yet due.
      expect(party.overduePaise).toBe(1_18_000_00n);
      expect(party.oldestDueDate).toBe('2025-05-31');
    });

    it('drops a document once it is fully settled', async () => {
      const before = await getAgeing(ctx, { kind: 'payable', asOf: '2026-03-31' });
      expect(before.documents.length).toBe(1);

      // Pay the rest of the bill: 23,600 billed, 10,000 paid, 13,600 left.
      await settle('payment', { date: '2025-07-20', amountPaise: 13_600_00n });

      const after = await getAgeing(ctx, { kind: 'payable', asOf: '2026-03-31' });
      expect(after.documents).toEqual([]);
      expect(after.total.totalPaise).toBe(0n);
    });

    it('keeps the trial balance balanced after all of that', async () => {
      const tb = await getTrialBalance(ctx, '2026-03-31');
      expect(tb.differencePaise).toBe(0n);
    });

    it('shows nothing for another company', async () => {
      const ageing = await getAgeing(ctxB, { kind: 'receivable', asOf: '2026-03-31' });
      expect(ageing.parties).toEqual([]);
      expect(ageing.total.totalPaise).toBe(0n);
    });
  });
});
