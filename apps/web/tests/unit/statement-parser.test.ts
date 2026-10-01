import { describe, expect, it } from 'vitest';
import {
  UnreadableStatementError,
  detectColumns,
  detectDelimiter,
  parseAmountPaise,
  parseStatement,
  parseStatementDate,
  splitCsvLine,
  verifyRunningBalance,
} from '../../src/lib/banking/statement-parser';

describe('splitCsvLine', () => {
  it('splits a plain row', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a comma inside quotes', () => {
    // A bank narration contains commas constantly. A naive split would shift
    // every later column and assign the wrong amount to the transaction.
    expect(splitCsvLine('15/06/2025,"NEFT CR-ANAND ENTERPRISES, BENGALURU",1000.00')).toEqual([
      '15/06/2025',
      'NEFT CR-ANAND ENTERPRISES, BENGALURU',
      '1000.00',
    ]);
  });

  it('unescapes a doubled quote', () => {
    expect(splitCsvLine('a,"say ""hello""",b')).toEqual(['a', 'say "hello"', 'b']);
  });

  it('keeps empty fields', () => {
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
    expect(splitCsvLine(',,')).toEqual(['', '', '']);
  });

  it('handles another delimiter', () => {
    expect(splitCsvLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
  });
});

describe('detectDelimiter', () => {
  it('finds a comma, semicolon or tab', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('falls back to a comma when there is nothing to go on', () => {
    expect(detectDelimiter('single')).toBe(',');
  });
});

describe('parseStatementDate', () => {
  it('reads day-first numeric dates, as every Indian bank writes them', () => {
    expect(parseStatementDate('15/06/2025')).toBe('2025-06-15');
    expect(parseStatementDate('15-06-2025')).toBe('2025-06-15');
    expect(parseStatementDate('15.06.2025')).toBe('2025-06-15');
    expect(parseStatementDate('5/6/2025')).toBe('2025-06-05');
  });

  it('reads an ambiguous date as day-first, not month-first', () => {
    // 03/04/2025 is 3 April in India. Reading it as 4 March would misdate it by
    // a month and move it between GST periods.
    expect(parseStatementDate('03/04/2025')).toBe('2025-04-03');
  });

  it('reads a named month', () => {
    expect(parseStatementDate('15-Jun-2025')).toBe('2025-06-15');
    expect(parseStatementDate('15 Jun 25')).toBe('2025-06-15');
    expect(parseStatementDate('01/January/2025')).toBe('2025-01-01');
    expect(parseStatementDate('28-FEB-2025')).toBe('2025-02-28');
  });

  it('reads an ISO date', () => {
    expect(parseStatementDate('2025-06-15')).toBe('2025-06-15');
    expect(parseStatementDate('2025-06-15 00:00:00')).toBe('2025-06-15');
  });

  it('expands a two-digit year into this century', () => {
    expect(parseStatementDate('15-06-25')).toBe('2025-06-15');
    expect(parseStatementDate('15-06-99')).toBe('2099-06-15');
  });

  it('refuses an impossible date rather than rolling it over', () => {
    expect(parseStatementDate('31/02/2025')).toBeNull();
    expect(parseStatementDate('29/02/2025')).toBeNull();
    expect(parseStatementDate('15/13/2025')).toBeNull();
    expect(parseStatementDate('00/06/2025')).toBeNull();
  });

  it('accepts 29 February in a leap year', () => {
    expect(parseStatementDate('29/02/2024')).toBe('2024-02-29');
  });

  it('returns null for anything unreadable', () => {
    for (const bad of ['', '   ', 'Opening Balance', 'n/a', '15/06', 'Jun 2025']) {
      expect(parseStatementDate(bad), bad).toBeNull();
    }
  });
});

describe('parseAmountPaise', () => {
  it('reads Indian digit grouping', () => {
    expect(parseAmountPaise('1,00,000.00')).toBe(1_00_000_00n);
    expect(parseAmountPaise('12,34,567.89')).toBe(12_34_567_89n);
  });

  it('reads paise exactly, where a float would not', () => {
    expect(parseAmountPaise('0.07')).toBe(7n);
    expect(parseAmountPaise('1,00,000.07')).toBe(1_00_000_07n);
  });

  it('reads a trailing Cr as positive and Dr as negative', () => {
    expect(parseAmountPaise('1,000.00 Cr')).toBe(1_000_00n);
    expect(parseAmountPaise('1,000.00 Dr')).toBe(-1_000_00n);
    expect(parseAmountPaise('1000 CR')).toBe(1_000_00n);
    expect(parseAmountPaise('1000 dr.')).toBe(-1_000_00n);
  });

  it('reads parentheses as negative', () => {
    expect(parseAmountPaise('(1,000.00)')).toBe(-1_000_00n);
  });

  it('reads a leading sign and a currency symbol', () => {
    expect(parseAmountPaise('-1000')).toBe(-1_000_00n);
    expect(parseAmountPaise('+1000')).toBe(1_000_00n);
    expect(parseAmountPaise('₹1,000.50')).toBe(1_000_50n);
  });

  it('treats redundant negative markers as one negative, not as a double negation', () => {
    // Parentheses, a Dr suffix and a leading minus each say "money out". A
    // statement using two of them is saying it twice, not cancelling itself out,
    // and reading "-1,000.00 Dr" as money IN would be a sign error of exactly
    // twice the transaction.
    expect(parseAmountPaise('(1,000.00 Dr)')).toBe(-1_000_00n);
    expect(parseAmountPaise('-1,000.00 Dr')).toBe(-1_000_00n);
    expect(parseAmountPaise('(-1,000.00)')).toBe(-1_000_00n);
  });

  it('treats an empty cell as nothing, not as zero', () => {
    // On a two-column statement an empty withdrawal cell means "this row is a
    // deposit", not "a withdrawal of zero".
    expect(parseAmountPaise('')).toBeNull();
    expect(parseAmountPaise('  ')).toBeNull();
    expect(parseAmountPaise('-')).toBeNull();
  });

  it('refuses anything finer than a paisa', () => {
    expect(parseAmountPaise('1.234')).toBeNull();
  });

  it('refuses text', () => {
    for (const bad of ['abc', '1.2.3', 'NaN', '1e5', 'Balance']) {
      expect(parseAmountPaise(bad), bad).toBeNull();
    }
  });

  it('handles an amount larger than a float holds exactly', () => {
    expect(parseAmountPaise('92,23,37,20,368.55')).toBe(9_223_372_036_855n);
  });
});

describe('detectColumns', () => {
  it('finds the header below a preamble', () => {
    const rows = [
      ['Account Statement'],
      ['Account Holder', 'SHREE BALAJI TRADERS PVT LTD'],
      ['Account Number', '50200012345678'],
      ['Period', '01/04/2025 to 30/09/2025'],
      [],
      ['Date', 'Narration', 'Chq./Ref.No.', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      ['15/06/2025', 'NEFT CR', '', '', '1000.00', '1000.00'],
    ];
    const columns = detectColumns(rows)!;
    expect(columns.headerRowNumber).toBe(6);
    expect(columns.date).toBe(0);
    expect(columns.narration).toBe(1);
    expect(columns.debit).toBe(3);
    expect(columns.credit).toBe(4);
    expect(columns.balance).toBe(5);
    expect(columns.reference).toBe(2);
  });

  it('finds a single signed amount column', () => {
    const columns = detectColumns([['Txn Date', 'Description', 'Amount', 'Balance']])!;
    expect(columns.amount).toBe(2);
    expect(columns.debit).toBeNull();
  });

  it('returns null when no row names a date and an amount', () => {
    expect(detectColumns([['Name', 'Address'], ['a', 'b']])).toBeNull();
    expect(detectColumns([['Date', 'Narration']])).toBeNull();
  });
});

describe('parseStatement', () => {
  // The HDFC shape: preamble, Withdrawal/Deposit pair, running balance,
  // trailing summary, CRLF, and a BOM.
  const hdfc = [
    '﻿HDFC BANK LIMITED',
    'Account No :,50200012345678',
    'Statement Period :,01/06/2025 to 30/06/2025',
    '',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    '01/06/2025,OPENING,,,0.00,0.00,1,00,000.00',
    '05/06/2025,"NEFT CR-ANAND ENTERPRISES, BLR",N123456,05/06/2025,,"59,000.00","1,59,000.00"',
    '10/06/2025,RTGS DR-SUNRISE TRADERS,R987654,10/06/2025,"23,600.00",,"1,35,400.00"',
    '15/06/2025,BANK CHARGES,,15/06/2025,"118.00",,"1,35,282.00"',
    '',
    'Opening Balance:,100000.00,Closing Balance:,135282.00',
    'Statement generated on 01/07/2025',
  ].join('\r\n');

  it('reads every transaction from an HDFC-shaped export', () => {
    const parsed = parseStatement(hdfc);
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.problems).toEqual([]);
  });

  it('signs money in positive and money out negative', () => {
    const parsed = parseStatement(hdfc);
    expect(parsed.lines[0]?.amountPaise).toBe(59_000_00n);
    expect(parsed.lines[1]?.amountPaise).toBe(-23_600_00n);
    expect(parsed.lines[2]?.amountPaise).toBe(-118_00n);
  });

  it('keeps a narration containing a comma intact', () => {
    const parsed = parseStatement(hdfc);
    expect(parsed.lines[0]?.narration).toBe('NEFT CR-ANAND ENTERPRISES, BLR');
  });

  it('reads the reference where there is one', () => {
    const parsed = parseStatement(hdfc);
    expect(parsed.lines[0]?.reference).toBe('N123456');
    expect(parsed.lines[2]?.reference).toBeNull();
  });

  it('skips the zero-value opening row rather than importing it', () => {
    const parsed = parseStatement(hdfc);
    expect(parsed.lines.some((l) => l.narration === 'OPENING')).toBe(false);
  });

  it('does not flag the trailing summary lines as problems', () => {
    expect(parseStatement(hdfc).problems).toEqual([]);
  });

  it('derives the opening and closing balances', () => {
    const parsed = parseStatement(hdfc);
    // First transaction leaves 1,59,000 after +59,000, so opening was 1,00,000.
    expect(parsed.openingBalancePaise).toBe(1_00_000_00n);
    expect(parsed.closingBalancePaise).toBe(1_35_282_00n);
  });

  it('reads a single signed amount column', () => {
    const icici = [
      'Txn Date,Description,Amount,Balance',
      '05/06/2025,UPI IN,"59,000.00","1,59,000.00"',
      '10/06/2025,UPI OUT,"-23,600.00","1,35,400.00"',
    ].join('\n');
    const parsed = parseStatement(icici);
    expect(parsed.lines.map((l) => l.amountPaise)).toEqual([59_000_00n, -23_600_00n]);
  });

  it('reads a Cr/Dr suffixed amount column', () => {
    const sbi = [
      'Date,Particulars,Amount',
      '05-Jun-2025,NEFT,"59,000.00 Cr"',
      '10-Jun-2025,RTGS,"23,600.00 Dr"',
    ].join('\n');
    const parsed = parseStatement(sbi);
    expect(parsed.lines.map((l) => l.amountPaise)).toEqual([59_000_00n, -23_600_00n]);
  });

  it('reads a tab-separated export', () => {
    const parsed = parseStatement(
      ['Date\tNarration\tAmount', '05/06/2025\tNEFT\t1000.00'].join('\n'),
    );
    expect(parsed.lines).toHaveLength(1);
  });

  it('reports a row whose date cannot be read, rather than skipping it silently', () => {
    const parsed = parseStatement(
      ['Date,Narration,Amount', 'not a date,NEFT,1000.00', '05/06/2025,NEFT,2000.00'].join('\n'),
    );
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.rowNumber).toBe(2);
    expect(parsed.problems[0]?.reason).toMatch(/date/i);
  });

  it('reports a row whose amount cannot be read, rather than importing zero', () => {
    const parsed = parseStatement(
      ['Date,Narration,Amount', '05/06/2025,NEFT,abc'].join('\n'),
    );
    expect(parsed.lines).toEqual([]);
    expect(parsed.problems[0]?.reason).toMatch(/amount/i);
  });

  it('refuses a row carrying both a withdrawal and a deposit', () => {
    // Which one is the transaction is genuinely unknowable, so it is a problem
    // rather than a guess.
    const parsed = parseStatement(
      [
        'Date,Narration,Withdrawal Amt.,Deposit Amt.',
        '05/06/2025,CONFUSED,100.00,200.00',
      ].join('\n'),
    );
    expect(parsed.lines).toEqual([]);
    expect(parsed.problems[0]?.reason).toMatch(/both a withdrawal and a deposit/i);
  });

  it('throws when there is no header row at all', () => {
    expect(() => parseStatement('just,some,data\n1,2,3')).toThrow(UnreadableStatementError);
  });

  it('handles a file with a header and no transactions', () => {
    const parsed = parseStatement('Date,Narration,Amount\n');
    expect(parsed.lines).toEqual([]);
    expect(parsed.problems).toEqual([]);
  });

  it('records the source row number, so a problem can be found in the file', () => {
    const parsed = parseStatement(
      ['Date,Narration,Amount', '05/06/2025,A,100.00', '06/06/2025,B,200.00'].join('\n'),
    );
    expect(parsed.lines.map((l) => l.rowNumber)).toEqual([2, 3]);
  });
});

