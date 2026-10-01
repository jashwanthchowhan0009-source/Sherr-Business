import { describe, expect, it } from 'vitest';
import {
  bsLineFor,
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  cashFlowActivityFor,
  plLineFor,
  type AccountBalance,
} from '../../src/lib/accounting/financial-statements';

const acc = (
  code: string,
  groupCode: string,
  nature: AccountBalance['nature'],
  netPaise: bigint,
): AccountBalance => ({ code, name: code, groupCode, nature, bucket: null, netPaise });

/**
 * A small but complete set of books, derived from actual transactions so that it
 * is a valid ledger rather than a plausible-looking list of numbers.
 *
 *   Capital introduced               ₹50,000  Dr Bank      Cr Capital
 *   Purchase ₹20,000 + 18% GST       ₹23,600  Dr Purchases, Dr Input CGST/SGST, Cr Creditors
 *   Sale ₹1,60,000 + 18% GST       ₹1,88,800  Dr Debtors, Cr Sales, Cr Output CGST/SGST
 *   Receipt                          ₹59,000  Dr Bank      Cr Debtors
 *   Payment, with ₹1,000 discount    ₹22,600  Dr Creditors Cr Bank, Cr Discount received
 *   Salaries                         ₹30,000  Dr Salaries  Cr Bank
 *   Rent                             ₹12,000  Dr Rent      Cr Bank
 *   Bank charges                        ₹500  Dr Charges   Cr Bank
 *   Cash drawn from bank              ₹5,000  Dr Cash      Cr Bank
 *   Closing stock                     ₹5,000  Dr Stock     Cr Changes in inventories
 *
 * Total debits and total credits are each ₹2,44,800, so every identity the
 * builders assert has a chance of holding. Had the fixture not balanced, the
 * balance sheet would have been right to refuse to.
 */
const BOOKS: AccountBalance[] = [
  // Income: credit balances, so negative.
  acc('SALES', 'SALES', 'income', -1_60_000_00n),
  acc('DISCOUNT_RECEIVED', 'INDIRECT_INCOME', 'income', -1_000_00n),
  // Expenses: debit balances.
  acc('PURCHASES', 'PURCHASES', 'expense', 20_000_00n),
  acc('SALARIES', 'INDIRECT_EXPENSES', 'expense', 30_000_00n),
  acc('BANK_CHARGES', 'INDIRECT_EXPENSES', 'expense', 500_00n),
  acc('RENT', 'INDIRECT_EXPENSES', 'expense', 12_000_00n),
  // Closing stock credited: it reduces the period's cost.
  acc('INVENTORY_CHANGE', 'INVENTORY_CHANGE', 'expense', -5_000_00n),
  // Assets.
  acc('SUNDRY_DEBTORS', 'SUNDRY_DEBTORS', 'asset', 1_29_800_00n),
  acc('BANK', 'BANK_ACCOUNTS', 'asset', 38_900_00n),
  acc('CASH', 'CASH_IN_HAND', 'asset', 5_000_00n),
  acc('STOCK_IN_HAND', 'STOCK_IN_HAND', 'asset', 5_000_00n),
  acc('INPUT_CGST', 'LOANS_AND_ADVANCES', 'asset', 1_800_00n),
  acc('INPUT_SGST', 'LOANS_AND_ADVANCES', 'asset', 1_800_00n),
  // Liabilities and equity.
  acc('OUTPUT_CGST', 'DUTIES_AND_TAXES', 'liability', -14_400_00n),
  acc('OUTPUT_SGST', 'DUTIES_AND_TAXES', 'liability', -14_400_00n),
  acc('CAPITAL_ACCOUNT', 'CAPITAL', 'equity', -50_000_00n),
];

/** The fixture is only useful if it is a real ledger. */
describe('the fixture itself', () => {
  it('balances, as a set of books must', () => {
    expect(BOOKS.reduce((acc, a) => acc + a.netPaise, 0n)).toBe(0n);
  });
});

