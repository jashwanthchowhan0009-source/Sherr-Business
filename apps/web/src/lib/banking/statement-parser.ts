/**
 * Bank statement parsing.
 *
 * Indian bank CSV exports are not a format, they are a genre. Across HDFC, ICICI,
 * SBI, Axis and Kotak the same statement arrives with:
 *
 *   - dates as 15/06/2025, 15-06-2025, 15-Jun-25 or 2025-06-15;
 *   - amounts as 1,00,000.00, 1,00,000.00 Cr, (1,000.00) or -1000;
 *   - either one signed Amount column or separate Withdrawal and Deposit columns;
 *   - a preamble of account-holder details before the real header row;
 *   - trailing summary lines after the last transaction;
 *   - a byte-order mark, CRLF endings, and quoted fields containing commas.
 *
 * Every one of those is handled here and every one has a test. The parser is
 * pure and returns integer paise: a float on this path would put a rounding
 * error into a reconciliation, which is the one place a difference of a paisa
 * costs an afternoon.
 *
 * Nothing here guesses a transaction. A row it cannot read with certainty comes
 * back as a problem naming the row and the reason, never as a transaction with
 * an assumed amount.
 */
import { PAISE_PER_RUPEE } from '@/lib/accounting/units';

export interface StatementLine {
  /** 1-based row number in the source file, so a problem can name its row. */
  rowNumber: number;
  date: string;
  narration: string;
  /** Positive is money in, negative is money out. Integer paise. */
  amountPaise: bigint;
  /** Running balance, where the statement gives one. */
  balancePaise: bigint | null;
  reference: string | null;
}

export interface StatementProblem {
  rowNumber: number;
  reason: string;
  raw: string;
}

export interface DetectedColumns {
  date: number;
  /** -1 when the statement has no narration column at all. */
  narration: number;
  /** A single signed amount column, when the statement has one. */
  amount: number | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  reference: number | null;
  headerRowNumber: number;
}

export interface ParsedStatement {
  lines: StatementLine[];
  problems: StatementProblem[];
  columns: DetectedColumns;
  openingBalancePaise: bigint | null;
  closingBalancePaise: bigint | null;
}

const HEADER_PATTERNS = {
  date: /^(transaction\s*date|txn\s*date|value\s*date|date|dt)$/i,
  narration: /^(narration|description|particulars|remarks|transaction\s*remarks|details)$/i,
  amount: /^(amount|txn\s*amount|transaction\s*amount)$/i,
  debit: /^(debit|withdrawal|withdrawal\s*amt\.?|withdrawals|dr|debit\s*amount|paid\s*out)$/i,
  credit: /^(credit|deposit|deposit\s*amt\.?|deposits|cr|credit\s*amount|paid\s*in)$/i,
  balance: /^(balance|closing\s*balance|running\s*balance|balance\s*amt\.?)$/i,
  reference: /^(ref\s*no\.?|reference|cheque\s*no\.?|chq\.?\s*\/?\s*ref\.?\s*no\.?|utr|transaction\s*id)$/i,
} as const;

/**
 * Splits a CSV line, honouring quoted fields.
 *
 * Written out rather than taken from a library because a bank narration
 * routinely contains commas and quotes, and the failure mode of a naive split is
 * a transaction silently assigned the wrong amount — worse than a parse error.
 */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/** Guesses the delimiter from the first lines: comma, semicolon, tab or pipe. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 25).join('\n');
  const counts = [',', ';', '\t', '|'].map((d) => ({ d, n: sample.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0] && counts[0].n > 0 ? counts[0].d : ',';
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function daysIn(year: number, month: number): number {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assemble(day: number, month: number, year: number): string | null {
  const fullYear = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysIn(fullYear, month)) return null;
  return `${fullYear}-${pad(month)}-${pad(day)}`;
}

/**
 * Parses a bank's date into `YYYY-MM-DD`.
 *
 * Day-first for all-numeric dates, because every Indian bank writes day first
 * and none writes month first: an ambiguous 03/04/2025 is 3 April, not 4 March.
 * A two-digit year is read as 20xx — a statement from 1925 is not a case worth
 * supporting, and reading 25 as 1925 would misdate every row silently.
 */
