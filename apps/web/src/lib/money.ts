/**
 * Money is an integer number of paise. Never a float, never a fraction of a paisa.
 *
 * Phase 1 has no money columns. This module exists now so that Phase 2 cannot
 * invent a second convention, and so the rule is enforced by the type system
 * rather than by review. See src/lib/db/columns.ts `paise()` for the column type.
 */

declare const paiseBrand: unique symbol;

/** An integer count of paise. 100 paise = ₹1. */
export type Paise = bigint & { readonly [paiseBrand]: true };

export function paise(value: bigint | number): Paise {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`Paise must be a whole number, received ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Paise value ${value} exceeds safe integer range; pass a bigint`);
    }
    return BigInt(value) as Paise;
  }
  return value as Paise;
}

export const ZERO = paise(0n);

/**
 * Parses a rupee string into paise. Accepts "1,23,456.78", "₹1234", "-45.5".
 * Rejects anything with more than two decimal places rather than rounding it,
 * because silently discarding a customer's third decimal is how reconciliations
 * end up one paisa out.
 */
export function rupeesToPaise(input: string): Paise {
  const cleaned = input.replace(/[₹,\s]/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new TypeError(`Cannot parse "${input}" as rupees`);
  }
  const negative = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const total = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  return paise(negative ? -total : total) as Paise;
}

/** Exact rupee string with two decimals and Indian digit grouping. */
export function formatRupees(value: Paise, opts: { symbol?: boolean } = {}): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  const grouped = groupIndian(whole.toString());
  return `${negative ? '-' : ''}${opts.symbol === false ? '' : '₹'}${grouped}.${frac}`;
}

/**
 * Compact form for dashboard cards: ₹24.5L, ₹1.2Cr. Display only — exports and
 * tooltips always use the exact value from formatRupees.
 *
 * Rounded in bigint arithmetic rather than by converting to a Number first:
 * (1.45).toFixed(1) is "1.4" in IEEE-754, so a float path would render
 * ₹1.45Cr as ₹1.4Cr. Half-up on exact integers gives ₹1.5Cr.
 */
const CRORE = 1_000_000_000n; // paise
const LAKH = 10_000_000n;
const THOUSAND = 100_000n;

export function formatCompact(value: Paise): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const sign = negative ? '-' : '';

  for (const [unit, suffix] of [
    [CRORE, 'Cr'],
    [LAKH, 'L'],
    [THOUSAND, 'K'],
  ] as const) {
    if (abs >= unit) return `${sign}₹${scale(abs, unit)}${suffix}`;
  }
  return `${sign}₹${halfUp(abs, 100n)}`;
}

/** One decimal below 100 of a unit, whole numbers above it. Half-up throughout. */
function scale(abs: bigint, unit: bigint): string {
  if (abs / unit >= 100n) return halfUp(abs, unit).toString();
  const tenths = halfUp(abs * 10n, unit);
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return frac === 0n ? whole.toString() : `${whole}.${frac}`;
}

const halfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator / 2n) / denominator;

/** Indian grouping: last three digits, then pairs. 12345678 -> 1,23,45,678 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

export const add = (a: Paise, b: Paise): Paise => paise(a + b);
export const subtract = (a: Paise, b: Paise): Paise => paise(a - b);
export const sum = (values: readonly Paise[]): Paise =>
  paise(values.reduce<bigint>((acc, v) => acc + v, 0n));
