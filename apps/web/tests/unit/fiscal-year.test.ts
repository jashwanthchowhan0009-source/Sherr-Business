import { describe, expect, it } from 'vitest';
import {
  fiscalYearOf,
  fyLabelFor,
  isInFiscalYear,
  parseDateParts,
} from '../../src/lib/accounting/fiscal-year';

describe('parseDateParts', () => {
  it('reads a valid date', () => {
    expect(parseDateParts('2025-04-01')).toEqual({ year: 2025, month: 4, day: 1 });
  });

  it.each(['2025-4-1', '01-04-2025', '2025/04/01', '', 'today', '2025-04-01T00:00:00Z'])(
    'rejects %s',
    (bad) => {
      expect(() => parseDateParts(bad)).toThrow(/YYYY-MM-DD/);
    },
  );

  it('rejects an impossible day rather than rolling it over', () => {
    expect(() => parseDateParts('2025-02-29')).toThrow(/Day out of range/);
    expect(() => parseDateParts('2025-04-31')).toThrow(/Day out of range/);
    expect(() => parseDateParts('2025-13-01')).toThrow(/Month out of range/);
  });

  it('accepts 29 February in a leap year', () => {
    expect(parseDateParts('2024-02-29').day).toBe(29);
    // 2000 is a leap year, 1900 is not — the century rule, not just % 4.
    expect(() => parseDateParts('2000-02-29')).not.toThrow();
    expect(() => parseDateParts('1900-02-29')).toThrow();
  });
});

describe('fiscalYearOf (April start)', () => {
  it('puts 1 April in the year that starts that day', () => {
    const fy = fiscalYearOf('2025-04-01');
    expect(fy.label).toBe('25-26');
    expect(fy.startDate).toBe('2025-04-01');
    expect(fy.endDate).toBe('2026-03-31');
    expect(fy.longLabel).toBe('2025-26');
  });

  it('puts 31 March in the year that ends that day', () => {
    const fy = fiscalYearOf('2026-03-31');
    expect(fy.label).toBe('25-26');
    expect(fy.startYear).toBe(2025);
  });

  it('puts February in the previous calendar year’s financial year', () => {
    expect(fyLabelFor('2025-02-10')).toBe('24-25');
  });

  it('changes year between 31 March and 1 April, and nowhere else', () => {
    expect(fyLabelFor('2025-03-31')).toBe('24-25');
    expect(fyLabelFor('2025-04-01')).toBe('25-26');
  });

  it('spans a century boundary without producing a negative or 3-digit label', () => {
    expect(fiscalYearOf('2099-04-01').label).toBe('99-00');
    expect(fiscalYearOf('2100-04-01').label).toBe('00-01');
    expect(fiscalYearOf('2000-04-01').label).toBe('00-01');
  });

  it('ends on 29 February when the financial year ends in a leap February', () => {
    // A March-start year ending in February 2028, which is a leap year.
    expect(fiscalYearOf('2027-03-05', 3).endDate).toBe('2028-02-29');
    expect(fiscalYearOf('2026-03-05', 3).endDate).toBe('2027-02-28');
  });
});

describe('fiscalYearOf (other start months)', () => {
  it('treats a January start as a calendar year and labels it with one year', () => {
    const fy = fiscalYearOf('2025-07-15', 1);
    expect(fy.startDate).toBe('2025-01-01');
    expect(fy.endDate).toBe('2025-12-31');
    // '25-25' would read as a typo, so a calendar year gets a single label.
    expect(fy.label).toBe('2025');
    expect(fy.longLabel).toBe('2025');
  });

  it('handles a July start', () => {
    expect(fiscalYearOf('2025-06-30', 7).label).toBe('24-25');
    expect(fiscalYearOf('2025-07-01', 7).label).toBe('25-26');
    expect(fiscalYearOf('2025-07-01', 7).endDate).toBe('2026-06-30');
  });

  it('handles a December start, where the year is almost entirely the next one', () => {
    const fy = fiscalYearOf('2026-01-15', 12);
    expect(fy.startDate).toBe('2025-12-01');
    expect(fy.endDate).toBe('2026-11-30');
  });

  it('rejects a start month that is not a month', () => {
    for (const bad of [0, 13, -1, 1.5, Number.NaN]) {
      expect(() => fiscalYearOf('2025-04-01', bad)).toThrow(/start month/);
    }
  });
});

describe('isInFiscalYear', () => {
  const fy = fiscalYearOf('2025-04-01');

  it('includes both boundary days', () => {
    expect(isInFiscalYear('2025-04-01', fy)).toBe(true);
    expect(isInFiscalYear('2026-03-31', fy)).toBe(true);
  });

  it('excludes the day either side', () => {
    expect(isInFiscalYear('2025-03-31', fy)).toBe(false);
    expect(isInFiscalYear('2026-04-01', fy)).toBe(false);
  });

  it('agrees with fiscalYearOf for every month of a year', () => {
    for (let month = 1; month <= 12; month += 1) {
      const date = `2025-${String(month).padStart(2, '0')}-15`;
      expect(isInFiscalYear(date, fiscalYearOf(date))).toBe(true);
    }
  });
});
