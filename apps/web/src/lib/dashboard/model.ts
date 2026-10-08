/**
 * The dashboard's view model: turns ledger reads into what the owner sees.
 *
 * Pure and integer-only for money. Every figure, comparison and observation here
 * is derived from posted entries or open documents; when the data cannot support
 * a statement, the statement is left out rather than softened or estimated.
 */
import { dueDate } from '@/lib/accounting/ageing';
import { addDays, addMonths, daysFromTo, monthEnd, monthLabel, monthStart } from './dates';

// ── inputs ───────────────────────────────────────────────────────────────────

export interface DayInput {
  date: string;
  revenuePaise: bigint;
  incomePaise: bigint;
  expensePaise: bigint;
  cashInPaise: bigint;
  cashOutPaise: bigint;
}

export interface OpenDocument {
  voucherId: string;
  voucherNo: string;
  partyName: string;
  voucherDate: string;
  creditDays: number;
  outstandingPaise: bigint;
}

export interface PartyOverdue {
  partyName: string;
  overduePaise: bigint;
  totalPaise: bigint;
}

// ── comparisons ──────────────────────────────────────────────────────────────

export interface Change {
  /** Percent change in tenths: 142 means +14.2%. */
  tenths: number;
  text: string;
}

/**
 * Percentage change, rounded half away from zero to one decimal, in bigint.
 * Null when there is no base to compare with — a change from nothing is not a
 * percentage, and "+∞%" helps nobody.
 */
export function percentChange(current: bigint, previous: bigint): Change | null {
  if (previous === 0n) return null;
  const base = previous < 0n ? -previous : previous;
  const diff = current - previous;
  const scaled = diff * 2000n;
  const half = scaled >= 0n ? scaled + base : scaled - base;
  const tenths = Number(half / (2n * base));
  return { tenths, text: formatTenths(tenths) };
}

export function formatTenths(tenths: number): string {
  const sign = tenths > 0 ? '+' : tenths < 0 ? '−' : '';
  const abs = Math.abs(tenths);
  return `${sign}${Math.floor(abs / 10)}.${abs % 10}%`;
}

/** Share of `part` in `whole`, in whole percent, half-up. */
export function sharePercent(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 200n + whole) / (2n * whole));
}

// ── time series ──────────────────────────────────────────────────────────────

export const SERIES = ['revenue', 'expenses', 'profit', 'cash'] as const;
export type SeriesKey = (typeof SERIES)[number];

export const RANGES = ['7D', '30D', '3M', '6M', '1Y'] as const;
export type RangeKey = (typeof RANGES)[number];

/** A day, flattened to plain numbers of paise so it can cross to the browser. */
export interface DayPoint {
  date: string;
  revenue: number;
  expenses: number;
  profit: number;
  cashIn: number;
  cashOut: number;
}

export function toDayPoints(days: readonly DayInput[]): DayPoint[] {
  return days.map((d) => ({
    date: d.date,
    revenue: Number(d.revenuePaise),
    expenses: Number(d.expensePaise),
    profit: Number(d.incomePaise - d.expensePaise),
    cashIn: Number(d.cashInPaise),
    cashOut: Number(d.cashOutPaise),
  }));
}

export interface Bucket {
  /** First day of the bucket, `YYYY-MM-DD`. */
  start: string;
  end: string;
  label: string;
  revenue: number;
  expenses: number;
  profit: number;
  cashIn: number;
  cashOut: number;
}

function emptyBucket(start: string, end: string, label: string): Bucket {
  return { start, end, label, revenue: 0, expenses: 0, profit: 0, cashIn: 0, cashOut: 0 };
}

function fill(buckets: Bucket[], points: readonly DayPoint[]): Bucket[] {
  for (const p of points) {
    const b = buckets.find((x) => p.date >= x.start && p.date <= x.end);
    if (!b) continue;
    b.revenue += p.revenue;
    b.expenses += p.expenses;
    b.profit += p.profit;
    b.cashIn += p.cashIn;
    b.cashOut += p.cashOut;
  }
  return buckets;
}

/**
 * Buckets for a chart range ending `today`: days for the short ranges, weeks
 * for three months, calendar months beyond. Every bucket is present even when
 * empty, so a quiet week shows as a gap rather than disappearing.
 */
