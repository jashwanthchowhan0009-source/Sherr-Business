/**
 * Civil-date arithmetic on `YYYY-MM-DD` strings.
 *
 * Done in UTC throughout, so no local time zone can move a date by a day — the
 * same reason src/lib/accounting/ageing.ts avoids `new Date(iso)` in local time.
 */

function utc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return iso(utc(date) + days * 86_400_000);
}

export function daysFromTo(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: string, months: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** The same day a year earlier; 29 February maps to the 28th. */
export function yearBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = m === 2 && d === 29 ? 28 : d;
  return `${String(y - 1).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Last day of the month `date` falls in. */
export function monthEnd(date: string): string {
  return addDays(addMonths(date, 1), -1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct" or "Oct 26" — short labels for chart axes. */
export function monthLabel(date: string, withYear = false): string {
  const name = MONTHS[Number(date.slice(5, 7)) - 1] ?? '';
  return withYear ? `${name} ${date.slice(2, 4)}` : name;
}

export function dayLabel(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ''}`;
}
