import { describe, expect, it } from 'vitest';
import {
  attentionItems, bucketsFor, cashOutlook, expenseAnomaly, insights, percentChange, sharePercent,
  summariseDue, toDayPoints, topParties, type AttentionInput, type OpenDocument,
} from '../../src/lib/dashboard/model';
import { addDays, addMonths, monthEnd, yearBefore } from '../../src/lib/dashboard/dates';

const fmt = (p: bigint) => `₹${(p / 100n).toString()}`;
const TODAY = '2026-10-08';

const doc = (over: Partial<OpenDocument>): OpenDocument => ({
  voucherId: 'v',
  voucherNo: 'INV/26-27/0001',
  partyName: 'Anand',
  voucherDate: TODAY,
  creditDays: 0,
  outstandingPaise: 100_00n,
  ...over,
});

const day = (date: string, over: Partial<Record<'revenue' | 'expense' | 'income' | 'in' | 'out', bigint>> = {}) => ({
  date,
  revenuePaise: over.revenue ?? 0n,
  incomePaise: over.income ?? over.revenue ?? 0n,
  expensePaise: over.expense ?? 0n,
  cashInPaise: over.in ?? 0n,
  cashOutPaise: over.out ?? 0n,
});

describe('dates', () => {
  it('does civil arithmetic without a time zone', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addMonths('2026-01-31', -2)).toBe('2025-11-01');
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(yearBefore('2024-02-29')).toBe('2023-02-28');
  });
});

describe('percentChange', () => {
  it('rounds to one decimal, half away from zero, in integers', () => {
    expect(percentChange(114_2n, 100_0n)?.text).toBe('+14.2%');
    expect(percentChange(96_8n, 100_0n)?.text).toBe('−3.2%');
    expect(percentChange(1n, 3n)?.tenths).toBe(-667);
  });

  it('refuses to compare against nothing', () => {
    expect(percentChange(500n, 0n)).toBeNull();
  });

  it('measures change against the size of a negative base', () => {
    // From a ₹100 loss to a ₹50 loss is an improvement.
    expect(percentChange(-50n, -100n)?.tenths).toBe(500);
  });

  it('gives shares in whole percent', () => {
    expect(sharePercent(61n, 100n)).toBe(61);
    expect(sharePercent(1n, 3n)).toBe(33);
    expect(sharePercent(5n, 0n)).toBe(0);
  });
});

describe('summariseDue', () => {
  const docs = [
    doc({ voucherId: 'a', voucherDate: '2026-09-01', creditDays: 7, outstandingPaise: 300_00n }), // due 8 Sep, 30d late
    doc({ voucherId: 'b', voucherDate: '2026-10-01', creditDays: 0, outstandingPaise: 200_00n }), // due 1 Oct, 7d late
    doc({ voucherId: 'c', voucherDate: '2026-10-05', creditDays: 5, outstandingPaise: 50_00n }), // due 10 Oct
    doc({ voucherId: 'd', voucherDate: '2026-10-08', creditDays: 20, outstandingPaise: 70_00n }), // due 28 Oct
    doc({ voucherId: 'e', voucherDate: '2026-10-08', creditDays: 45, outstandingPaise: 90_00n }), // due Nov
  ];
  const s = summariseDue(docs, TODAY, 1);

  it('splits what is owed by when it falls due', () => {
    expect(s.totalPaise).toBe(710_00n);
    expect(s.overduePaise).toBe(500_00n);
    expect(s.overdueCount).toBe(2);
    expect(s.dueThisWeekPaise).toBe(50_00n);
    expect(s.dueThisMonthPaise).toBe(120_00n);
  });

  it('lists the oldest debt first', () => {
    expect(s.overdue.map((d) => [d.voucherId, d.daysOverdue])).toEqual([['a', 30]]);
  });
});

