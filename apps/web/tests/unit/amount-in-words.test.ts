import { describe, expect, it } from 'vitest';
import { amountInWords, numberToIndianWords } from '../../src/lib/accounting/amount-in-words';

describe('numberToIndianWords', () => {
  it('handles the small cases', () => {
    expect(numberToIndianWords(0n)).toBe('zero');
    expect(numberToIndianWords(1n)).toBe('one');
    expect(numberToIndianWords(7n)).toBe('seven');
    expect(numberToIndianWords(10n)).toBe('ten');
    expect(numberToIndianWords(19n)).toBe('nineteen');
    expect(numberToIndianWords(20n)).toBe('twenty');
    expect(numberToIndianWords(21n)).toBe('twenty one');
    expect(numberToIndianWords(99n)).toBe('ninety nine');
  });

  it('handles hundreds', () => {
    expect(numberToIndianWords(100n)).toBe('one hundred');
    expect(numberToIndianWords(101n)).toBe('one hundred one');
    expect(numberToIndianWords(110n)).toBe('one hundred ten');
    expect(numberToIndianWords(999n)).toBe('nine hundred ninety nine');
  });

  it('groups in thousands, lakhs and crores — not millions', () => {
    expect(numberToIndianWords(1_000n)).toBe('one thousand');
    expect(numberToIndianWords(10_000n)).toBe('ten thousand');
    expect(numberToIndianWords(1_00_000n)).toBe('one lakh');
    expect(numberToIndianWords(10_00_000n)).toBe('ten lakh');
    expect(numberToIndianWords(1_00_00_000n)).toBe('one crore');
    // The number that would be "twelve million" in the Western system.
    expect(numberToIndianWords(1_23_45_678n)).toBe(
      'one crore twenty three lakh forty five thousand six hundred seventy eight',
    );
  });

  it('skips empty groups rather than saying "zero lakh"', () => {
    expect(numberToIndianWords(1_00_00_001n)).toBe('one crore one');
    expect(numberToIndianWords(1_00_000n)).toBe('one lakh');
    expect(numberToIndianWords(10_00_00_000n)).toBe('ten crore');
  });

  it('keeps counting in crore above a crore, as an Indian reader expects', () => {
    expect(numberToIndianWords(1_000_00_00_000n)).toBe('one thousand crore');
    expect(numberToIndianWords(1_00_000_00_00_000n)).toBe('one lakh crore');
  });

  // Every power of ten, which is where the scaling bug lived: the crore group
  // consumes two digits, so the remainder above it is in hundreds of crore and
  // reading it as crore is wrong by a factor of a hundred.
  it.each([
    [1n, 'one'],
    [10n, 'ten'],
    [100n, 'one hundred'],
    [1_000n, 'one thousand'],
    [10_000n, 'ten thousand'],
    [1_00_000n, 'one lakh'],
    [10_00_000n, 'ten lakh'],
    [1_00_00_000n, 'one crore'],
    [10_00_00_000n, 'ten crore'],
    [1_00_00_00_000n, 'one hundred crore'],
    [10_00_00_00_000n, 'one thousand crore'],
    [1_00_00_00_00_000n, 'ten thousand crore'],
    [10_00_00_00_00_000n, 'one lakh crore'],
    [1_00_00_00_00_00_000n, 'ten lakh crore'],
  ])('reads %s as %s', (value, expected) => {
    expect(numberToIndianWords(value)).toBe(expected);
  });

  it('handles a negative', () => {
    expect(numberToIndianWords(-500n)).toBe('minus five hundred');
  });

  it('never emits a double space or a trailing space', () => {
    for (let n = 0n; n < 2000n; n += 7n) {
      const words = numberToIndianWords(n);
      expect(words, String(n)).not.toMatch(/\s{2}/);
      expect(words, String(n)).toBe(words.trim());
    }
    for (const n of [1_00_000n, 1_00_00_000n, 10_00_00_000n, 1_23_45_678n]) {
      expect(numberToIndianWords(n)).not.toMatch(/\s{2}/);
    }
  });
});

describe('amountInWords', () => {
  it('prints the invoice line for the spec §11 total', () => {
    // ₹1,18,000 — the acceptance case total.
    expect(amountInWords(1_18_000_00n)).toBe(
      'Rupees One Lakh Eighteen Thousand Only',
    );
  });

  it('states paise only when there are any', () => {
    expect(amountInWords(100_00n)).toBe('Rupees One Hundred Only');
    expect(amountInWords(100_50n)).toBe('Rupees One Hundred and Fifty Paise Only');
    expect(amountInWords(1_07n)).toBe('Rupees One and Seven Paise Only');
  });

  it('closes with Only, so nothing can be appended to a printed figure', () => {
    for (const paise of [0n, 1n, 100n, 123_456_789n]) {
      expect(amountInWords(paise).endsWith(' Only')).toBe(true);
    }
  });

  it('titles every word, as an invoice prints it', () => {
    expect(amountInWords(1_23_45_678_00n)).toBe(
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only',
    );
  });

  it('handles zero and a credit note', () => {
    expect(amountInWords(0n)).toBe('Rupees Zero Only');
    expect(amountInWords(-500_00n)).toBe('Minus Rupees Five Hundred Only');
  });
});
