/**
 * Receivables and payables ageing.
 *
 * The buckets are 0–30, 31–60, 61–90 and over 90 days, measured from the date
 * the document became due — not from the date it was raised. A customer on 45
 * days' credit whose invoice is 40 days old owes nothing yet, and putting that
 * invoice in the 31–60 bucket would make a healthy ledger look overdue.
 *
 * Pure, integer-only, and free of any `Date` arithmetic on the domain values:
 * dates arrive as `YYYY-MM-DD` because that is what a Postgres `date` holds, and
 * turning them into timestamps would introduce a timezone where there is none.
 * An invoice dated 1 April is dated 1 April wherever it is read.
 */
import { parseDateParts } from './fiscal-year';

export const AGEING_BUCKETS = ['current', '0-30', '31-60', '61-90', '90+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const AGEING_BUCKET_LABELS: Record<AgeingBucket, string> = {
  current: 'Not yet due',
  '0-30': '0–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': 'Over 90 days',
};

/** Days between two `YYYY-MM-DD` dates, by civil-date arithmetic. */
export function daysBetween(fromIso: string, toIso: string): number {
  return toDayNumber(toIso) - toDayNumber(fromIso);
}

/**
 * Days since the civil epoch, by Howard Hinnant's algorithm.
 *
 * Deliberately not `new Date(iso)`: that parses as UTC midnight and any later
 * local-time operation can shift the result by a day, which would move an
 * invoice between ageing buckets depending on where the report was run.
 */
function toDayNumber(iso: string): number {
  const { year, month, day } = parseDateParts(iso);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * The date a document falls due: its own date plus the credit days agreed with
 * the party. Zero credit days means due on the day it is raised.
 */
export function dueDate(documentDate: string, creditDays: number): string {
  if (!Number.isInteger(creditDays) || creditDays < 0) {
    throw new RangeError(`Credit days must be a whole number of days, got ${creditDays}`);
  }
  return fromDayNumber(toDayNumber(documentDate) + creditDays);
}

function fromDayNumber(days: number): string {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = month <= 2 ? y + 1 : y;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Which bucket a document sits in, as at `asOf`.
 *
 * `current` is a bucket of its own rather than being folded into 0–30, because
 * "not yet due" and "overdue by a week" are different facts and an owner
 * deciding who to chase needs them apart.
 */
export function bucketFor(input: {
  documentDate: string;
  creditDays: number;
  asOf: string;
}): AgeingBucket {
  const due = dueDate(input.documentDate, input.creditDays);
  const overdue = daysBetween(due, input.asOf);
  if (overdue < 0) return 'current';
  if (overdue <= 30) return '0-30';
  if (overdue <= 60) return '31-60';
  if (overdue <= 90) return '61-90';
  return '90+';
}

export interface AgeingRow {
  partyId: string;
  partyName: string;
  documentDate: string;
  creditDays: number;
  outstandingPaise: bigint;
}

export interface AgeingTotals {
  byBucket: Record<AgeingBucket, bigint>;
  totalPaise: bigint;
  overduePaise: bigint;
}

export interface PartyAgeing extends AgeingTotals {
  partyId: string;
  partyName: string;
  oldestDueDate: string | null;
}

const zeroBuckets = (): Record<AgeingBucket, bigint> => ({
  current: 0n,
  '0-30': 0n,
  '31-60': 0n,
  '61-90': 0n,
  '90+': 0n,
});

/** Totals one party's open documents into buckets. */
export function ageParty(
  rows: readonly AgeingRow[],
  asOf: string,
): AgeingTotals & { oldestDueDate: string | null } {
  const byBucket = zeroBuckets();
  let totalPaise = 0n;
  let overduePaise = 0n;
  let oldestDueDate: string | null = null;

  for (const row of rows) {
    const bucket = bucketFor({
      documentDate: row.documentDate,
      creditDays: row.creditDays,
      asOf,
    });
    byBucket[bucket] += row.outstandingPaise;
    totalPaise += row.outstandingPaise;
    if (bucket !== 'current') {
      overduePaise += row.outstandingPaise;
      const due = dueDate(row.documentDate, row.creditDays);
      if (oldestDueDate === null || due < oldestDueDate) oldestDueDate = due;
    }
  }

  return { byBucket, totalPaise, overduePaise, oldestDueDate };
}

/**
 * Groups open documents by party and buckets each.
 *
 * Sorted by the oldest overdue amount first, because that is the order an owner
 * reads it in: who has owed the longest, not who owes the most.
 */
export function ageByParty(rows: readonly AgeingRow[], asOf: string): PartyAgeing[] {
  const byParty = new Map<string, AgeingRow[]>();
  for (const row of rows) {
    const existing = byParty.get(row.partyId);
    if (existing) existing.push(row);
    else byParty.set(row.partyId, [row]);
  }

  const result: PartyAgeing[] = [];
  for (const [partyId, partyRows] of byParty) {
    const aged = ageParty(partyRows, asOf);
    result.push({
      partyId,
      partyName: partyRows[0]?.partyName ?? '',
      ...aged,
    });
  }

  return result.sort((a, b) => {
    if (a.oldestDueDate && b.oldestDueDate) {
      if (a.oldestDueDate !== b.oldestDueDate) return a.oldestDueDate < b.oldestDueDate ? -1 : 1;
    } else if (a.oldestDueDate) return -1;
    else if (b.oldestDueDate) return 1;
    return b.totalPaise > a.totalPaise ? 1 : b.totalPaise < a.totalPaise ? -1 : 0;
  });
}

/** Column totals across every party, for the foot of the report. */
export function ageingGrandTotal(parties: readonly PartyAgeing[]): AgeingTotals {
  const byBucket = zeroBuckets();
  let totalPaise = 0n;
  let overduePaise = 0n;

  for (const party of parties) {
    for (const bucket of AGEING_BUCKETS) byBucket[bucket] += party.byBucket[bucket];
    totalPaise += party.totalPaise;
    overduePaise += party.overduePaise;
  }

  return { byBucket, totalPaise, overduePaise };
}
