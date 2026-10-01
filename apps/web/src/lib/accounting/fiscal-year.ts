/**
 * Financial years.
 *
 * India's financial year normally runs 1 April to 31 March, but the start month
 * is a company setting rather than a constant — a company may be permitted a
 * different year, and the books-start date of a newly incorporated company
 * falls mid-year. Nothing here assumes April.
 *
 * Pure, and free of any timezone reasoning: dates arrive as `YYYY-MM-DD`
 * strings, which is what Postgres `date` columns hold. Parsing them into a
 * `Date` would introduce a timezone where the domain has none — an invoice
 * dated 1 April is dated 1 April regardless of where it is read.
 */

export interface FiscalYear {
  /** Calendar year the year starts in. */
  startYear: number;
  /** `YYYY-MM-DD` of the first day. */
  startDate: string;
  /** `YYYY-MM-DD` of the last day. */
  endDate: string;
  /** Short form used in voucher numbers: `25-26`. */
  label: string;
  /** Long form for reports: `2025-26`. */
  longLabel: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateParts(isoDate: string): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(isoDate);
  if (!match) throw new RangeError(`Not a YYYY-MM-DD date: ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) throw new RangeError(`Month out of range in ${isoDate}`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Day out of range in ${isoDate}`);
  }
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * The financial year a date falls in.
 *
 * `startMonth` is the company's setting: 4 for the usual April-to-March year.
 * A year starting in January is a calendar year, and its label is then a single
 * year rather than a span — `2025`, not `25-25`, because `25-25` reads as an
 * error.
 */
export function fiscalYearOf(isoDate: string, startMonth = 4): FiscalYear {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError(`Financial year start month must be 1-12, got ${startMonth}`);
  }
  const { year, month } = parseDateParts(isoDate);
  const startYear = month >= startMonth ? year : year - 1;

  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;

  return {
    startYear,
    startDate: `${startYear}-${pad(startMonth)}-01`,
    endDate: `${endYear}-${pad(endMonth)}-${pad(daysInMonth(endYear, endMonth))}`,
    label:
      startMonth === 1 ? String(startYear) : `${pad(startYear % 100)}-${pad(endYear % 100)}`,
    longLabel: startMonth === 1 ? String(startYear) : `${startYear}-${pad(endYear % 100)}`,
  };
}

/** Whether a date falls inside a given financial year. */
export function isInFiscalYear(isoDate: string, fy: FiscalYear): boolean {
  parseDateParts(isoDate);
  return isoDate >= fy.startDate && isoDate <= fy.endDate;
}

/**
 * The financial year label a voucher number should carry. A separate name from
 * `fiscalYearOf().label` because this is the value written into the database
 * and compared against on every duplicate check, so it is worth being explicit
 * at every call site about which one is meant.
 */
export function fyLabelFor(isoDate: string, startMonth = 4): string {
  return fiscalYearOf(isoDate, startMonth).label;
}
