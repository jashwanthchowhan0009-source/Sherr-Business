/**
 * The financial statements: profit and loss, balance sheet, cash flow.
 *
 * Pure. Each builder takes account balances and returns a statement; none reads
 * a database, a clock or a tax rate. That is what lets the arithmetic be tested
 * exhaustively, and the arithmetic is the whole of the risk here.
 *
 * Three identities hold, and each has a test rather than a comment:
 *
 *   1. Profit = total revenue − total expenses.
 *   2. The balance sheet balances, once the period's profit is carried into
 *      reserves. It must, because assets = liabilities + equity + (income −
 *      expenses) is the same statement as "every voucher balanced".
 *   3. The cash flow's net change equals the movement in cash and bank. This is
 *      not a coincidence to be hoped for: ΔCash = Profit + ΔLiabilities +
 *      ΔEquity − Δ(other assets), so if every account's movement is classified
 *      into operating, investing or financing, the total is Δcash by
 *      construction. A failure means an account was left unclassified, which is
 *      exactly what the test is for.
 *
 * The mapping of accounts onto Schedule III lines is a reading of the schedule,
 * not professional advice, and is flagged as needing CA verification wherever it
 * is shown.
 */

export interface AccountBalance {
  code: string;
  name: string;
  groupCode: string;
  nature: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  bucket: string | null;
  /** Debit less credit. Positive is a debit balance. */
  netPaise: bigint;
}

// ── profit and loss ─────────────────────────────────────────────────────────

export type PlLine =
  | 'revenue_from_operations'
  | 'other_income'
  | 'cost_of_materials'
  | 'changes_in_inventories'
  | 'employee_benefits'
  | 'finance_costs'
  | 'depreciation'
  | 'other_expenses';

export const PL_LINE_LABELS: Record<PlLine, string> = {
  revenue_from_operations: 'Revenue from operations',
  other_income: 'Other income',
  cost_of_materials: 'Purchases of stock-in-trade',
  changes_in_inventories: 'Changes in inventories',
  employee_benefits: 'Employee benefits expense',
  finance_costs: 'Finance costs',
  depreciation: 'Depreciation and amortisation',
  other_expenses: 'Other expenses',
};

/**
 * Which Schedule III line an account belongs on.
 *
 * Keyed on the account code first, then the group, then the nature. Anything not
 * recognised lands in Other expenses or Other income rather than being dropped:
 * a figure that disappears from the statement is worse than one on the wrong
 * line, because the totals would stop tying to the ledger.
 */
export function plLineFor(account: AccountBalance): PlLine | null {
  if (account.nature === 'income') {
    return account.groupCode === 'SALES' ? 'revenue_from_operations' : 'other_income';
  }
  if (account.nature !== 'expense') return null;

  switch (account.code) {
    case 'INVENTORY_CHANGE':
      return 'changes_in_inventories';
    case 'SALARIES':
      return 'employee_benefits';
    case 'BANK_CHARGES':
      return 'finance_costs';
    case 'DEPRECIATION':
      return 'depreciation';
    default:
      break;
  }
  if (account.groupCode === 'PURCHASES') return 'cost_of_materials';
  if (account.groupCode === 'INVENTORY_CHANGE') return 'changes_in_inventories';
  return 'other_expenses';
}

export interface PlSection {
  line: PlLine;
  label: string;
  amountPaise: bigint;
  accounts: { code: string; name: string; amountPaise: bigint }[];
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  income: PlSection[];
  expenses: PlSection[];
  totalIncomePaise: bigint;
  totalExpensePaise: bigint;
  /** Before tax, because no tax provision is computed by this product. */
  profitBeforeTaxPaise: bigint;
  /** Revenue less cost of materials and inventory change. */
  grossProfitPaise: bigint;
  /** True once closing stock has been entered for the period. */
  closingStockEntered: boolean;
}

/**
 * The profit and loss for a period.
 *
 * `balances` must be *movements* over the period, not closing balances: an
 * income or expense account's figure for a period is what moved through it, and
 * using a cumulative balance would report the year to date whatever dates were
 * asked for.
 */
