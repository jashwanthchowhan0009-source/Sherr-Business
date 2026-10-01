import { describe, expect, it } from 'vitest';
import {
  BPS_SCALE,
  PAISE_PER_RUPEE,
  QTY_SCALE,
  bpsToPercent,
  divideHalfUp,
  formatQuantity,
  parseQuantity,
  parseRupees,
  percentToBps,
} from '../../src/lib/accounting/units';

describe('parseRupees', () => {
  it('reads whole rupees', () => {
    expect(parseRupees('1')).toBe(100n);
    expect(parseRupees('100000')).toBe(10_000_000n);
    expect(parseRupees('0')).toBe(0n);
  });

  it('reads paise exactly, where a float would not', () => {
    // Number('0.07') * 100 is 7.000000000000001. This path has no float in it.
    expect(parseRupees('0.07')).toBe(7n);
    expect(parseRupees('0.1')).toBe(10n);
    expect(parseRupees('1.15')).toBe(115n);
    expect(parseRupees('8.29')).toBe(829n);
    expect(parseRupees('1234.56')).toBe(123_456n);
  });

  it('agrees with integer arithmetic across every paise value in a rupee', () => {
    for (let p = 0; p < 100; p += 1) {
      const text = `1.${String(p).padStart(2, '0')}`;
      expect(parseRupees(text), text).toBe(100n + BigInt(p));
    }
  });

  it('tolerates the way people actually type amounts', () => {
    expect(parseRupees(' 1,00,000 ')).toBe(10_000_000n);
    expect(parseRupees('₹500')).toBe(50_000n);
    expect(parseRupees('1,234.50')).toBe(123_450n);
  });

  it('treats an empty string as zero rather than as an error', () => {
    expect(parseRupees('')).toBe(0n);
    expect(parseRupees('   ')).toBe(0n);
  });

  it('handles negatives, which credit notes need', () => {
    expect(parseRupees('-1')).toBe(-100n);
    expect(parseRupees('-0.05')).toBe(-5n);
  });

  it('rejects anything finer than a paisa instead of rounding it away', () => {
    expect(() => parseRupees('1.234')).toThrow(/rupees/);
    expect(() => parseRupees('0.001')).toThrow(/rupees/);
  });

  it.each(['abc', '1.2.3', '1e5', '--1', '1-', 'NaN', 'Infinity', '.', '1.'])(
    'rejects %s',
    (bad) => {
      expect(() => parseRupees(bad)).toThrow(/rupees/);
    },
  );

  it('survives an amount far beyond what a float could hold', () => {
    // ₹92,23,37,20,368.55 — past Number.MAX_SAFE_INTEGER once in paise.
    expect(parseRupees('92233720368.55')).toBe(9_223_372_036_855n);
  });
});

describe('divideHalfUp', () => {
  it('rounds a half away from zero in both directions', () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideHalfUp(7n, 2n)).toBe(4n);
    expect(divideHalfUp(-7n, 2n)).toBe(-4n);
  });

  it('leaves an exact division alone', () => {
    expect(divideHalfUp(100n, 4n)).toBe(25n);
    expect(divideHalfUp(0n, 7n)).toBe(0n);
  });

  it('rounds below a half down', () => {
    expect(divideHalfUp(4n, 3n)).toBe(1n);
    expect(divideHalfUp(-4n, 3n)).toBe(-1n);
  });

  it('is symmetric about zero for every numerator over a fixed denominator', () => {
    for (let n = -50; n <= 50; n += 1) {
      expect(divideHalfUp(BigInt(n), 7n)).toBe(-divideHalfUp(BigInt(-n), 7n));
    }
  });

  it('refuses to divide by zero', () => {
    expect(() => divideHalfUp(1n, 0n)).toThrow(/divide by zero/);
  });
});

describe('parseQuantity and formatQuantity', () => {
  it('round-trips four decimal places', () => {
    for (const text of ['1', '2.5', '0.0001', '1000.1234', '0.5']) {
      expect(formatQuantity(parseQuantity(text))).toBe(text);
    }
  });

  it('scales by QTY_SCALE', () => {
    expect(parseQuantity('1')).toBe(QTY_SCALE);
    expect(parseQuantity('2.5')).toBe(25_000n);
  });

  it('rejects a fifth decimal place rather than truncating it', () => {
    expect(() => parseQuantity('1.00001')).toThrow(/quantity/);
  });

  it('formats without a trailing zero', () => {
    expect(formatQuantity(25_000n)).toBe('2.5');
    expect(formatQuantity(QTY_SCALE)).toBe('1');
  });
});

describe('percentToBps and bpsToPercent', () => {
  it('converts the GST slabs exactly', () => {
    expect(percentToBps(18)).toBe(1800);
    expect(percentToBps('0.25')).toBe(25);
    expect(percentToBps(2.5)).toBe(250);
    expect(bpsToPercent(1800)).toBe('18');
    expect(bpsToPercent(25)).toBe('0.25');
  });

  it('round-trips every slab', () => {
    for (const bps of [0, 25, 300, 500, 1200, 1800, 2800, 4000]) {
      expect(percentToBps(bpsToPercent(bps))).toBe(bps);
    }
  });
});

describe('scale constants', () => {
  it('are the values the engines assume', () => {
    expect(QTY_SCALE).toBe(10_000n);
    expect(BPS_SCALE).toBe(10_000n);
    expect(PAISE_PER_RUPEE).toBe(100n);
  });
});
