import type { ComponentType, SVGProps } from 'react';
import {
  AccountingIcon, DashboardIcon, DocumentsIcon, EmployeesIcon, FinanceIcon, IntelligenceIcon,
  InventoryIcon, PurchasesIcon, ReportsIcon, SalesIcon, SettingsIcon, TaxIcon,
} from './icons';

/**
 * The whole navigation, in one place, so the sidebar, the quick-jump search and
 * the page title all agree.
 *
 * An entry with no `href` is a module that does not exist yet. It is shown —
 * the rail is the map of the whole system — but cannot be clicked, and says so.
 * Links point at the real section that does the job today, by anchor.
 */
export interface NavLink {
  label: string;
  href?: string;
}

export interface NavGroup {
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** A group with an href and no items is a single destination. */
  href?: string;
  items?: NavLink[];
}

export const NAV: NavGroup[] = [
  { label: 'Dashboard', Icon: DashboardIcon, href: '/dashboard' },
  {
    label: 'Sales',
    Icon: SalesIcon,
    items: [
      { label: 'Customers', href: '/process#parties' },
      { label: 'Leads' },
      { label: 'Quotations' },
      { label: 'Sales orders' },
      { label: 'Invoices', href: '/process#sales-invoice' },
      { label: 'Receipts', href: '/process#receipt' },
    ],
  },
  {
    label: 'Purchases',
    Icon: PurchasesIcon,
    items: [
      { label: 'Vendors', href: '/process#parties' },
      { label: 'Purchase orders', href: '/process#purchase-order' },
      { label: 'Goods received', href: '/process#goods-received' },
      { label: 'Bills', href: '/process#purchase-bill' },
      { label: 'Payments', href: '/process#payment' },
    ],
  },
  {
    label: 'Accounting',
    Icon: AccountingIcon,
    items: [
      { label: 'Transactions', href: '/process#vouchers' },
      { label: 'Journal', href: '/process#journal' },
      { label: 'Ledger', href: '/output#trial-balance' },
      { label: 'Day book', href: '/output#day-book' },
      { label: 'Bank accounts', href: '/process#bank-statement' },
      { label: 'Reconciliation', href: '/output#bank-reconciliation' },
    ],
  },
  {
    label: 'Finance',
    Icon: FinanceIcon,
    items: [
      { label: 'Cash flow', href: '/output#cash-flow' },
      { label: 'Profit & loss', href: '/output#profit-and-loss' },
      { label: 'Balance sheet', href: '/output#balance-sheet' },
      { label: 'Closing the books', href: '/output#closing' },
    ],
  },
  {
    label: 'Inventory',
    Icon: InventoryIcon,
    items: [
      { label: 'Products', href: '/process#items' },
      { label: 'Stock' },
      { label: 'Warehouses' },
    ],
  },
  {
    label: 'Tax & compliance',
    Icon: TaxIcon,
    items: [
      { label: 'GST', href: '/output/taxation#gstr-1' },
      { label: 'TDS', href: '/output/taxation#tds' },
      { label: 'Tax returns', href: '/output/taxation#gstr-3b' },
      { label: 'GSTR-2B match', href: '/output/taxation#gstr-2b' },
      { label: 'Compliance', href: '/output/taxation#rules' },
    ],
  },
  {
    label: 'Employees',
    Icon: EmployeesIcon,
    items: [{ label: 'Payroll' }, { label: 'Attendance' }, { label: 'Expenses' }],
  },
  { label: 'Reports', Icon: ReportsIcon, href: '/output' },
  { label: 'Documents', Icon: DocumentsIcon, href: '/input' },
  { label: 'Intelligence', Icon: IntelligenceIcon, href: '/dashboard#intelligence' },
  {
    label: 'Settings',
    Icon: SettingsIcon,
    items: [
      { label: 'Company', href: '/data' },
      { label: 'People & access', href: '/people' },
    ],
  },
];

/** The quick actions behind "+ Create". Every one opens a real form. */
export const CREATE_ACTIONS: { label: string; href: string }[] = [
  { label: 'Sales invoice', href: '/process#sales-invoice' },
  { label: 'Receipt', href: '/process#receipt' },
  { label: 'Purchase bill', href: '/process#purchase-bill' },
  { label: 'Payment', href: '/process#payment' },
  { label: 'Purchase order', href: '/process#purchase-order' },
  { label: 'Journal entry', href: '/process#journal' },
  { label: 'Customer or supplier', href: '/process#parties' },
  { label: 'Upload a document', href: '/input' },
];

/** Every reachable destination, flattened, for the quick-jump search. */
export function flatDestinations(): { label: string; group: string; href: string }[] {
  const out: { label: string; group: string; href: string }[] = [];
  for (const group of NAV) {
    if (group.href) out.push({ label: group.label, group: '', href: group.href });
    for (const item of group.items ?? []) {
      if (item.href) out.push({ label: item.label, group: group.label, href: item.href });
    }
  }
  for (const action of CREATE_ACTIONS) {
    out.push({ label: `New ${action.label.toLowerCase()}`, group: 'Create', href: action.href });
  }
  return out;
}