export function buildProfitAndLoss(input: {
  from: string;
  to: string;
  movements: readonly AccountBalance[];
  closingStockEntered: boolean;
}): ProfitAndLoss {
  const income = new Map<PlLine, PlSection>();
  const expenses = new Map<PlLine, PlSection>();

  for (const account of input.movements) {
    const line = plLineFor(account);
    if (!line) continue;

    const isIncome = account.nature === 'income';
    // Income is a credit balance, so its net is negative; a statement shows it
    // positive. Expenses are debits and already positive.
    const amountPaise = isIncome ? -account.netPaise : account.netPaise;
    if (amountPaise === 0n) continue;

    const target = isIncome ? income : expenses;
    const existing = target.get(line);
    if (existing) {
      existing.amountPaise += amountPaise;
      existing.accounts.push({ code: account.code, name: account.name, amountPaise });
    } else {
      target.set(line, {
        line,
        label: PL_LINE_LABELS[line],
        amountPaise,
        accounts: [{ code: account.code, name: account.name, amountPaise }],
      });
    }
  }

  const ORDER: PlLine[] = [
    'revenue_from_operations',
    'other_income',
    'cost_of_materials',
    'changes_in_inventories',
    'employee_benefits',
    'finance_costs',
    'depreciation',
    'other_expenses',
  ];
  const sorted = (map: Map<PlLine, PlSection>) =>
    ORDER.filter((l) => map.has(l)).map((l) => map.get(l)!);

  const incomeSections = sorted(income);
  const expenseSections = sorted(expenses);

  const totalIncomePaise = incomeSections.reduce((a, s) => a + s.amountPaise, 0n);
  const totalExpensePaise = expenseSections.reduce((a, s) => a + s.amountPaise, 0n);

  const at = (line: PlLine) =>
    expenseSections.find((s) => s.line === line)?.amountPaise ?? 0n;
  const revenue =
    incomeSections.find((s) => s.line === 'revenue_from_operations')?.amountPaise ?? 0n;

  return {
    from: input.from,
    to: input.to,
    income: incomeSections,
    expenses: expenseSections,
    totalIncomePaise,
    totalExpensePaise,
    profitBeforeTaxPaise: totalIncomePaise - totalExpensePaise,
    grossProfitPaise: revenue - at('cost_of_materials') - at('changes_in_inventories'),
    closingStockEntered: input.closingStockEntered,
  };
}

// ── balance sheet ───────────────────────────────────────────────────────────

export type BsLine =
  | 'share_capital'
  | 'reserves_and_surplus'
  | 'long_term_borrowings'
  | 'trade_payables'
  | 'other_current_liabilities'
  | 'fixed_assets'
  | 'inventories'
  | 'trade_receivables'
  | 'cash_and_equivalents'
  | 'short_term_loans_and_advances';

export const BS_LINE_LABELS: Record<BsLine, string> = {
  share_capital: 'Share capital',
  reserves_and_surplus: 'Reserves and surplus',
  long_term_borrowings: 'Long-term borrowings',
  trade_payables: 'Trade payables',
  other_current_liabilities: 'Other current liabilities',
  fixed_assets: 'Property, plant and equipment',
  inventories: 'Inventories',
  trade_receivables: 'Trade receivables',
  cash_and_equivalents: 'Cash and cash equivalents',
  short_term_loans_and_advances: 'Short-term loans and advances',
};

export function bsLineFor(account: AccountBalance): BsLine | null {
  switch (account.groupCode) {
    case 'CAPITAL':
      return 'share_capital';
    case 'RESERVES':
      return 'reserves_and_surplus';
    case 'LOANS_SECURED':
    case 'LOANS_UNSECURED':
      return 'long_term_borrowings';
    case 'SUNDRY_CREDITORS':
      return 'trade_payables';
    case 'CURRENT_LIABILITIES':
    case 'DUTIES_AND_TAXES':
      return 'other_current_liabilities';
    case 'FIXED_ASSETS':
      return 'fixed_assets';
    case 'STOCK_IN_HAND':
      return 'inventories';
    case 'SUNDRY_DEBTORS':
      return 'trade_receivables';
    case 'CASH_IN_HAND':
    case 'BANK_ACCOUNTS':
      return 'cash_and_equivalents';
    case 'LOANS_AND_ADVANCES':
      return 'short_term_loans_and_advances';
    default:
      // A revenue or expense account has no place on a balance sheet; anything
      // else is a chart the product does not recognise, and the caller is told.
      return null;
  }
}

export interface BsSection {
  line: BsLine;
  label: string;
  amountPaise: bigint;
  accounts: { code: string; name: string; amountPaise: bigint }[];
}

