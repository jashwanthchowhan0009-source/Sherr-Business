import { describe, expect, it } from 'vitest';
import {
  add, formatCompact, formatRupees, paise, rupeesToPaise, subtract, sum,
} from '../../src/lib/money';

describe('money', () => {
  it('stores rupees as integer paise', () => {
    expect(rupeesToPaise('1234.56')).toBe(123456n);
    expect(rupeesToPaise('₹1,23,456.78')).toBe(12345678n);
    expect(rupeesToPaise('-45.5')).toBe(-4550n);
    expect(rupeesToPaise('100')).toBe(10000n);
  });

  it('refuses a fractional paisa rather than rounding it away', () => {
    expect(() => rupeesToPaise('10.123')).toThrow(/Cannot parse/);
    expect(() => paise(10.5)).toThrow(/whole number/);
  });

  it('refuses input that is not a number', () => {
    for (const bad of ['', 'abc', '1.2.3', '1,00,000.', '--5']) {
      expect(() => rupeesToPaise(bad), bad).toThrow();
    }
  });

  it('formats with Indian digit grouping', () => {
    expect(formatRupees(paise(12345678n))).toBe('₹1,23,456.78');
    expect(formatRupees(paise(100n))).toBe('₹1.00');
    expect(formatRupees(paise(-123456n))).toBe('-₹1,234.56');
    expect(formatRupees(paise(123456n), { symbol: false })).toBe('1,234.56');
  });

  it('round-trips exactly, adding Indian grouping on the way out', () => {
    const cases: [input: string, formatted: string][] = [
      ['0.01', '0.01'],
      ['1.00', '1.00'],
      ['99999.99', '99,999.99'],
      ['1,23,45,678.90', '1,23,45,678.90'],
    ];
    for (const [input, formatted] of cases) {
      expect(formatRupees(rupeesToPaise(input), { symbol: false }), input).toBe(formatted);
    }
  });

  it('produces the compact form used on dashboard cards', () => {
    expect(formatCompact(rupeesToPaise('2450000'))).toBe('₹24.5L');
    expect(formatCompact(rupeesToPaise('12000000'))).toBe('₹1.2Cr');
    expect(formatCompact(rupeesToPaise('4800000'))).toBe('₹48L');
    expect(formatCompact(rupeesToPaise('1620100'))).toBe('₹16.2L');
    // Past 100 of a unit the decimal stops earning its place.
    expect(formatCompact(rupeesToPaise('14500000'))).toBe('₹1.5Cr');
    expect(formatCompact(rupeesToPaise('-354000'))).toBe('-₹3.5L');
  });

  it('adds without floating point drift', () => {
    const tenth = rupeesToPaise('0.10');
    const total = sum(Array.from({ length: 10 }, () => tenth));
    expect(formatRupees(total)).toBe('₹1.00');
    expect(add(paise(1n), paise(2n))).toBe(3n);
    expect(subtract(paise(1n), paise(2n))).toBe(-1n);
  });

  it('handles values beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = paise(9_007_199_254_740_993n);
    expect(formatRupees(huge, { symbol: false })).toBe('9,00,71,99,25,47,409.93');
  });
});