export function bucketsFor(range: RangeKey, points: readonly DayPoint[], today: string): Bucket[] {
  if (range === '7D' || range === '30D') {
    const n = range === '7D' ? 7 : 30;
    const out: Bucket[] = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = addDays(today, -i);
      out.push(emptyBucket(d, d, `${Number(d.slice(8, 10))} ${monthLabel(d)}`));
    }
    return fill(out, points);
  }
  if (range === '3M') {
    const out: Bucket[] = [];
    for (let i = 12; i >= 0; i -= 1) {
      const end = addDays(today, -i * 7);
      const start = addDays(end, -6);
      out.push(emptyBucket(start, end, `${Number(start.slice(8, 10))} ${monthLabel(start)}`));
    }
    return fill(out, points);
  }
  const months = range === '6M' ? 6 : 12;
  const out: Bucket[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const start = addMonths(today, -i);
    out.push(emptyBucket(start, monthEnd(start), monthLabel(start, months > 6)));
  }
  return fill(out, points);
}

export function valueOf(bucket: Bucket, key: SeriesKey): number {
  if (key === 'cash') return bucket.cashIn - bucket.cashOut;
  return bucket[key];
}

/** Monthly values for a sparkline across the financial year to date. */
export function monthlySpark(
  points: readonly DayPoint[],
  fyStart: string,
  today: string,
  pick: (b: Bucket) => number,
): number[] {
  const out: Bucket[] = [];
  for (let m = monthStart(fyStart); m <= today; m = addMonths(m, 1)) {
    out.push(emptyBucket(m, monthEnd(m), monthLabel(m)));
  }
  return fill(out, points).map(pick);
}

/** Month-end cash balances across the financial year, from an opening figure. */
export function cashSpark(
  points: readonly DayPoint[],
  cashBeforeSeries: bigint,
  seriesFrom: string,
  fyStart: string,
  today: string,
): number[] {
  let running = Number(cashBeforeSeries);
  const out: number[] = [];
  let m = monthStart(fyStart);
  // Bring the running balance up to the start of the year.
  for (const p of points) if (p.date < m && p.date >= seriesFrom) running += p.cashIn - p.cashOut;
  for (; m <= today; m = addMonths(m, 1)) {
    const end = monthEnd(m);
    for (const p of points) if (p.date >= m && p.date <= end) running += p.cashIn - p.cashOut;
    out.push(running);
  }
  return out;
}

// ── receivables and payables ─────────────────────────────────────────────────

export interface DueSummary {
  totalPaise: bigint;
  overduePaise: bigint;
  overdueCount: number;
  dueThisWeekPaise: bigint;
  dueThisMonthPaise: bigint;
  /** Oldest-overdue first, at most `limit`. */
  overdue: (OpenDocument & { due: string; daysOverdue: number })[];
}

export function summariseDue(docs: readonly OpenDocument[], today: string, limit = 3): DueSummary {
  const weekEnd = addDays(today, 6);
  const monthLast = monthEnd(today);
  let total = 0n;
  let overdue = 0n;
  let week = 0n;
  let month = 0n;
  const late: DueSummary['overdue'] = [];
  for (const d of docs) {
    const due = dueDate(d.voucherDate, d.creditDays);
    total += d.outstandingPaise;
    if (due < today) {
      overdue += d.outstandingPaise;
      late.push({ ...d, due, daysOverdue: daysFromTo(due, today) });
    } else {
      if (due <= weekEnd) week += d.outstandingPaise;
      if (due <= monthLast) month += d.outstandingPaise;
    }
  }
  late.sort((a, b) => b.daysOverdue - a.daysOverdue || Number(b.outstandingPaise - a.outstandingPaise));
  return {
    totalPaise: total,
    overduePaise: overdue,
    overdueCount: late.length,
    dueThisWeekPaise: week,
    dueThisMonthPaise: month,
    overdue: late.slice(0, limit),
  };
}

// ── cash forecast ────────────────────────────────────────────────────────────

export interface CashMonth {
  label: string;
  inPaise: number;
  outPaise: number;
  /** Balance at the month's end: actual for past months, projected after. */
  balancePaise: number;
  forecast: boolean;
}

/**
 * Six months of actual cash movement, then three projected from open invoices
 * and bills by their due dates. Overdue amounts are placed in the current
 * month — they are owed now — and nothing beyond what is documented is assumed.
 */