export interface BalanceSheet {
  asOf: string;
  equityAndLiabilities: BsSection[];
  assets: BsSection[];
  totalEquityAndLiabilitiesPaise: bigint;
  totalAssetsPaise: bigint;
  /** Must be zero. A non-zero figure means the books do not balance. */
  differencePaise: bigint;
  /**
   * Profit carried into reserves: everything accumulated and not yet transferred
   * to retained earnings, not the profit of whatever window is being reported.
   * A sheet as at a date must reflect all profit earned up to that date.
   */
  profitCarriedPaise: bigint;
  /** Accounts the product could not place, named rather than silently dropped. */
  unclassified: { code: string; name: string; amountPaise: bigint }[];
}

/**
 * The balance sheet as at a date, in Schedule III order.
 *
 * `balances` are closing balances, and `profitPaise` is the profit ACCUMULATED
 * up to that date — not the profit of whatever window is being reported
 * alongside. Without it the sheet cannot balance, because nothing closes the
 * profit and loss to retained earnings until the year is closed; with the wrong
 * one it is out by the profit earned before the window.
 */
export function buildBalanceSheet(input: {
  asOf: string;
  balances: readonly AccountBalance[];
  profitPaise: bigint;
}): BalanceSheet {
  const liabilities = new Map<BsLine, BsSection>();
  const assets = new Map<BsLine, BsSection>();
  const unclassified: { code: string; name: string; amountPaise: bigint }[] = [];

  for (const account of input.balances) {
    // Income and expense accounts belong on the profit and loss; their effect
    // reaches the balance sheet as the profit carried into reserves.
    if (account.nature === 'income' || account.nature === 'expense') continue;

    const line = bsLineFor(account);
    if (!line) {
      if (account.netPaise !== 0n) {
        unclassified.push({
          code: account.code,
          name: account.name,
          amountPaise: account.netPaise,
        });
      }
      continue;
    }

    const isAsset = account.nature === 'asset';
    // A liability or equity account carries a credit balance, shown positive.
    const amountPaise = isAsset ? account.netPaise : -account.netPaise;
    if (amountPaise === 0n) continue;

    const target = isAsset ? assets : liabilities;
    const existing = target.get(line);
    if (existing) {
      existing.amountPaise += amountPaise;
      existing.accounts.push({ code: account.code, name: account.name, amountPaise });
    } else {
      target.set(line, {
        line,
        label: BS_LINE_LABELS[line],
        amountPaise,
        accounts: [{ code: account.code, name: account.name, amountPaise }],
      });
    }
  }

  // The period's profit belongs in reserves. Added here rather than expected to
  // be in the ledger, because nothing closes the profit and loss to retained
  // earnings until the year is closed.
  if (input.profitPaise !== 0n) {
    const existing = liabilities.get('reserves_and_surplus');
    const entry = {
      code: 'PROFIT_FOR_PERIOD',
      name: 'Profit for the period',
      amountPaise: input.profitPaise,
    };
    if (existing) {
      existing.amountPaise += input.profitPaise;
      existing.accounts.push(entry);
    } else {
      liabilities.set('reserves_and_surplus', {
        line: 'reserves_and_surplus',
        label: BS_LINE_LABELS.reserves_and_surplus,
        amountPaise: input.profitPaise,
        accounts: [entry],
      });
    }
  }

  const LIABILITY_ORDER: BsLine[] = [
    'share_capital',
    'reserves_and_surplus',
    'long_term_borrowings',
    'trade_payables',
    'other_current_liabilities',
  ];
  const ASSET_ORDER: BsLine[] = [
    'fixed_assets',
    'inventories',
    'trade_receivables',
    'cash_and_equivalents',
    'short_term_loans_and_advances',
  ];

  const equityAndLiabilities = LIABILITY_ORDER.filter((l) => liabilities.has(l)).map(
    (l) => liabilities.get(l)!,
  );
  const assetSections = ASSET_ORDER.filter((l) => assets.has(l)).map((l) => assets.get(l)!);

  const totalEquityAndLiabilitiesPaise = equityAndLiabilities.reduce(
    (a, s) => a + s.amountPaise,
    0n,
  );
  const totalAssetsPaise = assetSections.reduce((a, s) => a + s.amountPaise, 0n);

  return {
    asOf: input.asOf,
    equityAndLiabilities,
    assets: assetSections,
    totalEquityAndLiabilitiesPaise,
    totalAssetsPaise,
    differencePaise: totalAssetsPaise - totalEquityAndLiabilitiesPaise,
    profitCarriedPaise: input.profitPaise,
    unclassified,
  };
}

// ── cash flow, indirect method ──────────────────────────────────────────────

export type CashFlowActivity = 'operating' | 'investing' | 'financing';

