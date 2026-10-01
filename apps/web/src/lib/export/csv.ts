/**
 * CSV, written to be read back.
 *
 * Two rules decide everything here.
 *
 * The first is that a CSV opened in a spreadsheet is a program. A cell whose text
 * begins with `=`, `+`, `-`, `@`, a tab or a carriage return is evaluated by Excel,
 * LibreOffice and Google Sheets, so a supplier who calls themselves
 * `=HYPERLINK("http://x","Click")` has written code into an accountant's
 * spreadsheet. Text cells are therefore prefixed with an apostrophe when they
 * start with one of those characters. A number we formatted ourselves is not text
 * and must not be touched — a negative amount legitimately begins with a minus —
 * so numeric cells travel as {@link NumericCell} and skip the prefix entirely.
 *
 * The second is that money leaves as an exact decimal built from the integer
 * paise by string arithmetic, with no symbol, no thousands separator and no
 * float. `1234.56`, not `₹1,234.56`: the first can be summed by whatever reads it,
 * the second cannot.
 */

/** A value to be written verbatim, exempt from the formula prefix. */
export interface NumericCell {
  readonly raw: string;
}

export type CsvCell = string | number | bigint | null | undefined | NumericCell;

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_STARTS = ['=', '+', '-', '@', '\t', '\r'];

/** True when a spreadsheet would evaluate this text rather than display it. */
export function looksLikeFormula(text: string): boolean {
  return FORMULA_STARTS.some((c) => text.startsWith(c));
}

/** Money as an exact decimal string, from integer paise. Never a float. */
export function decimalRupees(value: bigint): NumericCell {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const fraction = abs % 100n;
  return { raw: `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}` };
}

/** A quantity, stored scaled by 10,000, as an exact decimal string. */
export function decimalQuantity(value: bigint, scale = 10_000n): NumericCell {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = scale.toString().length - 1;
  const whole = abs / scale;
  const fraction = abs % scale;
  return {
    raw: `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(digits, '0')}`,
  };
}

/** A rate held in basis points, as a percentage. */
export function decimalPercent(rateBps: number): NumericCell {
  const negative = rateBps < 0;
  const abs = Math.abs(Math.trunc(rateBps));
  return { raw: `${negative ? '-' : ''}${Math.trunc(abs / 100)}.${(abs % 100).toString().padStart(2, '0')}` };
}

/** A plain number meant to be read as a number, such as a count. */
export function numeric(value: number | bigint): NumericCell {
  return { raw: String(value) };
}

function isNumericCell(cell: CsvCell): cell is NumericCell {
  return typeof cell === 'object' && cell !== null && 'raw' in cell;
}

/** One cell, escaped. */
export function formatCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';

  let text: string;
  if (isNumericCell(cell)) {
    text = cell.raw;
  } else if (typeof cell === 'bigint' || typeof cell === 'number') {
    text = String(cell);
  } else {
    // Text from the database or from a portal file. Anything a spreadsheet would
    // execute is made inert before it reaches one.
    text = cell;
    if (looksLikeFormula(text)) text = `'${text}`;
  }

  // A NUL byte truncates the file for some readers, and no legitimate cell has one.
  text = text.replace(/\0/g, '');

  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * A whole file.
 *
 * CRLF line endings, because that is what RFC 4180 specifies and what Excel on
 * Windows expects; every other reader accepts them. A UTF-8 byte-order mark is
 * prepended so that Excel shows ₹ and Indian names correctly instead of mojibake
 * — it is the one concession to a single program, and it costs other readers
 * nothing because they skip it.
 */
export function toCsv(rows: readonly (readonly CsvCell[])[], opts: { bom?: boolean } = {}): string {
  const body = rows.map((row) => row.map(formatCell).join(',')).join('\r\n');
  const bom = opts.bom === false ? '' : '﻿';
  return rows.length === 0 ? bom : `${bom}${body}\r\n`;
}

/**
 * A cell as plain text, with no CSV escaping.
 *
 * What the JSON form needs. The apostrophe guard and the surrounding quotes exist
 * only because a spreadsheet evaluates a CSV; JSON is not opened in one, so
 * carrying them over would embed `\'=` and a pair of quotes into the value itself.
 * Numeric cells render from the same `raw` string the CSV uses, so an amount is
 * byte-identical in both files — two exports of one figure that disagreed would be
 * worse than having only one of them.
 */
export function cellText(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  if (isNumericCell(cell)) return cell.raw;
  return String(cell).replace(/\0/g, '');
}