export function cashOutlook(input: {
  points: readonly DayPoint[];
  cashNowPaise: bigint;
  receivables: readonly OpenDocument[];
  payables: readonly OpenDocument[];
  today: string;
}): CashMonth[] {
  const { points, today } = input;
  const thisMonth = monthStart(today);
  const months: CashMonth[] = [];

  // Actual: walk back from today's balance.
  const actual: { start: string; in: number; out: number }[] = [];
  for (let i = 5; i >= 0; i -= 1) {
    const start = addMonths(today, -i);
    const end = monthEnd(start);
    let inSum = 0;
    let outSum = 0;
    for (const p of points) {
      if (p.date >= start && p.date <= end) {
        inSum += p.cashIn;
        outSum += p.cashOut;
      }
    }
    actual.push({ start, in: inSum, out: outSum });
  }
  let balance = Number(input.cashNowPaise);
  const balances: number[] = [];
  for (let i = actual.length - 1; i >= 0; i -= 1) {
    balances[i] = balance;
    balance -= actual[i]!.in - actual[i]!.out;
  }
  actual.forEach((a, i) => {
    months.push({
      label: monthLabel(a.start),
      inPaise: a.in,
      outPaise: a.out,
      balancePaise: balances[i]!,
      forecast: false,
    });
  });

  // Projected: the next three months from documents due.
  const bucketOf = (doc: OpenDocument): string => {
    const due = dueDate(doc.voucherDate, doc.creditDays);
    return due < thisMonth ? thisMonth : monthStart(due);
  };
  let projected = Number(input.cashNowPaise);
  for (let i = 1; i <= 3; i += 1) {
    const start = addMonths(today, i);
    // The current month's remaining dues land in the first projected month.
    const inSum = input.receivables
      .filter((d) => {
        const b = bucketOf(d);
        return i === 1 ? b <= start : b === start;
      })
      .reduce((s, d) => s + Number(d.outstandingPaise), 0);
    const outSum = input.payables
      .filter((d) => {
        const b = bucketOf(d);
        return i === 1 ? b <= start : b === start;
      })
      .reduce((s, d) => s + Number(d.outstandingPaise), 0);
    projected += inSum - outSum;
    months.push({
      label: monthLabel(start),
      inPaise: inSum,
      outPaise: outSum,
      balancePaise: projected,
      forecast: true,
    });
  }
  return months;
}

// ── what needs attention ─────────────────────────────────────────────────────

export interface AttentionItem {
  tone: 'crit' | 'warn';
  title: string;
  detail: string;
  href: string;
  action: string;
}

export interface AttentionInput {
  today: string;
  ledgerOutPaise: bigint;
  receivable: DueSummary;
  payable: DueSummary;
  gstPayablePaise: bigint;
  draftVouchers: number;
  unlinkedDocuments: number;
  unmatchedBankLines: number;
  openPurchaseOrders: number;
  closingStockMissing: boolean;
  hasPurchases: boolean;
  membersWithoutMfa: number;
  formatAmount: (paise: bigint) => string;
}