export function parseStatementDate(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    return assemble(Number(iso[3]), Number(iso[2]), Number(iso[1]));
  }

  // 15-Jun-2025, 15 Jun 25, 15/June/2025
  const named = /^(\d{1,2})[\s\-/]+([A-Za-z]{3,})[\s\-/]+(\d{2,4})/.exec(text);
  if (named) {
    const month = MONTHS[(named[2] ?? '').slice(0, 3).toLowerCase()];
    if (!month) return null;
    return assemble(Number(named[1]), month, Number(named[3]));
  }

  // 15/06/2025, 15-06-25, 15.06.2025 — day first.
  const numeric = /^(\d{1,2})[\-/.](\d{1,2})[\-/.](\d{2,4})/.exec(text);
  if (numeric) {
    return assemble(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  }

  return null;
}

/**
 * Parses a bank amount into integer paise.
 *
 * Handles Indian digit grouping, a trailing Cr or Dr, parentheses for a
 * negative, a currency symbol and a leading sign. Returns null for anything it
 * cannot read — including an empty cell, which on a two-column statement means
 * only that this row is not that kind of transaction.
 *
 * No `Number` on the path: `Number('1,00,000.07') * 100` is both wrong and
 * NaN-prone, and a reconciliation out by one paisa looks exactly like one out by
 * a lakh until somebody checks.
 */
export function parseAmountPaise(raw: string): bigint | null {
  let text = raw.trim();
  if (text === '' || text === '-' || text === '—') return null;

  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  const suffix = /\b(cr|dr)\.?$/i.exec(text);
  if (suffix) {
    if ((suffix[1] ?? '').toLowerCase() === 'dr') negative = true;
    text = text.slice(0, suffix.index).trim();
  }

  text = text.replace(/[₹$\s]/g, '').replace(/,/g, '');

  // Parentheses, a Dr suffix and a leading minus are three independent ways of
  // saying "money out", not three signs to multiply together. A statement
  // writing "-1,000.00 Dr" means one thousand out, said twice — toggling on each
  // marker would read it as money in.
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const [whole = '0', frac = ''] = text.split('.');
  const paise = BigInt(whole) * PAISE_PER_RUPEE + BigInt(frac.padEnd(2, '0'));
  return negative ? -paise : paise;
}

/**
 * Finds the header row and maps its columns.
 *
 * Banks put account-holder details, an address and a statement period above the
 * real header, so the first row of the file is usually not it. The header is the
 * first row naming a date column and either an amount or a debit/credit pair,
 * which is also the minimum needed to read a transaction at all.
 */
export function detectColumns(rows: readonly string[][]): DetectedColumns | null {
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const row = rows[i];
    if (!row) continue;

    const find = (pattern: RegExp) => {
      const index = row.findIndex((cell) => pattern.test(cell.trim()));
      return index === -1 ? null : index;
    };

    const date = find(HEADER_PATTERNS.date);
    if (date === null) continue;

    const amount = find(HEADER_PATTERNS.amount);
    const debit = find(HEADER_PATTERNS.debit);
    const credit = find(HEADER_PATTERNS.credit);
    if (amount === null && debit === null && credit === null) continue;

    return {
      date,
      narration: find(HEADER_PATTERNS.narration) ?? -1,
      amount,
      debit,
      credit,
      balance: find(HEADER_PATTERNS.balance),
      reference: find(HEADER_PATTERNS.reference),
      headerRowNumber: i + 1,
    };
  }
  return null;
}

export class UnreadableStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableStatementError';
  }
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Parses a bank statement CSV.
 *
 * Returns the transactions it could read and a problem for every row it could
 * not, so the import screen can show both. A row is never guessed: an unreadable
 * amount is a problem, not a transaction worth zero.
 */
