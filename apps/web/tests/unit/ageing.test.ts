import { describe, expect, it } from 'vitest';
import {
  AGEING_BUCKETS,
  ageByParty,
  ageParty,
  ageingGrandTotal,
  bucketFor,
  daysBetween,
  dueDate,
  type AgeingRow,
} from '../../src/lib/accounting/ageing';

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2025-06-01', '2025-06-01')).toBe(0);
    expect(daysBetween('2025-06-01', '2025-06-02')).toBe(1);
    expect(daysBetween('2025-06-01', '2025-07-01')).toBe(30);
  });

  it('is negative when the second date is earlier', () => {
    expect(daysBetween('2025-06-02', '2025-06-01')).toBe(-1);
  });

  it('crosses month, year and leap boundaries', () => {
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // 2024 is a leap year
    expect(daysBetween('2025-02-28', '2025-03-01')).toBe(1);
    expect(daysBetween('2000-02-28', '2000-03-01')).toBe(2); // century leap year
    expect(daysBetween('1900-02-28', '1900-03-01')).toBe(1); // not a leap year
  });

  it('agrees with a year of consecutive days', () => {
    // Walks every day of 2025 and checks each step is exactly one.
    let date = '2025-01-01';
    for (let i = 0; i < 364; i += 1) {
      const next = dueDate(date, 1);
      expect(daysBetween(date, next), `${date} to ${next}`).toBe(1);
      date = next;
    }
    expect(date).toBe('2025-12-31');
  });
});

describe('dueDate', () => {
  it('is the document date when no credit is given', () => {
    expect(dueDate('2025-06-15', 0)).toBe('2025-06-15');
  });

  it('adds the credit days', () => {
    expect(dueDate('2025-06-15', 30)).toBe('2025-07-15');
    expect(dueDate('2025-06-15', 45)).toBe('2025-07-30');
  });

  it('crosses a year end', () => {
    expect(dueDate('2025-12-20', 30)).toBe('2026-01-19');
  });

  it('handles February in a leap year', () => {
    expect(dueDate('2024-02-01', 29)).toBe('2024-03-01');
    expect(dueDate('2025-02-01', 28)).toBe('2025-03-01');
  });

  it('refuses nonsense credit terms', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => dueDate('2025-06-15', bad)).toThrow(/whole number of days/);
    }
  });
});

describe('bucketFor', () => {
  // An invoice raised 1 June, on 30 days' credit, falls due 1 July.
  const invoice = { documentDate: '2025-06-01', creditDays: 30 };

  it('is "not yet due" before the due date', () => {
    expect(bucketFor({ ...invoice, asOf: '2025-06-30' })).toBe('current');
  });

  it('enters 0–30 on the due date itself', () => {
    expect(bucketFor({ ...invoice, asOf: '2025-07-01' })).toBe('0-30');
  });

  it('respects the exact bucket boundaries', () => {
    expect(bucketFor({ ...invoice, asOf: '2025-07-31' })).toBe('0-30'); // 30 days
    expect(bucketFor({ ...invoice, asOf: '2025-08-01' })).toBe('31-60'); // 31 days
    expect(bucketFor({ ...invoice, asOf: '2025-08-30' })).toBe('31-60'); // 60 days
    expect(bucketFor({ ...invoice, asOf: '2025-08-31' })).toBe('61-90'); // 61
    expect(bucketFor({ ...invoice, asOf: '2025-09-29' })).toBe('61-90'); // 90
    expect(bucketFor({ ...invoice, asOf: '2025-09-30' })).toBe('90+'); // 91
  });

  it('ages from the due date, not from the invoice date', () => {
    // The whole point. A customer on 45 days whose invoice is 40 days old owes
    // nothing yet; ageing from the invoice date would show them as overdue.
    const generous = { documentDate: '2025-06-01', creditDays: 45, asOf: '2025-07-11' };
    expect(daysBetween('2025-06-01', '2025-07-11')).toBe(40);
    expect(bucketFor(generous)).toBe('current');
  });

  it('treats a cash sale as due immediately', () => {
    expect(bucketFor({ documentDate: '2025-06-01', creditDays: 0, asOf: '2025-06-01' })).toBe('0-30');
  });
});

