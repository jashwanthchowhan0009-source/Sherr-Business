/**
 * Matching bank statement lines to vouchers.
 *
 * Deterministic and pure. No model, no learning, no threshold that drifts: a
 * suggestion is produced by rules that can be read, and the confidence attached
 * to it is derived from which rules fired rather than from a number somebody
 * tuned until the demo looked good.
 *
 * Nothing here posts anything. A match is a *suggestion* with a reason, and a
 * person accepts it. That is deliberate: a wrong auto-posted match is
 * indistinguishable from fraud in an audit, and the cost of reviewing a correct
 * suggestion is seconds.
 *
 * The tiers, from the §2 rules:
 *
 *   exact      amount and reference both agree — effectively certain
 *   strong     amount agrees and the party is named in the narration
 *   probable   amount agrees and the date is close
 *   weak       amount agrees but nothing else corroborates it
 *   none       no candidate at all
 */
import { daysBetween } from '@/lib/accounting/ageing';

export type MatchTier = 'exact' | 'strong' | 'probable' | 'weak';

export interface MatchCandidate {
  voucherId: string;
  voucherNo: string;
  voucherType: string;
  voucherDate: string;
  partyId: string | null;
  partyName: string | null;
  /** What remains unsettled on this voucher, positive. */
  outstandingPaise: bigint;
  reference: string | null;
}

export interface StatementLineForMatch {
  id: string;
  date: string;
  narration: string;
  /** Positive is money in. */
  amountPaise: bigint;
  reference: string | null;
}

export interface MatchSuggestion {
  statementLineId: string;
  voucherId: string;
  /** Carried so ties can be broken oldest-first, as allocation does. */
  voucherDate: string;
  tier: MatchTier;
  /** 0–100. Derived from the tier and the corroborating signals, never tuned. */
  confidence: number;
  /** Every reason the match was proposed, in the order they were found. */
  reasons: string[];
  amountDifferencePaise: bigint;
  dayDifference: number;
}

/** How far apart a payment and its document may be and still look like a pair. */
const NEAR_DAYS = 7;
const PLAUSIBLE_DAYS = 45;

/**
 * Normalises text for comparison: upper case, letters and digits only.
 *
 * Bank narrations mangle names — "ANAND ENTERPRISES" becomes
 * "NEFT CR-ANANDENTERPRISES-SBIN0001234" — so punctuation and spacing cannot be
 * relied on, but the letters survive.
 */
export function normalise(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Whether a reference appears in the narration or vice versa.
 *
 * A bank reference is often embedded in a longer string, and an invoice number
 * like `INV/25-26/0001` is usually quoted without its slashes. Comparison is
 * therefore on normalised text and in both directions. Very short references are
 * refused: a two-character reference matches almost anything, and a false
 * "exact" is worse than no suggestion.
 */
export function referencesAgree(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = normalise(a);
  const right = normalise(b);
  if (left.length < 4 || right.length < 4) return false;
  return left.includes(right) || right.includes(left);
}

/**
 * Whether a party's name is recognisable in a bank narration.
 *
 * Matches on the longest word of the name rather than the whole string, because
 * banks truncate: "SHREE BALAJI TRADERS PRIVATE LIMITED" arrives as
 * "SHREEBALAJITRAD". Words shorter than four characters are ignored — matching
 * on "THE" or "AND" would name every transaction.
 */
export function partyNamedIn(narration: string, partyName: string | null): boolean {
  if (!partyName) return false;
  const haystack = normalise(narration);
  if (haystack === '') return false;

  const words = partyName
    .split(/\s+/)
    .map(normalise)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length);

  if (words.length === 0) return false;
  // The full name without spacing, in case the bank kept it whole.
  if (haystack.includes(normalise(partyName))) return true;
  // Otherwise the most distinctive word, which is the longest.
  return words.some((word) => haystack.includes(word));
}

/**
 * Scores one statement line against one candidate voucher.
 *
 * Returns null when the amounts do not agree. The amount is the one signal that
 * is never approximated: a payment of ₹23,600 is not evidence for a bill of
 * ₹23,599, and a matcher that tolerates a small difference will silently
 * reconcile two different transactions.
 */