describe('bucketsFor', () => {
  const points = toDayPoints([
    day('2026-10-08', { revenue: 10n }),
    day('2026-10-02', { revenue: 5n, expense: 2n }),
    day('2026-05-15', { revenue: 7n }),
  ]);

  it('keeps every day in a short range, even empty ones', () => {
    const b = bucketsFor('7D', points, TODAY);
    expect(b).toHaveLength(7);
    expect(b[6]!.revenue).toBe(10);
    expect(b[0]!.start).toBe('2026-10-02');
    expect(b[0]!.profit).toBe(3);
  });

  it('uses calendar months for the long ranges', () => {
    const b = bucketsFor('6M', points, TODAY);
    expect(b.map((x) => x.label)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(b[0]!.revenue).toBe(7);
    expect(b[5]!.revenue).toBe(15);
  });
});

describe('cashOutlook', () => {
  it('walks actual balances back from today and projects from due dates', () => {
    const points = toDayPoints([day('2026-10-03', { in: 400n, out: 100n }), day('2026-09-10', { in: 200n })]);
    const months = cashOutlook({
      points,
      cashNowPaise: 1_000n,
      receivables: [doc({ voucherDate: '2026-09-01', outstandingPaise: 300n }), doc({ voucherDate: '2026-11-20', outstandingPaise: 50n })],
      payables: [doc({ voucherDate: '2026-12-05', outstandingPaise: 2_000n })],
      today: TODAY,
    });
    const actual = months.filter((m) => !m.forecast);
    expect(actual).toHaveLength(6);
    expect(actual[5]!.balancePaise).toBe(1_000); // October, as at today
    expect(actual[4]!.balancePaise).toBe(700); // end of September
    const ahead = months.filter((m) => m.forecast);
    expect(ahead.map((m) => m.label)).toEqual(['Nov', 'Dec', 'Jan']);
    // The overdue invoice is owed now, so it lands in the first projected month.
    expect(ahead[0]!.inPaise).toBe(350);
    expect(ahead[1]!.balancePaise).toBe(1_350 - 2_000);
  });
});

describe('attentionItems', () => {
  const base: AttentionInput = {
    today: TODAY,
    ledgerOutPaise: 0n,
    receivable: summariseDue([], TODAY),
    payable: summariseDue([], TODAY),
    gstPayablePaise: 0n,
    draftVouchers: 0,
    unlinkedDocuments: 0,
    unmatchedBankLines: 0,
    openPurchaseOrders: 0,
    closingStockMissing: false,
    hasPurchases: false,
    membersWithoutMfa: 0,
    formatAmount: fmt,
  };

  it('is empty when nothing is wrong', () => {
    expect(attentionItems(base)).toEqual([]);
  });

  it('names each overdue invoice and links to it, critical ones first', () => {
    const items = attentionItems({
      ...base,
      draftVouchers: 2,
      receivable: summariseDue(
        [doc({ voucherId: 'x', voucherNo: 'INV/26-27/0048', voucherDate: '2026-09-01', outstandingPaise: 84_500_00n })],
        TODAY,
      ),
    });
    expect(items[0]).toMatchObject({
      tone: 'crit',
      title: 'INV/26-27/0048 · Anand',
      detail: '₹84500 overdue by 37 days',
      href: '/api/invoices/x/pdf',
    });
    expect(items[1]!.title).toBe('2 draft entries');
  });

  it('only flags missing closing stock for a company that buys stock', () => {
    expect(attentionItems({ ...base, closingStockMissing: true })).toEqual([]);
    expect(attentionItems({ ...base, closingStockMissing: true, hasPurchases: true })[0]!.title).toBe(
      'Closing stock not entered',
    );
  });
});

describe('insights', () => {
  const quiet = {
    today: TODAY,
    points: [],
    receivableParties: [],
    receivableOverduePaise: 0n,
    outlook: [],
    expenseMonths: [],
    topCustomers: [],
    revenuePaise: 0n,
    formatAmount: fmt,
  };

  it('says nothing it cannot support', () => {
    expect(insights(quiet)).toEqual([]);
  });

  it('compares the last two complete months and explains a margin squeeze', () => {
    const points = toDayPoints([
      day('2026-08-10', { revenue: 1_000_00n, expense: 600_00n }),
      day('2026-09-10', { revenue: 1_142_00n, expense: 900_00n }),
      // The current, partial month is ignored.
      day('2026-10-02', { revenue: 9_999_00n }),
    ]);
    const [first] = insights({ ...quiet, points });
    expect(first!.title).toBe('Revenue rose 14.2% in Sep');
    expect(first!.why).toMatch(/Expenses grew faster \(\+50\.0%\)/);
    expect(first!.why).toMatch(/from 40\.0% to 21\.1%/);
  });

  it('notices overdue receivables concentrated in a few customers', () => {
    const out = insights({
      ...quiet,
      receivableOverduePaise: 100n,
      receivableParties: [
        { partyName: 'A', overduePaise: 40n, totalPaise: 40n },
        { partyName: 'B', overduePaise: 21n, totalPaise: 21n },
        { partyName: 'C', overduePaise: 10n, totalPaise: 10n },
        { partyName: 'D', overduePaise: 29n, totalPaise: 29n },
      ],
    });
    expect(out[0]!.title).toBe('3 customers hold 90% of overdue receivables');
  });

  it('warns when projected cash goes below zero', () => {
    const out = insights({
      ...quiet,
      outlook: [{ label: 'Dec', inPaise: 0, outPaise: 10, balancePaise: -5, forecast: true }],
    });
    expect(out[0]!.title).toBe('Cash could fall below zero in Dec');
  });
});

describe('expenseAnomaly', () => {
  it('ignores small or slight rises', () => {
    expect(
      expenseAnomaly(
        [
          { month: '2026-08-01', code: 'RENT', name: 'Rent', amountPaise: 10_000_00n },
          { month: '2026-09-01', code: 'RENT', name: 'Rent', amountPaise: 11_000_00n },
        ],
        TODAY,
      ),
    ).toBeNull();
  });

  it('reports the biggest notable rise last month', () => {
    const a = expenseAnomaly(
      [
        { month: '2026-08-01', code: 'RENT', name: 'Rent', amountPaise: 10_000_00n },
        { month: '2026-09-01', code: 'RENT', name: 'Rent', amountPaise: 11_800_00n },
      ],
      TODAY,
    );
    expect(a).toMatchObject({ name: 'Rent', month: 'Sep' });
    expect(a!.change.text).toBe('+18.0%');
  });
});

describe('topParties', () => {
  it('nets notes off and drops parties left at nothing', () => {
    expect(
      topParties([
        { partyName: 'A', taxablePaise: 100n },
        { partyName: 'B', taxablePaise: 300n },
        { partyName: 'A', taxablePaise: -100n },
        { partyName: 'C', taxablePaise: 50n },
      ]),
    ).toEqual([
      { name: 'B', amountPaise: 300n },
      { name: 'C', amountPaise: 50n },
    ]);
  });
});