describe('plLineFor', () => {
  it('puts sales on revenue from operations and everything else on other income', () => {
    expect(plLineFor(acc('SALES', 'SALES', 'income', 0n))).toBe('revenue_from_operations');
    expect(plLineFor(acc('X', 'INDIRECT_INCOME', 'income', 0n))).toBe('other_income');
  });

  it('gives changes in inventories its own line, as Schedule III does', () => {
    expect(plLineFor(acc('INVENTORY_CHANGE', 'INVENTORY_CHANGE', 'expense', 0n))).toBe(
      'changes_in_inventories',
    );
  });

  it('recognises the named Schedule III expense lines', () => {
    expect(plLineFor(acc('SALARIES', 'INDIRECT_EXPENSES', 'expense', 0n))).toBe('employee_benefits');
    expect(plLineFor(acc('BANK_CHARGES', 'INDIRECT_EXPENSES', 'expense', 0n))).toBe('finance_costs');
    expect(plLineFor(acc('PURCHASES', 'PURCHASES', 'expense', 0n))).toBe('cost_of_materials');
  });

  it('puts an unrecognised expense in Other expenses rather than dropping it', () => {
    // A figure that disappears is worse than one on the wrong line, because the
    // totals would stop tying to the ledger.
    expect(plLineFor(acc('MYSTERY', 'SOMETHING_NEW', 'expense', 0n))).toBe('other_expenses');
  });

  it('places no balance-sheet account on the profit and loss', () => {
    expect(plLineFor(acc('BANK', 'BANK_ACCOUNTS', 'asset', 0n))).toBeNull();
    expect(plLineFor(acc('CAPITAL_ACCOUNT', 'CAPITAL', 'equity', 0n))).toBeNull();
  });
});

describe('buildProfitAndLoss', () => {
  const pl = buildProfitAndLoss({
    from: '2025-04-01',
    to: '2026-03-31',
    movements: BOOKS,
    closingStockEntered: true,
  });

  it('shows income as a positive figure', () => {
    const revenue = pl.income.find((s) => s.line === 'revenue_from_operations')!;
    expect(revenue.amountPaise).toBe(1_60_000_00n);
  });

  it('totals income and expenses', () => {
    expect(pl.totalIncomePaise).toBe(1_61_000_00n);
    // 20,000 + 30,000 + 500 + 12,000 − 5,000 = 57,500
    expect(pl.totalExpensePaise).toBe(57_500_00n);
  });

  it('computes profit as income less expenses', () => {
    expect(pl.profitBeforeTaxPaise).toBe(pl.totalIncomePaise - pl.totalExpensePaise);
    expect(pl.profitBeforeTaxPaise).toBe(1_03_500_00n);
  });

  it('computes gross profit after purchases and the inventory change', () => {
    // 1,60,000 − 20,000 − (−5,000) = 1,45,000
    expect(pl.grossProfitPaise).toBe(1_45_000_00n);
  });

  it('shows closing stock as a credit to changes in inventories', () => {
    const line = pl.expenses.find((s) => s.line === 'changes_in_inventories')!;
    expect(line.amountPaise).toBe(-5_000_00n);
  });

  it('lists the accounts behind each line', () => {
    const other = pl.expenses.find((s) => s.line === 'other_expenses')!;
    expect(other.accounts.map((a) => a.code)).toEqual(['RENT']);
  });

  it('orders the lines as Schedule III does', () => {
    expect(pl.expenses.map((s) => s.line)).toEqual([
      'cost_of_materials',
      'changes_in_inventories',
      'employee_benefits',
      'finance_costs',
      'other_expenses',
    ]);
  });

  it('omits a line with no movement rather than showing a zero', () => {
    expect(pl.expenses.some((s) => s.line === 'depreciation')).toBe(false);
  });

  it('is empty, and profit zero, for a company that has not traded', () => {
    const empty = buildProfitAndLoss({
      from: '2025-04-01',
      to: '2026-03-31',
      movements: [],
      closingStockEntered: false,
    });
    expect(empty.profitBeforeTaxPaise).toBe(0n);
    expect(empty.income).toEqual([]);
  });

  it('reports whether closing stock has been entered', () => {
    expect(pl.closingStockEntered).toBe(true);
    expect(
      buildProfitAndLoss({ from: 'a', to: 'b', movements: BOOKS, closingStockEntered: false })
        .closingStockEntered,
    ).toBe(false);
  });
});

describe('bsLineFor', () => {
  it('maps the chart onto Schedule III', () => {
    expect(bsLineFor(acc('x', 'CAPITAL', 'equity', 0n))).toBe('share_capital');
    expect(bsLineFor(acc('x', 'SUNDRY_CREDITORS', 'liability', 0n))).toBe('trade_payables');
    expect(bsLineFor(acc('x', 'DUTIES_AND_TAXES', 'liability', 0n))).toBe('other_current_liabilities');
    expect(bsLineFor(acc('x', 'SUNDRY_DEBTORS', 'asset', 0n))).toBe('trade_receivables');
    expect(bsLineFor(acc('x', 'BANK_ACCOUNTS', 'asset', 0n))).toBe('cash_and_equivalents');
    expect(bsLineFor(acc('x', 'CASH_IN_HAND', 'asset', 0n))).toBe('cash_and_equivalents');
    expect(bsLineFor(acc('x', 'STOCK_IN_HAND', 'asset', 0n))).toBe('inventories');
    expect(bsLineFor(acc('x', 'FIXED_ASSETS', 'asset', 0n))).toBe('fixed_assets');
    expect(bsLineFor(acc('x', 'LOANS_SECURED', 'liability', 0n))).toBe('long_term_borrowings');
  });

  it('returns null for a group it does not recognise', () => {
    expect(bsLineFor(acc('x', 'SOMETHING_NEW', 'asset', 0n))).toBeNull();
  });
});

