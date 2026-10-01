import { describe, expect, it } from 'vitest';
import {
  confidenceFor,
  matchStatement,
  normalise,
  partyNamedIn,
  referencesAgree,
  scoreMatch,
  type MatchCandidate,
  type StatementLineForMatch,
} from '../../src/lib/banking/matching';

const line = (over: Partial<StatementLineForMatch> = {}): StatementLineForMatch => ({
  id: 'l1',
  date: '2025-06-20',
  narration: 'NEFT CR-ANAND ENTERPRISES-SBIN0001234',
  amountPaise: 11_800_00n,
  reference: null,
  ...over,
});

const invoice = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  voucherId: 'v1',
  voucherNo: 'INV/25-26/0001',
  voucherType: 'sales',
  voucherDate: '2025-06-15',
  partyId: 'p1',
  partyName: 'Anand Enterprises',
  outstandingPaise: 11_800_00n,
  reference: null,
  ...over,
});

const bill = (over: Partial<MatchCandidate> = {}): MatchCandidate =>
  invoice({
    voucherId: 'b1',
    voucherNo: 'BILL/25-26/0001',
    voucherType: 'purchase',
    partyName: 'Sunrise Traders',
    ...over,
  });

describe('normalise', () => {
  it('strips everything but letters and digits', () => {
    expect(normalise('NEFT CR-Anand Enterprises, Blr.')).toBe('NEFTCRANANDENTERPRISESBLR');
    expect(normalise('INV/25-26/0001')).toBe('INV25260001');
  });
});

describe('referencesAgree', () => {
  it('matches a reference embedded in a longer string', () => {
    expect(referencesAgree('NEFT-N123456-ANAND', 'N123456')).toBe(true);
  });

  it('matches an invoice number quoted without its slashes', () => {
    expect(referencesAgree('PAYMENT FOR INV 25 26 0001', 'INV/25-26/0001')).toBe(true);
  });

  it('refuses a very short reference, which would match almost anything', () => {
    // A false "exact" is worse than no suggestion at all.
    expect(referencesAgree('NEFT CR 12', '12')).toBe(false);
    expect(referencesAgree('ABC', 'ABC')).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(referencesAgree(null, 'N123456')).toBe(false);
    expect(referencesAgree('N123456', null)).toBe(false);
  });
});

describe('partyNamedIn', () => {
  it('finds a full name the bank kept intact', () => {
    expect(partyNamedIn('NEFT CR-ANAND ENTERPRISES-SBIN', 'Anand Enterprises')).toBe(true);
  });

  it('finds a name the bank truncated, via its longest word', () => {
    // "SHREE BALAJI TRADERS PRIVATE LIMITED" arrives truncated.
    expect(partyNamedIn('RTGS DR-SHREEBALAJITRAD-HDFC', 'Shree Balaji Traders Private Limited')).toBe(
      true,
    );
  });

  it('ignores short words that would match everything', () => {
    // Matching on "AND" or "THE" would name every transaction in the statement.
    expect(partyNamedIn('RANDOM NARRATION TEXT', 'The And Co')).toBe(false);
  });

  it('is false for an unrelated narration', () => {
    expect(partyNamedIn('BANK CHARGES GST', 'Anand Enterprises')).toBe(false);
  });

  it('is false when there is no party', () => {
    expect(partyNamedIn('ANYTHING', null)).toBe(false);
  });
});

describe('scoreMatch', () => {
  it('refuses a difference in amount, however small', () => {
    // A payment of ₹23,600 is not evidence for a bill of ₹23,599. A matcher that
    // tolerates a paisa will silently reconcile two different transactions.
    expect(scoreMatch(line(), invoice({ outstandingPaise: 11_800_01n }))).toBeNull();
    expect(scoreMatch(line(), invoice({ outstandingPaise: 11_799_99n }))).toBeNull();
  });

  it('refuses money in against a bill, and money out against an invoice', () => {
    // Money received cannot settle something we owe.
    expect(scoreMatch(line({ amountPaise: 11_800_00n }), bill())).toBeNull();
    expect(scoreMatch(line({ amountPaise: -11_800_00n }), invoice())).toBeNull();
  });

  it('matches money out against a bill', () => {
    const match = scoreMatch(
      line({ amountPaise: -11_800_00n, narration: 'RTGS DR-SUNRISE TRADERS' }),
      bill(),
    );
    expect(match?.tier).toBe('strong');
  });

  it('rates a reference match as exact', () => {
    const match = scoreMatch(line({ reference: 'N999', narration: 'NEFT INV 25 26 0001' }), invoice());
    expect(match?.tier).toBe('exact');
    expect(match?.reasons).toContain('The reference matches the voucher');
  });

  it('rates a named party as strong', () => {
    const match = scoreMatch(line(), invoice());
    expect(match?.tier).toBe('strong');
    expect(match?.reasons.some((r) => r.includes('Anand Enterprises'))).toBe(true);
  });

  it('rates a close date with nothing else as probable', () => {
    const match = scoreMatch(line({ narration: 'NEFT CR 00112233' }), invoice());
    expect(match?.tier).toBe('probable');
  });

  it('rates a distant date with nothing else as weak', () => {
    const match = scoreMatch(
      line({ narration: 'NEFT CR 00112233', date: '2025-07-20' }),
      invoice(),
    );
    expect(match?.tier).toBe('weak');
  });

  it('refuses a coincidence months apart with nothing corroborating it', () => {
    // The amount agrees and nothing else does. Offering it would train someone
    // to click accept without looking.
    expect(
      scoreMatch(line({ narration: 'UNRELATED', date: '2025-12-20' }), invoice()),
    ).toBeNull();
  });

  it('refuses a statement line dated well before the voucher', () => {
    // Money cannot settle an invoice that did not exist yet.
    expect(scoreMatch(line({ date: '2025-05-01' }), invoice())).toBeNull();
  });

  it('allows a few days of settlement before the voucher date', () => {
    // An advance received days before the invoice is raised is ordinary.
    expect(scoreMatch(line({ date: '2025-06-12' }), invoice())).not.toBeNull();
  });

  it('always reports a zero amount difference, since it only matches exact amounts', () => {
    expect(scoreMatch(line(), invoice())?.amountDifferencePaise).toBe(0n);
  });
});