export function parseStatement(text: string): ParsedStatement {
  // Strip a UTF-8 byte-order mark: Excel writes one, and it otherwise becomes
  // part of the first header cell and stops it matching.
  const clean = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(clean);
  const rawRows = clean.split(/\r?\n/);
  const rows = rawRows.map((line) => splitCsvLine(line, delimiter));

  const columns = detectColumns(rows);
  if (!columns) {
    throw new UnreadableStatementError(
      'No header row found. The file needs a row naming a date column and either an amount ' +
        'column or a withdrawal and deposit pair.',
    );
  }

  const lines: StatementLine[] = [];
  const problems: StatementProblem[] = [];
  let openingBalancePaise: bigint | null = null;
  let closingBalancePaise: bigint | null = null;

  for (let i = columns.headerRowNumber; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNumber = i + 1;
    if (!row) continue;

    const raw = rawRows[i] ?? '';
    if (row.every((cell) => cell === '' || /^-+$/.test(cell))) continue;

    const date = parseStatementDate(row[columns.date] ?? '');
    if (!date) {
      // A trailing summary line has no date. Flag it only if it looks like it
      // was meant to be a transaction.
      if (!/total|opening|closing|balance|statement|generated|page|summary/i.test(raw)) {
        problems.push({ rowNumber, reason: 'No readable date in the date column.', raw });
      }
      continue;
    }

    let amountPaise: bigint | null = null;
    if (columns.amount !== null) {
      amountPaise = parseAmountPaise(row[columns.amount] ?? '');
    }
    if (amountPaise === null && (columns.debit !== null || columns.credit !== null)) {
      const debit = columns.debit === null ? null : parseAmountPaise(row[columns.debit] ?? '');
      const credit = columns.credit === null ? null : parseAmountPaise(row[columns.credit] ?? '');

      if (debit !== null && debit !== 0n && credit !== null && credit !== 0n) {
        problems.push({
          rowNumber,
          reason: 'Both a withdrawal and a deposit on one row; which is the transaction is unclear.',
          raw,
        });
        continue;
      }
      // A withdrawal column holds a positive figure meaning money out.
      if (debit !== null && debit !== 0n) amountPaise = -abs(debit);
      else if (credit !== null && credit !== 0n) amountPaise = abs(credit);
      else amountPaise = 0n;
    }

    if (amountPaise === null) {
      problems.push({ rowNumber, reason: 'No readable amount on this row.', raw });
      continue;
    }
    // A zero-value row is not a transaction; importing it would clutter the
    // review queue with a formatting artefact.
    if (amountPaise === 0n) continue;

    const balancePaise =
      columns.balance === null ? null : parseAmountPaise(row[columns.balance] ?? '');
    if (balancePaise !== null) {
      if (openingBalancePaise === null) openingBalancePaise = balancePaise - amountPaise;
      closingBalancePaise = balancePaise;
    }

    const narrationCell = columns.narration >= 0 ? row[columns.narration] : '';

    lines.push({
      rowNumber,
      date,
      narration: (narrationCell ?? '').trim(),
      amountPaise,
      balancePaise,
      reference: columns.reference === null ? null : (row[columns.reference] ?? '').trim() || null,
    });
  }

  return { lines, problems, columns, openingBalancePaise, closingBalancePaise };
}

/**
 * Checks that the statement's own running balance follows from its amounts.
 *
 * A statement whose balance column does not add up has been edited, truncated or
 * exported with rows missing — and importing it would produce a reconciliation
 * that can never be made to agree. Better to say so at the door than to spend an
 * afternoon hunting the difference.
 */
export function verifyRunningBalance(lines: readonly StatementLine[]): {
  consistent: boolean;
  firstBreakRowNumber: number | null;
} {
  let previous: bigint | null = null;
  for (const line of lines) {
    if (line.balancePaise === null) continue;
    if (previous !== null && previous + line.amountPaise !== line.balancePaise) {
      return { consistent: false, firstBreakRowNumber: line.rowNumber };
    }
    previous = line.balancePaise;
  }
  return { consistent: true, firstBreakRowNumber: null };
}