describe('buildBalanceSheet', () => {
  const pl = buildProfitAndLoss({
    from: '2025-04-01',
    to: '2026-03-31',
    movements: BOOKS,
    closingStockEntered: true,
  });
  const bs = buildBalanceSheet({
    asOf: '2026-03-31',
    balances: BOOKS,
    profitPaise: pl.profitBeforeTaxPaise,
  });

  it('balances exactly', () => {
    // It must: assets = liabilities + equity + (income − expenses) is the same
    // statement as "every voucher balanced".
    expect(bs.differencePaise).toBe(0n);
    expect(bs.totalAssetsPaise).toBe(bs.totalEquityAndLiabilitiesPaise);
  });

  it('shows liabilities and equity as positive figures', () => {
    const taxes = bs.equityAndLiabilities.find((s) => s.line === 'other_current_liabilities')!;
    expect(taxes.amountPaise).toBe(28_800_00n);
    const capital = bs.equityAndLiabilities.find((s) => s.line === 'share_capital')!;
    expect(capital.amountPaise).toBe(50_000_00n);
  });

  it('carries the period profit into reserves', () => {
    const reserves = bs.equityAndLiabilities.find((s) => s.line === 'reserves_and_surplus')!;
    expect(reserves.amountPaise).toBe(pl.profitBeforeTaxPaise);
    expect(reserves.accounts.some((a) => a.code === 'PROFIT_FOR_PERIOD')).toBe(true);
  });

  it('does not balance without the profit, which is why it is carried', () => {
    const without = buildBalanceSheet({
      asOf: '2026-03-31',
      balances: BOOKS,
      profitPaise: 0n,
    });
    expect(without.differencePaise).not.toBe(0n);
    expect(without.differencePaise).toBe(pl.profitBeforeTaxPaise);
  });

  it('combines cash and bank into one line', () => {
    const cash = bs.assets.find((s) => s.line === 'cash_and_equivalents')!;
    expect(cash.amountPaise).toBe(43_900_00n);
    expect(cash.accounts.map((a) => a.code).sort()).toEqual(['BANK', 'CASH']);
  });

  it('keeps income and expense accounts off the balance sheet', () => {
    const codes = [...bs.assets, ...bs.equityAndLiabilities]
      .flatMap((s) => s.accounts.map((a) => a.code));
    expect(codes).not.toContain('SALES');
    expect(codes).not.toContain('PURCHASES');
  });

  it('names an account it cannot place rather than dropping it', () => {
    const withMystery = buildBalanceSheet({
      asOf: '2026-03-31',
      balances: [...BOOKS, acc('MYSTERY', 'SOMETHING_NEW', 'asset', 999_00n)],
      profitPaise: pl.profitBeforeTaxPaise,
    });
    expect(withMystery.unclassified.map((u) => u.code)).toEqual(['MYSTERY']);
    // And it is excluded from the totals, so the difference reveals it.
    expect(withMystery.differencePaise).toBe(0n);
  });

  it('orders the sections as Schedule III does', () => {
    // Trade payables are absent because the one bill was settled in full, so
    // the line has no figure — an empty line is omitted, not shown as zero.
    expect(bs.equityAndLiabilities.map((s) => s.line)).toEqual([
      'share_capital',
      'reserves_and_surplus',
      'other_current_liabilities',
    ]);
    expect(bs.assets.map((s) => s.line)).toEqual([
      'inventories',
      'trade_receivables',
      'cash_and_equivalents',
      'short_term_loans_and_advances',
    ]);
  });
});