describe('ageParty', () => {
  const rows: AgeingRow[] = [
    { partyId: 'p1', partyName: 'Anand', documentDate: '2025-01-01', creditDays: 30, outstandingPaise: 1_00_000_00n },
    { partyId: 'p1', partyName: 'Anand', documentDate: '2025-05-01', creditDays: 30, outstandingPaise: 50_000_00n },
    { partyId: 'p1', partyName: 'Anand', documentDate: '2025-06-20', creditDays: 30, outstandingPaise: 25_000_00n },
  ];

  it('places each document in its own bucket', () => {
    // As at 1 July 2025: due 31 Jan (151 days), 31 May (31 days), 20 Jul (not due).
    const aged = ageParty(rows, '2025-07-01');
    expect(aged.byBucket['90+']).toBe(1_00_000_00n);
    expect(aged.byBucket['31-60']).toBe(50_000_00n);
    expect(aged.byBucket.current).toBe(25_000_00n);
    expect(aged.byBucket['0-30']).toBe(0n);
  });

  it('totals to the sum of its parts', () => {
    const aged = ageParty(rows, '2025-07-01');
    const summed = AGEING_BUCKETS.reduce((acc, b) => acc + aged.byBucket[b], 0n);
    expect(summed).toBe(aged.totalPaise);
    expect(aged.totalPaise).toBe(1_75_000_00n);
  });

  it('counts only overdue amounts as overdue', () => {
    const aged = ageParty(rows, '2025-07-01');
    expect(aged.overduePaise).toBe(1_50_000_00n);
    expect(aged.totalPaise - aged.overduePaise).toBe(25_000_00n);
  });

  it('reports the oldest overdue due date, ignoring what is not yet due', () => {
    expect(ageParty(rows, '2025-07-01').oldestDueDate).toBe('2025-01-31');
  });

  it('has no oldest due date when nothing is overdue', () => {
    expect(ageParty(rows, '2025-01-15').oldestDueDate).toBeNull();
    expect(ageParty(rows, '2025-01-15').overduePaise).toBe(0n);
  });

  it('handles an empty ledger', () => {
    const aged = ageParty([], '2025-07-01');
    expect(aged.totalPaise).toBe(0n);
    expect(aged.oldestDueDate).toBeNull();
  });
});

describe('ageByParty', () => {
  const rows: AgeingRow[] = [
    { partyId: 'recent', partyName: 'Recent Ltd', documentDate: '2025-06-01', creditDays: 0, outstandingPaise: 9_00_000_00n },
    { partyId: 'oldest', partyName: 'Oldest Ltd', documentDate: '2025-01-01', creditDays: 0, outstandingPaise: 1_000_00n },
    { partyId: 'notdue', partyName: 'Not Due Ltd', documentDate: '2025-07-01', creditDays: 60, outstandingPaise: 5_00_000_00n },
  ];

  it('puts whoever has owed the longest first, not whoever owes the most', () => {
    // An owner reads this to decide who to chase; the small, very old debt is
    // the one that needs a phone call.
    const aged = ageByParty(rows, '2025-07-10');
    expect(aged.map((p) => p.partyId)).toEqual(['oldest', 'recent', 'notdue']);
  });

  it('groups every document of one party together', () => {
    const aged = ageByParty(
      [...rows, { ...rows[0]!, outstandingPaise: 1_00_000_00n }],
      '2025-07-10',
    );
    expect(aged.find((p) => p.partyId === 'recent')?.totalPaise).toBe(10_00_000_00n);
  });

  it('sorts parties with nothing overdue to the end, by size', () => {
    const aged = ageByParty(
      [
        { partyId: 'a', partyName: 'A', documentDate: '2025-07-01', creditDays: 60, outstandingPaise: 100_00n },
        { partyId: 'b', partyName: 'B', documentDate: '2025-07-01', creditDays: 60, outstandingPaise: 900_00n },
      ],
      '2025-07-10',
    );
    expect(aged.map((p) => p.partyId)).toEqual(['b', 'a']);
  });
});

describe('ageingGrandTotal', () => {
  it('adds the columns down', () => {
    const rows: AgeingRow[] = [
      { partyId: 'p1', partyName: 'One', documentDate: '2025-01-01', creditDays: 0, outstandingPaise: 1_000_00n },
      { partyId: 'p2', partyName: 'Two', documentDate: '2025-01-01', creditDays: 0, outstandingPaise: 2_000_00n },
      { partyId: 'p3', partyName: 'Three', documentDate: '2025-07-05', creditDays: 30, outstandingPaise: 3_000_00n },
    ];
    const total = ageingGrandTotal(ageByParty(rows, '2025-07-10'));
    expect(total.byBucket['90+']).toBe(3_000_00n);
    expect(total.byBucket.current).toBe(3_000_00n);
    expect(total.totalPaise).toBe(6_000_00n);
    expect(total.overduePaise).toBe(3_000_00n);
  });

  it('is zero for no parties', () => {
    expect(ageingGrandTotal([]).totalPaise).toBe(0n);
  });
});