describe('confidenceFor', () => {
  it('never reaches 100, however strong the signals', () => {
    // Two invoices to the same customer for the same amount in the same week are
    // indistinguishable to any rule. The ceiling says a human still matters.
    const best = confidenceFor('exact', {
      referenceMatch: true,
      nameMatch: true,
      dayDifference: 0,
    });
    expect(best).toBeLessThan(100);
    expect(best).toBeGreaterThan(90);
  });

  it('never drops to zero, since the amount did match', () => {
    const worst = confidenceFor('weak', {
      referenceMatch: false,
      nameMatch: false,
      dayDifference: 44,
    });
    expect(worst).toBeGreaterThan(0);
  });

  it('orders the tiers', () => {
    const at = (tier: 'exact' | 'strong' | 'probable' | 'weak') =>
      confidenceFor(tier, { referenceMatch: false, nameMatch: false, dayDifference: 3 });
    expect(at('exact')).toBeGreaterThan(at('strong'));
    expect(at('strong')).toBeGreaterThan(at('probable'));
    expect(at('probable')).toBeGreaterThan(at('weak'));
  });

  it('rewards same-day settlement and penalises a distant one', () => {
    const base = { referenceMatch: false, nameMatch: false };
    expect(confidenceFor('strong', { ...base, dayDifference: 0 })).toBeGreaterThan(
      confidenceFor('strong', { ...base, dayDifference: 40 }),
    );
  });
});

describe('matchStatement', () => {
  it('matches each line to its voucher', () => {
    const result = matchStatement(
      [
        line({ id: 'a', amountPaise: 11_800_00n }),
        line({
          id: 'b',
          amountPaise: -23_600_00n,
          narration: 'RTGS DR-SUNRISE TRADERS',
          date: '2025-06-22',
        }),
      ],
      [invoice(), bill({ outstandingPaise: 23_600_00n })],
    );
    expect(result.suggestions).toHaveLength(2);
    expect(result.unmatchedLineIds).toEqual([]);
  });

  it('uses a voucher only once', () => {
    // One invoice cannot be settled twice by two different deposits.
    const result = matchStatement(
      [line({ id: 'a' }), line({ id: 'b', date: '2025-06-21' })],
      [invoice()],
    );
    expect(result.suggestions).toHaveLength(1);
    expect(result.unmatchedLineIds).toEqual(['b']);
  });

  it('gives the oldest invoice to the earliest deposit', () => {
    const result = matchStatement(
      [
        line({ id: 'later', date: '2025-06-25' }),
        line({ id: 'earlier', date: '2025-06-18' }),
      ],
      [
        invoice({ voucherId: 'old', voucherDate: '2025-06-15' }),
        invoice({ voucherId: 'new', voucherDate: '2025-06-17' }),
      ],
    );
    const forEarlier = result.suggestions.find((s) => s.statementLineId === 'earlier');
    expect(forEarlier?.voucherId).toBe('old');
  });

  it('proposes nothing when two candidates are indistinguishable', () => {
    // Same party, same amount, same date. Picking one arbitrarily is how a
    // reconciliation ends up confidently wrong.
    const result = matchStatement(
      [line()],
      [invoice({ voucherId: 'x' }), invoice({ voucherId: 'y' })],
    );
    expect(result.suggestions).toEqual([]);
    expect(result.unmatchedLineIds).toEqual(['l1']);
  });

  it('prefers the stronger candidate when they differ', () => {
    const result = matchStatement(
      [line({ reference: 'N123456' })],
      [
        invoice({ voucherId: 'weak', partyName: 'Someone Else', reference: null, voucherDate: '2025-06-01' }),
        invoice({ voucherId: 'exact', reference: 'N123456' }),
      ],
    );
    expect(result.suggestions[0]?.voucherId).toBe('exact');
    expect(result.suggestions[0]?.tier).toBe('exact');
  });

  it('reports a line with no candidate rather than dropping it', () => {
    const result = matchStatement(
      [line({ id: 'orphan', amountPaise: 777_00n, narration: 'BANK CHARGES' })],
      [invoice()],
    );
    expect(result.suggestions).toEqual([]);
    expect(result.unmatchedLineIds).toEqual(['orphan']);
  });

  it('handles an empty statement and an empty ledger', () => {
    expect(matchStatement([], [invoice()]).suggestions).toEqual([]);
    expect(matchStatement([line()], []).unmatchedLineIds).toEqual(['l1']);
  });

  it('never proposes the same voucher for two lines', () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      line({ id: `l${i}`, date: `2025-06-2${i}` }),
    );
    const result = matchStatement(lines, [invoice(), invoice({ voucherId: 'v2' })]);
    const used = result.suggestions.map((s) => s.voucherId);
    expect(new Set(used).size).toBe(used.length);
  });
});