export interface CashFlowItem {
  label: string;
  amountPaise: bigint;
  activity: CashFlowActivity;
}

export interface CashFlow {
  from: string;
  to: string;
  profitBeforeTaxPaise: bigint;
  operating: CashFlowItem[];
  investing: CashFlowItem[];
  financing: CashFlowItem[];
  netOperatingPaise: bigint;
  netInvestingPaise: bigint;
  netFinancingPaise: bigint;
  netChangePaise: bigint;
  openingCashPaise: bigint;
  closingCashPaise: bigint;
  /**
   * Must be zero. Non-zero means an account's movement was not classified, which
   * is a gap in the mapping rather than a rounding error.
   */
  differencePaise: bigint;
}

/**
 * Which activity an account's movement belongs to.
 *
 * Cash itself is excluded: it is the thing being explained, not a line in the
 * explanation.
 */
export function cashFlowActivityFor(account: AccountBalance): CashFlowActivity | null {
  switch (account.groupCode) {
    case 'CASH_IN_HAND':
    case 'BANK_ACCOUNTS':
      return null;
    case 'FIXED_ASSETS':
      return 'investing';
    case 'CAPITAL':
    case 'RESERVES':
    case 'LOANS_SECURED':
    case 'LOANS_UNSECURED':
      return 'financing';
    default:
      // Working capital: debtors, creditors, stock, duties and taxes, advances.
      return 'operating';
  }
}

/**
 * The cash flow statement, indirect method.
 *
 * Built from the movement in every balance-sheet account over the period, plus
 * the period's profit. The identity ΔCash = Profit + ΔLiabilities + ΔEquity −
 * Δ(other assets) means the classified total equals the movement in cash by
 * construction — so `differencePaise` being non-zero is a missing
 * classification, not an arithmetic slip, and the suite asserts it is zero.
 */
export function buildCashFlow(input: {
  from: string;
  to: string;
  /** Movement in each balance-sheet account over the period. */
  movements: readonly AccountBalance[];
  profitBeforeTaxPaise: bigint;
  openingCashPaise: bigint;
  closingCashPaise: bigint;
}): CashFlow {
  const buckets: Record<CashFlowActivity, CashFlowItem[]> = {
    operating: [],
    investing: [],
    financing: [],
  };

  for (const account of input.movements) {
    if (account.nature === 'income' || account.nature === 'expense') continue;

    const activity = cashFlowActivityFor(account);
    if (!activity) continue;
    if (account.netPaise === 0n) continue;

    // An increase in an asset consumes cash; an increase in a liability or in
    // equity provides it. `netPaise` is debit less credit, so an asset increase
    // is positive and must be negated, and a liability increase is negative and
    // already has the right sign for a cash inflow.
    const amountPaise = -account.netPaise;

    buckets[activity].push({
      label: labelFor(account, amountPaise),
      amountPaise,
      activity,
    });
  }

  // Profit is the starting point of the operating section.
  buckets.operating.unshift({
    label: 'Profit before tax',
    amountPaise: input.profitBeforeTaxPaise,
    activity: 'operating',
  });

  const total = (items: readonly CashFlowItem[]) =>
    items.reduce((a, i) => a + i.amountPaise, 0n);

  const netOperatingPaise = total(buckets.operating);
  const netInvestingPaise = total(buckets.investing);
  const netFinancingPaise = total(buckets.financing);
  const netChangePaise = netOperatingPaise + netInvestingPaise + netFinancingPaise;

  return {
    from: input.from,
    to: input.to,
    profitBeforeTaxPaise: input.profitBeforeTaxPaise,
    operating: buckets.operating,
    investing: buckets.investing,
    financing: buckets.financing,
    netOperatingPaise,
    netInvestingPaise,
    netFinancingPaise,
    netChangePaise,
    openingCashPaise: input.openingCashPaise,
    closingCashPaise: input.closingCashPaise,
    differencePaise: netChangePaise - (input.closingCashPaise - input.openingCashPaise),
  };
}

/** Names the movement the way a cash flow statement reads it. */
function labelFor(account: AccountBalance, amountPaise: bigint): string {
  const direction = amountPaise < 0n ? 'Increase in' : 'Decrease in';
  if (account.nature === 'asset') {
    return `${direction === 'Increase in' ? 'Increase in' : 'Decrease in'} ${account.name.toLowerCase()}`;
  }
  // For a liability, cash in means the liability grew.
  return `${amountPaise > 0n ? 'Increase in' : 'Decrease in'} ${account.name.toLowerCase()}`;
}