describe('cashFlowActivityFor', () => {
  it('excludes cash itself, which is the thing being explained', () => {
    expect(cashFlowActivityFor(acc('x', 'CASH_IN_HAND', 'asset', 0n))).toBeNull();
    expect(cashFlowActivityFor(acc('x', 'BANK_ACCOUNTS', 'asset', 0n))).toBeNull();
  });

  it('classifies fixed assets as investing and funding as financing', () => {
    expect(cashFlowActivityFor(acc('x', 'FIXED_ASSETS', 'asset', 0n))).toBe('investing');
    expect(cashFlowActivityFor(acc('x', 'CAPITAL', 'equity', 0n))).toBe('financing');
    expect(cashFlowActivityFor(acc('x', 'LOANS_SECURED', 'liability', 0n))).toBe('financing');
  });

  it('classifies working capital as operating', () => {
    for (const group of ['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS', 'STOCK_IN_HAND', 'DUTIES_AND_TAXES']) {
      expect(cashFlowActivityFor(acc('x', group, 'asset', 0n)), group).toBe('operating');
    }
  });
});

describe('buildCashFlow', () => {
  // A first year of trading: everything opened at zero.
  const pl = buildProfitAndLoss({
    from: '2025-04-01',
    to: '2026-03-31',
    movements: BOOKS,
    closingStockEntered: true,
  });
  const cashMovement = 43_900_00n; // bank 38,900 + cash 5,000, opened at nil

  const cf = buildCashFlow({
    from: '2025-04-01',
    to: '2026-03-31',
    movements: BOOKS,
    profitBeforeTaxPaise: pl.profitBeforeTaxPaise,
    openingCashPaise: 0n,
    closingCashPaise: cashMovement,
  });

  it('ties to the movement in cash exactly', () => {
    // Not a hope: ΔCash = Profit + ΔLiabilities + ΔEquity − Δ(other assets), so a
    // non-zero difference means an account went unclassified.
    expect(cf.differencePaise).toBe(0n);
    expect(cf.netChangePaise).toBe(cashMovement);
  });

  it('starts the operating section with profit before tax', () => {
    expect(cf.operating[0]?.label).toBe('Profit before tax');
    expect(cf.operating[0]?.amountPaise).toBe(pl.profitBeforeTaxPaise);
  });

  it('treats an increase in debtors as cash consumed', () => {
    const debtors = cf.operating.find((i) => i.label.includes('sundry_debtors'))
      ?? cf.operating.find((i) => i.label.toLowerCase().includes('debtor'));
    expect(debtors?.amountPaise).toBe(-1_29_800_00n);
  });

  it('treats an increase in a tax liability as cash not yet paid out', () => {
    // Output tax collected and not yet remitted is cash the business holds.
    const outputTax = cf.operating
      .filter((i) => i.label.toLowerCase().includes('output'))
      .reduce((a, i) => a + i.amountPaise, 0n);
    expect(outputTax).toBe(28_800_00n);
  });

  it('puts capital introduced in financing', () => {
    expect(cf.netFinancingPaise).toBe(50_000_00n);
    expect(cf.financing).toHaveLength(1);
  });

  it('has no investing activity when no fixed asset moved', () => {
    expect(cf.investing).toEqual([]);
    expect(cf.netInvestingPaise).toBe(0n);
  });

  it('still ties when a fixed asset is bought', () => {
    const withAsset: AccountBalance[] = [
      ...BOOKS.map((a) =>
        a.code === 'BANK' ? { ...a, netPaise: a.netPaise - 40_000_00n } : a,
      ),
      acc('MACHINERY', 'FIXED_ASSETS', 'asset', 40_000_00n),
    ];
    const plWith = buildProfitAndLoss({
      from: 'a',
      to: 'b',
      movements: withAsset,
      closingStockEntered: true,
    });
    const cfWith = buildCashFlow({
      from: 'a',
      to: 'b',
      movements: withAsset,
      profitBeforeTaxPaise: plWith.profitBeforeTaxPaise,
      openingCashPaise: 0n,
      closingCashPaise: cashMovement - 40_000_00n,
    });
    expect(cfWith.differencePaise).toBe(0n);
    expect(cfWith.netInvestingPaise).toBe(-40_000_00n);
  });

  it('reveals an unclassified account as a difference rather than hiding it', () => {
    // An account in a group the mapping does not know would break the identity,
    // which is exactly what the difference is for.
    const cfBroken = buildCashFlow({
      from: 'a',
      to: 'b',
      movements: BOOKS,
      profitBeforeTaxPaise: pl.profitBeforeTaxPaise,
      openingCashPaise: 0n,
      // A closing figure that does not follow from the movements.
      closingCashPaise: cashMovement + 1n,
    });
    expect(cfBroken.differencePaise).toBe(-1n);
  });

  it('ties for a company that has not traded', () => {
    const cfEmpty = buildCashFlow({
      from: 'a',
      to: 'b',
      movements: [],
      profitBeforeTaxPaise: 0n,
      openingCashPaise: 0n,
      closingCashPaise: 0n,
    });
    expect(cfEmpty.differencePaise).toBe(0n);
  });
});
