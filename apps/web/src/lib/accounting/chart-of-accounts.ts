/**
 * The default chart of accounts, seeded once when a company is created.
 *
 * Grouped for Schedule III of the Companies Act, because the Balance Sheet in
 * step F has to present under those headings and retro-fitting a grouping onto
 * accounts that already carry postings is painful.
 *
 * Pure data. The seeding itself happens in app_create_company() so that the
 * organization, its owner and its accounts are one transaction.
 *
 * NEEDS CA VERIFICATION: the groupings below are common Indian practice as
 * implemented by Tally and Zoho Books, not professional advice. They should be
 * reviewed before any company relies on the statements built from them.
 */

export type AccountNature = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** Where a group lands on the Schedule III face of the Balance Sheet or P&L. */
export type ScheduleIiiBucket =
  | 'equity_and_liabilities'
  | 'non_current_liabilities'
  | 'current_liabilities'
  | 'non_current_assets'
  | 'current_assets'
  | 'revenue'
  | 'expenses';

export interface AccountGroupSeed {
  code: string;
  name: string;
  parent: string | null;
  nature: AccountNature;
  bucket: ScheduleIiiBucket;
}

export interface AccountSeed {
  code: string;
  name: string;
  group: string;
  /**
   * System accounts are referenced by the engines by code (Round Off by the
   * invoice rounding rule, the GST accounts by the tax engine), so they cannot
   * be renamed away or deleted.
   */
  isSystem: boolean;
  note?: string;
}

export const ACCOUNT_GROUPS: readonly AccountGroupSeed[] = Object.freeze([
  // ── Equity ────────────────────────────────────────────────────────────────
  { code: 'CAPITAL', name: 'Capital Account', parent: null, nature: 'equity', bucket: 'equity_and_liabilities' },
  { code: 'RESERVES', name: 'Reserves & Surplus', parent: null, nature: 'equity', bucket: 'equity_and_liabilities' },

  // ── Liabilities ───────────────────────────────────────────────────────────
  { code: 'LOANS_SECURED', name: 'Loans (Secured)', parent: null, nature: 'liability', bucket: 'non_current_liabilities' },
  { code: 'LOANS_UNSECURED', name: 'Loans (Unsecured)', parent: null, nature: 'liability', bucket: 'non_current_liabilities' },
  { code: 'CURRENT_LIABILITIES', name: 'Current Liabilities', parent: null, nature: 'liability', bucket: 'current_liabilities' },
  { code: 'SUNDRY_CREDITORS', name: 'Sundry Creditors', parent: 'CURRENT_LIABILITIES', nature: 'liability', bucket: 'current_liabilities' },
  { code: 'DUTIES_AND_TAXES', name: 'Duties & Taxes', parent: 'CURRENT_LIABILITIES', nature: 'liability', bucket: 'current_liabilities' },

  // ── Assets ────────────────────────────────────────────────────────────────
  { code: 'FIXED_ASSETS', name: 'Fixed Assets', parent: null, nature: 'asset', bucket: 'non_current_assets' },
  { code: 'CURRENT_ASSETS', name: 'Current Assets', parent: null, nature: 'asset', bucket: 'current_assets' },
  { code: 'SUNDRY_DEBTORS', name: 'Sundry Debtors', parent: 'CURRENT_ASSETS', nature: 'asset', bucket: 'current_assets' },
  { code: 'CASH_IN_HAND', name: 'Cash-in-Hand', parent: 'CURRENT_ASSETS', nature: 'asset', bucket: 'current_assets' },
  { code: 'BANK_ACCOUNTS', name: 'Bank Accounts', parent: 'CURRENT_ASSETS', nature: 'asset', bucket: 'current_assets' },
  { code: 'STOCK_IN_HAND', name: 'Stock-in-Hand', parent: 'CURRENT_ASSETS', nature: 'asset', bucket: 'current_assets' },
  { code: 'LOANS_AND_ADVANCES', name: 'Loans & Advances (Asset)', parent: 'CURRENT_ASSETS', nature: 'asset', bucket: 'current_assets' },

  // ── Income ────────────────────────────────────────────────────────────────
  { code: 'SALES', name: 'Sales Accounts', parent: null, nature: 'income', bucket: 'revenue' },
  { code: 'INDIRECT_INCOME', name: 'Indirect Income', parent: null, nature: 'income', bucket: 'revenue' },

  // ── Expenses ──────────────────────────────────────────────────────────────
  { code: 'PURCHASES', name: 'Purchase Accounts', parent: null, nature: 'expense', bucket: 'expenses' },
  { code: 'DIRECT_EXPENSES', name: 'Direct Expenses', parent: null, nature: 'expense', bucket: 'expenses' },
  // Schedule III shows "changes in inventories" as its own expense line, so it
  // gets its own group rather than being buried in direct expenses.
  { code: 'INVENTORY_CHANGE', name: 'Changes in Inventories', parent: null, nature: 'expense', bucket: 'expenses' },
  { code: 'INDIRECT_EXPENSES', name: 'Indirect Expenses', parent: null, nature: 'expense', bucket: 'expenses' },
]);

