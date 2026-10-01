/**
 * Integer scales for the quantities and rates that money is computed from.
 *
 * Money is paise (src/lib/money.ts). Everything that multiplies into money is
 * an integer too, so no step of an invoice calculation ever touches a float.
 */

/** Quantities carry 4 decimal places: 2.5 kg is stored as 25000. */
export const QTY_SCALE = 10_000n;

/** Tax rates are basis points: 18% is 1800, 0.1% is 10. */
export const BPS_SCALE = 10_000n;

/** 100 paise to the rupee. */
export const PAISE_PER_RUPEE = 100n;

/**
 * Half-up division for positive and negative numerators alike.
 *
 * BigInt division truncates toward zero, so -5n / 2n is -2n. Indian invoicing
 * rounds half away from zero, which is what a human doing it by hand does, so
 * -2.5 becomes -3 rather than -2.
 */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('divide by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absN = numerator < 0n ? -numerator : numerator;
  const absD = denominator < 0n ? -denominator : denominator;
  const quotient = (absN * 2n + absD) / (absD * 2n);
  return negative ? -quotient : quotient;
}

/** Parses "2.5" or "2.5000" into scaled integer quantity. Rejects more than 4dp. */
export function parseQuantity(input: string): bigint {
  const cleaned = input.trim();
  if (!/^-?\d+(\.\d{1,4})?$/.test(cleaned)) {
    throw new TypeError(`Cannot parse "${input}" as a quantity (max 4 decimal places)`);
  }
  const negative = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const scaled = BigInt(whole) * QTY_SCALE + BigInt(frac.padEnd(4, '0'));
  return negative ? -scaled : scaled;
}

/**
 * Parses a rupee amount typed by a person into integer paise.
 *
 * Deliberately string-in, bigint-out with no `Number` anywhere on the path:
 * `Number("0.07") * 100` is 7.000000000000001, and a rounding step there would
 * be a rounding step in the middle of somebody's invoice. Two decimal places
 * is the limit because a paisa is the smallest unit that exists.
 */
export function parseRupees(input: string): bigint {
  const cleaned = input.trim().replace(/[\s,₹]/g, '');
  if (cleaned === '') return 0n;
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new TypeError(`Cannot read "${input}" as an amount in rupees`);
  }
  const negative = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const paise = BigInt(whole) * PAISE_PER_RUPEE + BigInt(frac.padEnd(2, '0'));
  return negative ? -paise : paise;
}

export function formatQuantity(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / QTY_SCALE;
  const frac = (abs % QTY_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parses "18" or "18.5" percent into basis points. */
export function percentToBps(input: string | number): number {
  const text = typeof input === 'number' ? String(input) : input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new TypeError(`Cannot parse "${input}" as a percentage`);
  }
  const [whole = '0', frac = ''] = text.split('.');
  return Number(BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0')));
}

export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
