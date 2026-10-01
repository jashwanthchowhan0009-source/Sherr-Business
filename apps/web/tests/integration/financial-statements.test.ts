import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import {
  allocateVoucherNumber,
  allocatePayment,
  allocateReceipt,
  createVoucher,
  postVoucher,
} from '../../src/lib/db/ledger';
import { calculateInvoice } from '../../src/lib/accounting/gst';
import {
  journalEntries,
  paymentEntries,
  purchaseBillEntries,
  receiptEntries,
  salesInvoiceEntries,
} from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import { getDashboard, getFinancialStatements, getTrialBalance } from '../../src/server/reports';
import { cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';
import type { RequestContext } from '../../src/lib/auth/context';

/**
 * The three statements against a real year of books.
 *
 * Three identities must hold, and each is checked here against figures that came
 * out of actual postings rather than a hand-built fixture:
 *
 *   profit = income − expenses
 *   assets = equity + liabilities (once the profit is carried into reserves)
 *   net cash flow = closing cash − opening cash
 *
 * The third can only hold if every account's movement was classified into
 * operating, investing or financing, so it doubles as a test of the mapping.
 */
describe('financial statements', () => {
  let owner: Pool;
  let fx: Fixture;
  let ctx: RequestContext;
  let customer: string;
  let supplier: string;

  const FY = { from: '2025-04-01', to: '2026-03-31' };

  const asContext = (orgId: string, userId: string): RequestContext =>
    ({ orgId, userId, role: 'owner', clerkUserId: 'test', ip: null, userAgent: null }) as unknown as RequestContext;

  const taxed = (rupees: bigint, rateBps = 1800) =>
    calculateInvoice(
      [
        {
          quantity: QTY_SCALE,
          unitPricePaise: rupees * 100n,
          gstRateBps: rateBps,
        },
      ],
      'intra_state',
    );

  const voucher = (input: {
    type: 'sales' | 'purchase' | 'receipt' | 'payment' | 'journal';
    date: string;
    prefix: string;
    partyId?: string | null;
    entries: Parameters<typeof createVoucher>[1]['entries'];
    totalPaise: bigint;
    calculation?: ReturnType<typeof calculateInvoice> | null;
    lines?: Parameters<typeof createVoucher>[1]['lines'];
    supplierInvoiceNo?: string;
    narration?: string;
  }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: input.type,
        fyLabel: '25-26',
        prefix: input.prefix,
      });
      const created = await createVoucher(tx, {
        voucherType: input.type,
        voucherNo,
        fyLabel: '25-26',
        voucherDate: input.date,
        partyId: input.partyId ?? null,
        supplierStateCode: input.calculation ? '29' : null,
        placeOfSupplyStateCode: input.calculation ? '29' : null,
        supplyType: input.calculation ? 'intra_state' : null,
        reference: null,
        ...(input.supplierInvoiceNo
          ? { supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceDate: input.date }
          : {}),
        narration: input.narration ?? null,
        calculation: input.calculation ?? null,
        lines: input.lines ?? [],
        entries: input.entries,
        totalPaise: input.totalPaise,
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return created;
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `fs${Date.now()}`);
    ctx = asContext(fx.orgA, fx.userA);

    [customer, supplier] = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const mk = async (kind: string, name: string) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, name, state_code, place_of_supply_state_code, credit_days)
          values (app_current_org_id(), ${kind}, ${name}, '29', '29', 30)
          returning id
        `);
        return rows[0]!.id;
      };
      return [await mk('customer', 'Anand Enterprises'), await mk('supplier', 'Sunrise Traders')];
    });

    // Capital introduced: ₹5,00,000 into the bank.
    await voucher({
      type: 'journal',
      date: '2025-04-01',
      prefix: 'JV',
      narration: 'Capital introduced',
      entries: journalEntries([
        { accountCode: 'BANK', debitPaise: 5_00_000_00n, creditPaise: 0n },
        { accountCode: 'CAPITAL_ACCOUNT', debitPaise: 0n, creditPaise: 5_00_000_00n },
      ]),
      totalPaise: 5_00_000_00n,
    });

    // A purchase of ₹2,00,000 + 18%.
    const bill = taxed(2_00_000n);
    const billLines = [
      {
        itemId: null,
        description: 'Stock bought',
        hsnSac: '1006',
        unit: 'NOS',
        quantity: QTY_SCALE,
        unitPricePaise: 2_00_000_00n,
        discountPaise: 0n,
        gstRateBps: 1800,
        cessRateBps: 0,
        reverseCharge: false,
      },
    ];
    const purchased = await voucher({
      type: 'purchase',
      date: '2025-05-10',
      prefix: 'BILL',
      partyId: supplier,
      calculation: bill,
      lines: billLines,
      entries: purchaseBillEntries(bill),
      totalPaise: bill.totalPaise,
      supplierInvoiceNo: 'SUN/FS/1',
    });

    // Sales of ₹4,00,000 + 18%.
    const invoice = taxed(4_00_000n);
    await voucher({
      type: 'sales',
      date: '2025-06-15',
      prefix: 'INV',
      partyId: customer,
      calculation: invoice,
      lines: [{ ...billLines[0]!, description: 'Stock sold', unitPricePaise: 4_00_000_00n }],
      entries: salesInvoiceEntries(invoice),
      totalPaise: invoice.totalPaise,
    });

    // A receipt of ₹3,00,000 and a payment of the bill in full.
    const receiptVoucher = await voucher({
      type: 'receipt',
      date: '2025-07-01',
      prefix: 'RCT',
      partyId: customer,
      entries: receiptEntries({ amountPaise: 3_00_000_00n, intoAccountCode: 'BANK' }),
      totalPaise: 3_00_000_00n,
    });
    const paymentVoucher = await voucher({
      type: 'payment',
      date: '2025-07-05',
      prefix: 'PMT',
      partyId: supplier,
      entries: paymentEntries({
        amountPaise: bill.totalPaise,
        fromAccountCode: 'BANK',
      }),
      totalPaise: bill.totalPaise,
    });
    await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      await allocateReceipt(tx, {
        settlementVoucherId: receiptVoucher.id,
        partyId: customer,
        amountPaise: 3_00_000_00n,
        explicitTargets: [],
      });
      await allocatePayment(tx, {
        settlementVoucherId: paymentVoucher.id,
        partyId: supplier,
        amountPaise: bill.totalPaise,
        explicitTargets: [],
      });
    });
    void purchased;

    // Salaries and rent, paid from the bank.
    for (const [account, rupees, date] of [
      ['SALARIES', 60_000n, '2025-08-01'],
      ['RENT', 24_000n, '2025-08-02'],
      ['BANK_CHARGES', 1_180n, '2025-08-03'],
    ] as const) {
      await voucher({
        type: 'journal',
        date,
        prefix: 'JV',
        narration: `${account} for the period`,
        entries: journalEntries([
          { accountCode: account, debitPaise: rupees * 100n, creditPaise: 0n },
          { accountCode: 'BANK', debitPaise: 0n, creditPaise: rupees * 100n },
        ]),
        totalPaise: rupees * 100n,
      });
    }

    // Cash drawn from the bank.
    await voucher({
      type: 'journal',
      date: '2025-09-01',
      prefix: 'JV',
      narration: 'Cash drawn',
      entries: journalEntries([
        { accountCode: 'CASH', debitPaise: 20_000_00n, creditPaise: 0n },
        { accountCode: 'BANK', debitPaise: 0n, creditPaise: 20_000_00n },
      ]),
      totalPaise: 20_000_00n,
    });
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  describe('before closing stock is entered', () => {
    it('says so, rather than presenting a figure that is wrong by the warehouse', async () => {
      const fs = await getFinancialStatements(ctx, FY);
      expect(fs.closingStockEntered).toBe(false);
      expect(fs.profitAndLoss.closingStockEntered).toBe(false);
    });

    it('still balances, because the books balance whatever is in them', async () => {
      const fs = await getFinancialStatements(ctx, FY);
      expect(fs.balanceSheet.differencePaise).toBe(0n);
      expect(fs.cashFlow.differencePaise).toBe(0n);
    });

    it('marks the dashboard profit as draft, not merely provisional', async () => {
      // Provisional means "this can change". Without closing stock the figure is
      // not just changeable, it is known to be understated by every rupee of
      // unsold stock — which is a different and stronger warning.
      const dashboard = await getDashboard(ctx, { from: FY.from, asOf: FY.to });
      const card = dashboard.metrics.find((m) => m.key === 'profit')!;
      expect(card.status).toBe('draft');
      expect(card.statusReason).toMatch(/Closing stock has not been entered/i);
      expect(card.caption).toMatch(/understated/i);
    });
  });

  describe('with closing stock entered', () => {
    beforeAll(async () => {
      // Half the stock remains: ₹1,00,000 of the ₹2,00,000 bought.
      await voucher({
        type: 'journal',
        date: '2026-03-31',
        prefix: 'STK',
        narration: 'Closing stock at cost',
        entries: journalEntries([
          { accountCode: 'STOCK_IN_HAND', debitPaise: 1_00_000_00n, creditPaise: 0n },
          { accountCode: 'INVENTORY_CHANGE', debitPaise: 0n, creditPaise: 1_00_000_00n },
        ]),
        totalPaise: 1_00_000_00n,
      });
    });

    it('reports it as entered', async () => {
      expect((await getFinancialStatements(ctx, FY)).closingStockEntered).toBe(true);
    });

    it('computes profit as income less expenses', async () => {
      const { profitAndLoss: pl } = await getFinancialStatements(ctx, FY);
      expect(pl.profitBeforeTaxPaise).toBe(pl.totalIncomePaise - pl.totalExpensePaise);
      // Sales 4,00,000. Expenses: purchases 2,00,000 + salaries 60,000 + rent
      // 24,000 + charges 1,180 − closing stock 1,00,000 = 1,85,180.
      expect(pl.totalIncomePaise).toBe(4_00_000_00n);
      expect(pl.totalExpensePaise).toBe(1_85_180_00n);
      expect(pl.profitBeforeTaxPaise).toBe(2_14_820_00n);
    });

    it('computes gross profit after stock', async () => {
      const { profitAndLoss: pl } = await getFinancialStatements(ctx, FY);
      // 4,00,000 − 2,00,000 + 1,00,000 = 3,00,000
      expect(pl.grossProfitPaise).toBe(3_00_000_00n);
    });

    it('balances the balance sheet exactly', async () => {
      const { balanceSheet: bs } = await getFinancialStatements(ctx, FY);
      expect(bs.differencePaise).toBe(0n);
      expect(bs.totalAssetsPaise).toBe(bs.totalEquityAndLiabilitiesPaise);
      expect(bs.totalAssetsPaise).toBeGreaterThan(0n);
    });

    it('classifies every account, leaving nothing unplaced', async () => {
      const { balanceSheet: bs } = await getFinancialStatements(ctx, FY);
      expect(bs.unclassified).toEqual([]);
    });

    it('ties the cash flow to the movement in cash', async () => {
      const { cashFlow: cf } = await getFinancialStatements(ctx, FY);
      expect(cf.differencePaise).toBe(0n);
      expect(cf.netChangePaise).toBe(cf.closingCashPaise - cf.openingCashPaise);
    });

    it('shows the cash the trial balance shows', async () => {
      const { cashFlow: cf } = await getFinancialStatements(ctx, FY);
      const tb = await getTrialBalance(ctx, FY.to);
      const cash = tb.rows
        .filter((r) => r.code === 'CASH' || r.code === 'BANK')
        .reduce((acc, r) => acc + r.netPaise, 0n);
      expect(cf.closingCashPaise).toBe(cash);
    });

    it('puts capital in financing and working capital in operating', async () => {
      const { cashFlow: cf } = await getFinancialStatements(ctx, FY);
      expect(cf.netFinancingPaise).toBe(5_00_000_00n);
      expect(cf.netInvestingPaise).toBe(0n);
      // Operating must make up the rest.
      expect(cf.netOperatingPaise + cf.netFinancingPaise).toBe(cf.netChangePaise);
    });

    it('agrees with the trial balance on every P&L total', async () => {
      // Two independent paths: the statement groups movements into Schedule III
      // lines, the trial balance sums the entries.
      const { profitAndLoss: pl } = await getFinancialStatements(ctx, FY);
      const tb = await getTrialBalance(ctx, FY.to);
      const income = tb.rows
        .filter((r) => r.nature === 'income')
        .reduce((acc, r) => acc - r.netPaise, 0n);
      const expense = tb.rows
        .filter((r) => r.nature === 'expense')
        .reduce((acc, r) => acc + r.netPaise, 0n);
      expect(pl.totalIncomePaise).toBe(income);
      expect(pl.totalExpensePaise).toBe(expense);
    });
  });

  describe('period movements, not cumulative balances', () => {
    it('reports only what moved inside the window', async () => {
      // Sales were raised in June, so a window ending in May shows none.
      const toMay = await getFinancialStatements(ctx, { from: '2025-04-01', to: '2025-05-31' });
      expect(toMay.profitAndLoss.totalIncomePaise).toBe(0n);

      const toJune = await getFinancialStatements(ctx, { from: '2025-04-01', to: '2025-06-30' });
      expect(toJune.profitAndLoss.totalIncomePaise).toBe(4_00_000_00n);
    });

    it('shows a later window excluding earlier movements', async () => {
      const laterOnly = await getFinancialStatements(ctx, { from: '2025-07-01', to: '2026-03-31' });
      // Sales were in June, so this window has no income.
      expect(laterOnly.profitAndLoss.totalIncomePaise).toBe(0n);

      // The balance sheet is as at the end of the window and must still
      // balance. It can only do so by carrying ACCUMULATED profit rather than
      // the window's: using the window's figure leaves it out by exactly the
      // profit earned before the window opened, which is how this was found.
      expect(laterOnly.balanceSheet.differencePaise).toBe(0n);

      const fullYear = await getFinancialStatements(ctx, FY);
      expect(laterOnly.balanceSheet.profitCarriedPaise).toBe(
        fullYear.profitAndLoss.profitBeforeTaxPaise,
      );
      expect(laterOnly.balanceSheet.profitCarriedPaise).not.toBe(
        laterOnly.profitAndLoss.profitBeforeTaxPaise,
      );
    });

    it('balances the sheet for every window, not only the financial year', async () => {
      for (const window of [
        { from: '2025-04-01', to: '2025-04-30' },
        { from: '2025-05-01', to: '2025-05-31' },
        { from: '2025-06-01', to: '2025-09-30' },
        { from: '2025-08-15', to: '2026-01-15' },
        { from: '2026-03-01', to: '2026-03-31' },
      ]) {
        const fs = await getFinancialStatements(ctx, window);
        expect(fs.balanceSheet.differencePaise, `${window.from} to ${window.to}`).toBe(0n);
        expect(fs.cashFlow.differencePaise, `${window.from} to ${window.to}`).toBe(0n);
      }
    });

    it('carries an opening cash balance into the cash flow', async () => {
      const laterOnly = await getFinancialStatements(ctx, { from: '2025-07-01', to: '2026-03-31' });
      expect(laterOnly.cashFlow.openingCashPaise).toBeGreaterThan(0n);
      expect(laterOnly.cashFlow.differencePaise).toBe(0n);
    });
  });

  describe('period closing', () => {
    it('reports the period as open until it is locked', async () => {
      const fs = await getFinancialStatements(ctx, FY);
      expect(fs.lockedUpto).toBeNull();
      expect(fs.periodClosed).toBe(false);
    });

    it('does not count a partial lock as closing the year', async () => {
      // A lock to 30 September does not close a year ending 31 March.
      await owner.query(
        `insert into period_locks (org_id, locked_upto, reason) values ($1, date '2025-09-30', 'Q2')
         on conflict (org_id) do update set locked_upto = excluded.locked_upto`,
        [fx.orgA],
      );
      const fs = await getFinancialStatements(ctx, FY);
      expect(fs.lockedUpto).toBe('2025-09-30');
      expect(fs.periodClosed).toBe(false);
    });

    it('reports the period as closed once the lock covers it', async () => {
      await owner.query(
        `update period_locks set locked_upto = date '2026-03-31' where org_id = $1`,
        [fx.orgA],
      );
      const fs = await getFinancialStatements(ctx, FY);
      expect(fs.periodClosed).toBe(true);
    });

    afterAll(async () => {
      await owner.query('delete from period_locks where org_id = $1', [fx.orgA]);
    });
  });

  describe('the dashboard profit card', () => {
    const profitCard = async () => {
      const dashboard = await getDashboard(ctx, { from: FY.from, asOf: FY.to });
      return dashboard.metrics.find((m) => m.key === 'profit')!;
    };

    afterAll(async () => {
      await owner.query('delete from period_locks where org_id = $1', [fx.orgA]);
    });

    it('is provisional while the period is open', async () => {
      await owner.query('delete from period_locks where org_id = $1', [fx.orgA]);
      const card = await profitCard();
      expect(card.status).toBe('provisional');
      expect(card.statusReason).toMatch(/period is still open/i);
      // The arithmetic is right; it is the figures behind it that can move.
      expect(card.statusReason).toMatch(/arithmetic is right/i);
    });

    it('becomes verified only once the books are locked past the period', async () => {
      await owner.query(
        `insert into period_locks (org_id, locked_upto, reason) values ($1, date '2026-03-31', 'Year closed')
         on conflict (org_id) do update set locked_upto = excluded.locked_upto`,
        [fx.orgA],
      );
      const card = await profitCard();
      expect(card.status).toBe('verified');
      expect(card.statusReason).toMatch(/locked to 2026-03-31/);
    });

    it('is not verified by a lock that only covers part of the period', async () => {
      await owner.query(
        `update period_locks set locked_upto = date '2025-09-30' where org_id = $1`,
        [fx.orgA],
      );
      expect((await profitCard()).status).toBe('provisional');
    });

    it('carries the figure the profit and loss reports', async () => {
      const card = await profitCard();
      const fs = await getFinancialStatements(ctx, FY);
      expect(card.valuePaise).toBe(fs.profitAndLoss.profitBeforeTaxPaise);
    });
  });

  describe('isolation', () => {
    it('shows another company nothing', async () => {
      const other = asContext(fx.orgB, fx.userB);
      const fs = await getFinancialStatements(other, FY);
      expect(fs.profitAndLoss.profitBeforeTaxPaise).toBe(0n);
      expect(fs.balanceSheet.totalAssetsPaise).toBe(0n);
      expect(fs.balanceSheet.differencePaise).toBe(0n);
    });
  });
});