export function scoreMatch(
  line: StatementLineForMatch,
  candidate: MatchCandidate,
): MatchSuggestion | null {
  const lineAbs = line.amountPaise < 0n ? -line.amountPaise : line.amountPaise;
  if (lineAbs !== candidate.outstandingPaise) return null;

  // Money in settles something owed to us; money out settles something we owe.
  const expectsReceivable = line.amountPaise > 0n;
  const candidateIsReceivable =
    candidate.voucherType === 'sales' || candidate.voucherType === 'receipt';
  if (expectsReceivable !== candidateIsReceivable) return null;

  const dayDifference = daysBetween(candidate.voucherDate, line.date);
  // A statement line dated long before its document is not a settlement of it.
  if (dayDifference < -NEAR_DAYS) return null;

  const reasons: string[] = ['The amount matches exactly'];
  let tier: MatchTier = 'weak';

  const referenceMatch =
    referencesAgree(line.reference, candidate.reference) ||
    referencesAgree(line.reference, candidate.voucherNo) ||
    referencesAgree(line.narration, candidate.voucherNo) ||
    referencesAgree(line.narration, candidate.reference);

  const nameMatch = partyNamedIn(line.narration, candidate.partyName);

  if (referenceMatch) {
    reasons.push('The reference matches the voucher');
    tier = 'exact';
  }
  if (nameMatch) {
    reasons.push(`The narration names ${candidate.partyName}`);
    if (tier !== 'exact') tier = 'strong';
  }
  if (!referenceMatch && !nameMatch) {
    if (Math.abs(dayDifference) <= NEAR_DAYS) {
      reasons.push(`Dated within ${NEAR_DAYS} days of the voucher`);
      tier = 'probable';
    } else if (dayDifference <= PLAUSIBLE_DAYS) {
      reasons.push(`${dayDifference} days after the voucher`);
      tier = 'weak';
    } else {
      // The amount agrees and nothing else does, months apart. Technically a
      // candidate, but proposing it would train someone to click accept.
      return null;
    }
  }

  return {
    statementLineId: line.id,
    voucherId: candidate.voucherId,
    voucherDate: candidate.voucherDate,
    tier,
    confidence: confidenceFor(tier, { referenceMatch, nameMatch, dayDifference }),
    reasons,
    amountDifferencePaise: 0n,
    dayDifference,
  };
}

/**
 * Confidence, derived from the tier and its corroboration.
 *
 * Deliberately never 100: a deterministic rule can be certain about what it
 * compared and still be wrong about the world — two invoices to the same customer
 * for the same amount in the same week are indistinguishable to any rule. The
 * ceiling is a statement that a human decision still matters.
 */
export function confidenceFor(
  tier: MatchTier,
  signals: { referenceMatch: boolean; nameMatch: boolean; dayDifference: number },
): number {
  let score =
    tier === 'exact' ? 95 : tier === 'strong' ? 80 : tier === 'probable' ? 60 : 35;

  // Both the reference and the name agreeing is stronger than either alone.
  if (signals.referenceMatch && signals.nameMatch) score += 3;
  // Same-day settlement is more convincing than one a month later.
  const days = Math.abs(signals.dayDifference);
  if (days === 0) score += 2;
  else if (days > 30) score -= 5;

  return Math.max(5, Math.min(98, score));
}

export interface MatchResult {
  suggestions: MatchSuggestion[];
  /** Lines with no candidate at all, which a person must deal with by hand. */
  unmatchedLineIds: string[];
}

/**
 * Matches a set of statement lines against a set of candidate vouchers.
 *
 * One suggestion per line, and one voucher used once: a voucher already proposed
 * for an earlier line is not offered again, because a single invoice cannot be
 * settled twice by two different deposits. Lines are taken in date order and
 * equally-confident candidates are broken oldest-first, so the earliest deposit
 * claims the oldest invoice — which is exactly what allocateSettlement will do
 * when the settlement is posted.
 *
 * Where several candidates tie, none is proposed. A tie means the rules cannot
 * tell them apart, and picking one arbitrarily is how a reconciliation ends up
 * confidently wrong.
 */
export function matchStatement(
  lines: readonly StatementLineForMatch[],
  candidates: readonly MatchCandidate[],
): MatchResult {
  const suggestions: MatchSuggestion[] = [];
  const unmatchedLineIds: string[] = [];
  const taken = new Set<string>();

  const ordered = [...lines].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const line of ordered) {
    const scored = candidates
      .filter((c) => !taken.has(c.voucherId))
      .map((c) => scoreMatch(line, c))
      .filter((s): s is MatchSuggestion => s !== null)
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        // Equal confidence: the older voucher wins, because that is what
        // allocation will actually do when the settlement is posted. A matcher
        // that suggested the newer invoice while allocateSettlement applied the
        // money to the older one would make the suggestion and the books
        // disagree about which document was paid.
        if (a.voucherDate !== b.voucherDate) return a.voucherDate < b.voucherDate ? -1 : 1;
        return Math.abs(a.dayDifference) - Math.abs(b.dayDifference);
      });

    const best = scored[0];
    if (!best) {
      unmatchedLineIds.push(line.id);
      continue;
    }

    // A tie on confidence AND voucher date means the rules genuinely cannot tell
    // the candidates apart — two invoices to the same customer, same amount,
    // same day. Picking either arbitrarily is how a reconciliation ends up
    // confidently wrong.
    const runnerUp = scored[1];
    if (
      runnerUp &&
      runnerUp.confidence === best.confidence &&
      runnerUp.voucherDate === best.voucherDate
    ) {
      unmatchedLineIds.push(line.id);
      continue;
    }

    suggestions.push(best);
    taken.add(best.voucherId);
  }

  return { suggestions, unmatchedLineIds };
}

export const MATCH_TIER_LABELS: Record<MatchTier, string> = {
  exact: 'Exact — amount and reference agree',
  strong: 'Strong — amount agrees and the party is named',
  probable: 'Probable — amount agrees and the dates are close',
  weak: 'Weak — only the amount agrees',
};