export const ACCOUNTS: readonly AccountSeed[] = Object.freeze([
  // Equity
  { code: 'CAPITAL_ACCOUNT', name: 'Capital Account', group: 'CAPITAL', isSystem: false },
  { code: 'RETAINED_EARNINGS', name: 'Retained Earnings', group: 'RESERVES', isSystem: true,
    note: 'Receives the P&L result when a financial year is closed.' },

  // Payables
  { code: 'SUNDRY_CREDITORS', name: 'Sundry Creditors', group: 'SUNDRY_CREDITORS', isSystem: true,
    note: 'Control account for supplier balances.' },

  // Output tax — a liability until paid to the government.
  { code: 'OUTPUT_CGST', name: 'Output CGST', group: 'DUTIES_AND_TAXES', isSystem: true },
  { code: 'OUTPUT_SGST', name: 'Output SGST', group: 'DUTIES_AND_TAXES', isSystem: true },
  { code: 'OUTPUT_IGST', name: 'Output IGST', group: 'DUTIES_AND_TAXES', isSystem: true },
  { code: 'OUTPUT_CESS', name: 'Output Cess', group: 'DUTIES_AND_TAXES', isSystem: true },
  { code: 'TDS_PAYABLE', name: 'TDS Payable', group: 'DUTIES_AND_TAXES', isSystem: true },

  // Assets
  { code: 'SUNDRY_DEBTORS', name: 'Sundry Debtors', group: 'SUNDRY_DEBTORS', isSystem: true,
    note: 'Control account for customer balances.' },
  { code: 'CASH', name: 'Cash', group: 'CASH_IN_HAND', isSystem: true },
  // A company adds its real accounts (HDFC Current A/c and so on) under the
  // Bank Accounts group. This one exists so a receipt can be banked on day
  // one: without it the only destination for money received would be cash,
  // which is not how any business actually operates.
  { code: 'BANK', name: 'Bank Account', group: 'BANK_ACCOUNTS', isSystem: true,
    note: 'Default bank ledger. Add your named bank accounts and use those instead.' },
  { code: 'STOCK_IN_HAND', name: 'Stock-in-Hand', group: 'STOCK_IN_HAND', isSystem: true,
    note: 'Closing stock is entered at period end; gross profit stays provisional until it is.' },
  { code: 'INVENTORY_CHANGE', name: 'Changes in Inventories', group: 'INVENTORY_CHANGE', isSystem: true,
    note: 'Opening stock debited, closing stock credited. Carries (opening less closing) for the period.' },

  // Input tax — an asset: credit recoverable against output tax.
  { code: 'INPUT_CGST', name: 'Input CGST', group: 'LOANS_AND_ADVANCES', isSystem: true },
  { code: 'INPUT_SGST', name: 'Input SGST', group: 'LOANS_AND_ADVANCES', isSystem: true },
  { code: 'INPUT_IGST', name: 'Input IGST', group: 'LOANS_AND_ADVANCES', isSystem: true },
  { code: 'INPUT_CESS', name: 'Input Cess', group: 'LOANS_AND_ADVANCES', isSystem: true },
  { code: 'TDS_RECEIVABLE', name: 'TDS Receivable', group: 'LOANS_AND_ADVANCES', isSystem: true,
    note: 'TDS deducted by customers on payments to us.' },

  // Income
  { code: 'SALES', name: 'Sales', group: 'SALES', isSystem: true },
  { code: 'SALES_RETURNS', name: 'Sales Returns', group: 'SALES', isSystem: true,
    note: 'Credit notes post here rather than reducing Sales directly.' },
  { code: 'DISCOUNT_RECEIVED', name: 'Discount Received', group: 'INDIRECT_INCOME', isSystem: false },

  // Expenses
  { code: 'PURCHASES', name: 'Purchases', group: 'PURCHASES', isSystem: true },
  { code: 'PURCHASE_RETURNS', name: 'Purchase Returns', group: 'PURCHASES', isSystem: true },
  { code: 'FREIGHT_INWARD', name: 'Freight Inward', group: 'DIRECT_EXPENSES', isSystem: false },
  { code: 'DISCOUNT_ALLOWED', name: 'Discount Allowed', group: 'INDIRECT_EXPENSES', isSystem: false },
  { code: 'BANK_CHARGES', name: 'Bank Charges', group: 'INDIRECT_EXPENSES', isSystem: false },
  { code: 'RENT', name: 'Rent', group: 'INDIRECT_EXPENSES', isSystem: false },
  { code: 'SALARIES', name: 'Salaries & Wages', group: 'INDIRECT_EXPENSES', isSystem: false },

  // Required before the first invoice: an invoice total is rounded to the
  // nearest rupee and the difference posted here. It legitimately carries
  // either sign, which is why it sits in expenses rather than being split.
  { code: 'ROUND_OFF', name: 'Round Off', group: 'INDIRECT_EXPENSES', isSystem: true,
    note: 'Difference between the sum of line amounts and the rounded invoice total.' },
]);

const GROUPS_BY_CODE = new Map(ACCOUNT_GROUPS.map((g) => [g.code, g]));

/** Walks up to the root group, which is what Schedule III presents under. */
export function rootGroupOf(groupCode: string): AccountGroupSeed {
  let current = GROUPS_BY_CODE.get(groupCode);
  if (!current) throw new Error(`Unknown account group: ${groupCode}`);
  const seen = new Set<string>();
  while (current.parent) {
    if (seen.has(current.code)) throw new Error(`Cycle in account groups at ${current.code}`);
    seen.add(current.code);
    const parent = GROUPS_BY_CODE.get(current.parent);
    if (!parent) throw new Error(`${current.code} names a missing parent: ${current.parent}`);
    current = parent;
  }
  return current;
}

/** The nature an account inherits from its group. */
export function natureOf(accountCode: string): AccountNature {
  const account = ACCOUNTS.find((a) => a.code === accountCode);
  if (!account) throw new Error(`Unknown account: ${accountCode}`);
  const group = GROUPS_BY_CODE.get(account.group);
  if (!group) throw new Error(`${accountCode} names a missing group: ${account.group}`);
  return group.nature;
}

export const SYSTEM_ACCOUNT_CODES = Object.freeze(
  ACCOUNTS.filter((a) => a.isSystem).map((a) => a.code),
);