describe('verifyRunningBalance', () => {
  const line = (rowNumber: number, amountPaise: bigint, balancePaise: bigint | null) => ({
    rowNumber,
    date: '2025-06-01',
    narration: '',
    amountPaise,
    balancePaise,
    reference: null,
  });

  it('accepts a statement whose balance follows from its amounts', () => {
    expect(
      verifyRunningBalance([
        line(2, 1_000_00n, 1_000_00n),
        line(3, 500_00n, 1_500_00n),
        line(4, -200_00n, 1_300_00n),
      ]).consistent,
    ).toBe(true);
  });

  it('names the first row where the balance stops adding up', () => {
    // A statement that has been edited or exported with rows missing would
    // produce a reconciliation that can never be made to agree.
    const result = verifyRunningBalance([
      line(2, 1_000_00n, 1_000_00n),
      line(3, 500_00n, 1_500_00n),
      line(4, -200_00n, 9_999_00n),
    ]);
    expect(result.consistent).toBe(false);
    expect(result.firstBreakRowNumber).toBe(4);
  });

  it('ignores rows with no balance given', () => {
    expect(
      verifyRunningBalance([line(2, 1_000_00n, null), line(3, 500_00n, null)]).consistent,
    ).toBe(true);
  });

  it('is consistent for an empty statement', () => {
    expect(verifyRunningBalance([]).consistent).toBe(true);
  });
});
