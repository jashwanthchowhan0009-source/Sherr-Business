import { describe, expect, it } from 'vitest';
import {
  cellText,
  decimalPercent,
  decimalQuantity,
  decimalRupees,
  formatCell,
  looksLikeFormula,
  numeric,
  toCsv,
} from '@/lib/export/csv';

describe('decimalRupees', () => {
  it('writes paise as an exact two-place decimal', () => {
    expect(decimalRupees(0n).raw).toBe('0.00');
    expect(decimalRupees(1n).raw).toBe('0.01');
    expect(decimalRupees(10n).raw).toBe('0.10');
    expect(decimalRupees(100n).raw).toBe('1.00');
    expect(decimalRupees(123_456n).raw).toBe('1234.56');
  });

  it('keeps the sign on the whole amount, not on the paise', () => {
    expect(decimalRupees(-1n).raw).toBe('-0.01');
    expect(decimalRupees(-123_456n).raw).toBe('-1234.56');
    expect(decimalRupees(-100n).raw).toBe('-1.00');
  });

  it('survives an amount no IEEE double could hold', () => {
    // ₹1,00,00,00,00,00,00,00,000 — past 2^53 paise, which a float would round.
    const huge = 10n ** 20n + 7n;
    expect(decimalRupees(huge).raw).toBe('1000000000000000000.07');
  });

  it('never emits a thousands separator or a symbol, so it can be summed', () => {
    for (const value of [0n, 1n, 99n, 100_000_00n, -5_00_000_01n]) {
      expect(decimalRupees(value).raw).toMatch(/^-?\d+\.\d{2}$/);
    }
  });
});

describe('decimalQuantity', () => {
  it('unscales the stored quantity exactly', () => {
    expect(decimalQuantity(10_000n).raw).toBe('1.0000');
    expect(decimalQuantity(12_500n).raw).toBe('1.2500');
    expect(decimalQuantity(1n).raw).toBe('0.0001');
    expect(decimalQuantity(-25_000n).raw).toBe('-2.5000');
  });
});

describe('decimalPercent', () => {
  it('turns basis points into a percentage', () => {
    expect(decimalPercent(1000).raw).toBe('10.00');
    expect(decimalPercent(200).raw).toBe('2.00');
    expect(decimalPercent(50).raw).toBe('0.50');
    expect(decimalPercent(1).raw).toBe('0.01');
  });
});

describe('looksLikeFormula', () => {
  it('names every character a spreadsheet evaluates', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      expect(looksLikeFormula(`${start}SUM(A1)`)).toBe(true);
    }
  });

  it('leaves ordinary text alone', () => {
    for (const text of ['Acme Traders', '1234.56', 'Shop #4, Begumpet', '']) {
      expect(looksLikeFormula(text)).toBe(false);
    }
  });
});

describe('formatCell', () => {
  it('makes a text cell that would execute inert', () => {
    expect(formatCell('=HYPERLINK("http://evil","Click")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""Click"")"',
    );
    expect(formatCell('@SUM(1+1)')).toBe("'@SUM(1+1)");
    expect(formatCell('+1-1')).toBe("'+1-1");
  });

  it('does NOT prefix a negative amount, which is a number and not a formula', () => {
    // The whole reason numeric cells are a separate kind: a '-' prefix here would
    // turn every credit balance into the text "'-1234.56".
    expect(formatCell(decimalRupees(-123_456n))).toBe('-1234.56');
    expect(formatCell(numeric(-5))).toBe('-5');
  });

  it('quotes and doubles quotes when a cell contains a comma, quote or newline', () => {
    expect(formatCell('Hyderabad, Telangana')).toBe('"Hyderabad, Telangana"');
    expect(formatCell('Say "hello"')).toBe('"Say ""hello"""');
    expect(formatCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('writes an empty cell for null and undefined rather than the word', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
  });

  it('strips a NUL byte, which truncates the file for some readers', () => {
    expect(formatCell('Acme\u0000Traders')).toBe('AcmeTraders');
  });

  it('writes a bigint whole, not in exponent form', () => {
    expect(formatCell(10n ** 25n)).toBe('10000000000000000000000000');
  });
});

describe('toCsv', () => {
  it('uses CRLF and ends with a line break', () => {
    const csv = toCsv([['a', 'b'], ['c', 'd']], { bom: false });
    expect(csv).toBe('a,b\r\nc,d\r\n');
  });

  it('prepends a byte-order mark by default so Excel reads UTF-8', () => {
    expect(toCsv([['₹']])).toBe('﻿₹\r\n');
  });

  it('emits only the mark for no rows rather than a stray newline', () => {
    expect(toCsv([], { bom: false })).toBe('');
  });

  it('round-trips through a naive parser: every field survives escaping', () => {
    const rows = [
      ['Supplier', 'Amount'],
      ['Acme, Begumpet', decimalRupees(-123_456n)],
      ['=cmd|calc', decimalRupees(0n)],
    ];
    const csv = toCsv(rows, { bom: false });
    const parsed = parseCsv(csv);

    expect(parsed).toEqual([
      ['Supplier', 'Amount'],
      ['Acme, Begumpet', '-1234.56'],
      ["'=cmd|calc", '0.00'],
    ]);
  });
});

describe('cellText', () => {
  it('renders a cell without the CSV escaping, which JSON does not need', () => {
    expect(cellText('Hyderabad, Telangana')).toBe('Hyderabad, Telangana');
    expect(cellText('Say "hello"')).toBe('Say "hello"');
    // No apostrophe guard: nothing evaluates a JSON string.
    expect(cellText('=SUM(A1)')).toBe('=SUM(A1)');
    expect(cellText(null)).toBe('');
    expect(cellText('Acme\u0000Traders')).toBe('AcmeTraders');
  });

  it('renders an amount identically to the CSV, so the two files agree', () => {
    for (const value of [0n, -1n, 123_456n, 10n ** 20n]) {
      expect(cellText(decimalRupees(value))).toBe(formatCell(decimalRupees(value)));
    }
  });
});

/** A deliberately simple RFC 4180 reader, to check the writer against. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