export function attentionItems(input: AttentionInput): AttentionItem[] {
  const f = input.formatAmount;
  const items: AttentionItem[] = [];

  if (input.ledgerOutPaise !== 0n) {
    items.push({
      tone: 'crit',
      title: 'Ledger does not balance',
      detail: `Out by ${f(input.ledgerOutPaise < 0n ? -input.ledgerOutPaise : input.ledgerOutPaise)}`,
      href: '/output#trial-balance',
      action: 'Open trial balance',
    });
  }

  for (const doc of input.receivable.overdue) {
    items.push({
      tone: doc.daysOverdue > 30 ? 'crit' : 'warn',
      title: `${doc.voucherNo} · ${doc.partyName}`,
      detail: `${f(doc.outstandingPaise)} overdue by ${doc.daysOverdue} ${doc.daysOverdue === 1 ? 'day' : 'days'}`,
      href: `/api/invoices/${doc.voucherId}/pdf`,
      action: 'View invoice',
    });
  }
  const moreOverdue = input.receivable.overdueCount - input.receivable.overdue.length;
  if (moreOverdue > 0) {
    items.push({
      tone: 'warn',
      title: `${moreOverdue} more overdue ${moreOverdue === 1 ? 'invoice' : 'invoices'}`,
      detail: `${f(input.receivable.overduePaise)} overdue in total`,
      href: '#receivables',
      action: 'See receivables',
    });
  }

  if (input.payable.overdueCount > 0) {
    items.push({
      tone: 'warn',
      title: `${input.payable.overdueCount} supplier ${input.payable.overdueCount === 1 ? 'bill' : 'bills'} overdue`,
      detail: `${f(input.payable.overduePaise)} past due`,
      href: '/process#payment',
      action: 'Record a payment',
    });
  }

  if (input.gstPayablePaise > 0n) {
    items.push({
      tone: 'warn',
      title: 'GST payable',
      detail: `${f(input.gstPayablePaise)} output tax after input credit`,
      href: '/output/taxation#gstr-3b',
      action: 'Open GSTR-3B',
    });
  }

  if (input.unmatchedBankLines > 0) {
    items.push({
      tone: 'warn',
      title: `${input.unmatchedBankLines} bank ${input.unmatchedBankLines === 1 ? 'line needs' : 'lines need'} reconciling`,
      detail: 'From imported statements',
      href: '/process#bank-statement',
      action: 'Reconcile',
    });
  }

  if (input.closingStockMissing && input.hasPurchases) {
    items.push({
      tone: 'warn',
      title: 'Closing stock not entered',
      detail: 'Profit is understated until it is',
      href: '/output#closing',
      action: 'Enter closing stock',
    });
  }

  if (input.draftVouchers > 0) {
    items.push({
      tone: 'warn',
      title: `${input.draftVouchers} draft ${input.draftVouchers === 1 ? 'entry' : 'entries'}`,
      detail: 'Not in the books until posted',
      href: '/process#vouchers',
      action: 'Review drafts',
    });
  }

  if (input.openPurchaseOrders > 0) {
    items.push({
      tone: 'warn',
      title: `${input.openPurchaseOrders} purchase ${input.openPurchaseOrders === 1 ? 'order' : 'orders'} open`,
      detail: 'Awaiting goods or a bill',
      href: '/output#three-way-match',
      action: 'Check matching',
    });
  }

  if (input.unlinkedDocuments > 0) {
    items.push({
      tone: 'warn',
      title: `${input.unlinkedDocuments} ${input.unlinkedDocuments === 1 ? 'document' : 'documents'} not entered`,
      detail: 'Uploaded but not linked to an entry',
      href: '/input',
      action: 'Open documents',
    });
  }

  if (input.membersWithoutMfa > 0) {
    items.push({
      tone: 'crit',
      title: `${input.membersWithoutMfa} ${input.membersWithoutMfa === 1 ? 'member' : 'members'} without two-factor`,
      detail: 'Access to the books without a second factor',
      href: '/people',
      action: 'Review access',
    });
  }

  // Critical first, then in the order above, which is the order they cost money.
  return items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'crit' ? -1 : 1));
}

// ── observations ─────────────────────────────────────────────────────────────

export interface Insight {
  title: string;
  why: string;
  action?: { label: string; href: string };
}

export interface ExpenseMonth {
  month: string;
  code: string;
  name: string;
  amountPaise: bigint;
}

export interface InsightInput {
  today: string;
  points: readonly DayPoint[];
  receivableParties: readonly PartyOverdue[];
  receivableOverduePaise: bigint;
  outlook: readonly CashMonth[];
  expenseMonths: readonly ExpenseMonth[];
  topCustomers: readonly { name: string; amountPaise: bigint }[];
  revenuePaise: bigint;
  formatAmount: (paise: bigint) => string;
}

/** The single biggest month-on-month rise among expense accounts, if notable. */
export function expenseAnomaly(
  months: readonly ExpenseMonth[],
  today: string,
): { name: string; change: Change; nowPaise: bigint; month: string } | null {
  const last = addMonths(today, -1);
  const before = addMonths(today, -2);
  const byCode = new Map<string, { name: string; last: bigint; before: bigint }>();
  for (const m of months) {
    const entry = byCode.get(m.code) ?? { name: m.name, last: 0n, before: 0n };
    if (m.month === last) entry.last += m.amountPaise;
    if (m.month === before) entry.before += m.amountPaise;
    byCode.set(m.code, entry);
  }
  let best: { name: string; change: Change; nowPaise: bigint; month: string } | null = null;
  for (const e of byCode.values()) {
    if (e.before <= 0n || e.last - e.before < 1_000_00n) continue;
    const change = percentChange(e.last, e.before);
    if (!change || change.tenths < 150) continue;
    if (!best || change.tenths > best.change.tenths) {
      best = { name: e.name, change, nowPaise: e.last, month: monthLabel(last) };
    }
  }
  return best;
}

export function insights(input: InsightInput): Insight[] {
  const f = input.formatAmount;
  const out: Insight[] = [];

  // 1. Revenue against expenses, for the last two complete months.
  const last = addMonths(input.today, -1);
  const before = addMonths(input.today, -2);
  const sumMonth = (start: string, key: 'revenue' | 'expenses') =>
    input.points
      .filter((p) => p.date >= start && p.date <= monthEnd(start))
      .reduce((s, p) => s + BigInt(p[key]), 0n);
  const revLast = sumMonth(last, 'revenue');
  const revBefore = sumMonth(before, 'revenue');
  const expLast = sumMonth(last, 'expenses');
  const expBefore = sumMonth(before, 'expenses');
  const rev = percentChange(revLast, revBefore);
  const exp = percentChange(expLast, expBefore);
  if (rev && revLast > 0n && revBefore > 0n) {
    const direction = rev.tenths >= 0 ? 'rose' : 'fell';
    const marginLast = revLast > 0n ? Number(((revLast - expLast) * 1000n) / revLast) : null;
    const marginBefore = revBefore > 0n ? Number(((revBefore - expBefore) * 1000n) / revBefore) : null;
    let why = `${f(revBefore)} in ${monthLabel(before)} to ${f(revLast)} in ${monthLabel(last)}.`;
    if (exp && exp.tenths - rev.tenths >= 50 && marginLast !== null && marginBefore !== null) {
      why = `Expenses grew faster (${exp.text}), so the operating margin moved from ${formatTenths(marginBefore).replace('+', '')} to ${formatTenths(marginLast).replace('+', '')}.`;
    }
    out.push({
      title: `Revenue ${direction} ${rev.text.replace(/^[+−]/, '')} in ${monthLabel(last)}`,
      why,
      action: { label: 'Profit and loss', href: '/output#profit-and-loss' },
    });
  }

  // 2. Overdue receivables concentrated in a few customers.
  const overdueParties = input.receivableParties
    .filter((p) => p.overduePaise > 0n)
    .sort((a, b) => Number(b.overduePaise - a.overduePaise));
  if (overdueParties.length === 1 && input.receivableOverduePaise > 0n) {
    out.push({
      title: `${overdueParties[0]!.partyName} holds all overdue receivables`,
      why: `${f(input.receivableOverduePaise)} is past due from one customer.`,
      action: { label: 'See receivables', href: '#receivables' },
    });
  } else if (overdueParties.length > 3) {
    const top = overdueParties.slice(0, 3);
    const share = sharePercent(
      top.reduce((s, p) => s + p.overduePaise, 0n),
      input.receivableOverduePaise,
    );
    if (share >= 50) {
      out.push({
        title: `${top.length} customers hold ${share}% of overdue receivables`,
        why: `Collecting from ${top.map((p) => p.partyName).join(', ')} clears most of ${f(input.receivableOverduePaise)} overdue.`,
        action: { label: 'See receivables', href: '#receivables' },
      });
    }
  }

  // 3. Cash projected below zero.
  const negative = input.outlook.find((m) => m.forecast && m.balancePaise < 0);
  if (negative) {
    out.push({
      title: `Cash could fall below zero in ${negative.label}`,
      why: 'Bills due by then exceed cash in hand plus invoices due, on current due dates.',
      action: { label: 'See payables', href: '#payables' },
    });
  }

  // 4. An expense line that jumped.
  const anomaly = expenseAnomaly(input.expenseMonths, input.today);
  if (anomaly) {
    out.push({
      title: `${anomaly.name} up ${anomaly.change.text.replace('+', '')} in ${anomaly.month}`,
      why: `${f(anomaly.nowPaise)} against the month before.`,
      action: { label: 'Expense ledger', href: '/output#trial-balance' },
    });
  }

  // 5. Revenue resting on one customer.
  const topCustomer = input.topCustomers[0];
  if (topCustomer && input.topCustomers.length >= 2 && input.revenuePaise > 0n) {
    const share = sharePercent(topCustomer.amountPaise, input.revenuePaise);
    if (share >= 40) {
      out.push({
        title: `${topCustomer.name} is ${share}% of revenue`,
        why: 'A single customer carrying this much revenue is a concentration risk.',
        action: { label: 'Sales register', href: '/output#sales-register' },
      });
    }
  }

  return out;
}

// ── ranking helpers ──────────────────────────────────────────────────────────

/** Top parties by amount from register rows, notes netted off. */
export function topParties(
  rows: readonly { partyName: string | null; taxablePaise: bigint }[],
  limit = 5,
): { name: string; amountPaise: bigint }[] {
  const by = new Map<string, bigint>();
  for (const r of rows) {
    const name = r.partyName ?? 'No party';
    by.set(name, (by.get(name) ?? 0n) + r.taxablePaise);
  }
  return [...by.entries()]
    .map(([name, amountPaise]) => ({ name, amountPaise }))
    .filter((p) => p.amountPaise > 0n)
    .sort((a, b) => (b.amountPaise > a.amountPaise ? 1 : b.amountPaise < a.amountPaise ? -1 : 0))
    .slice(0, limit);
}
