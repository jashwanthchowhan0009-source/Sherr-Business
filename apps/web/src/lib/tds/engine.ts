/**
 * TDS suggestions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  SUGGESTIONS, NOT DEDUCTIONS. This engine proposes; a person decides. It
 *  never alters a voucher and never deducts anything by itself.
 *
 *  Every rate, threshold and section comes from the versioned `tax_rules`
 *  table and is passed in — nothing is hardcoded here. Each rule carries
 *  `needsCaVerification` until a professional signs it off, and a suggestion
 *  derived from an unverified rule says so.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Why thresholds need the year, not just the payment: most sections have both a
 * single-payment threshold and an annual aggregate one, and the aggregate is what
 * catches a supplier paid ₹25,000 a month. A engine that looked only at the
 * payment in front of it would miss deduction on ₹3,00,000 a year, which is the
 * mistake that produces a demand with interest.
 *
 * Integer paise and basis points throughout.
 */
import { BPS_SCALE, divideHalfUp } from '@/lib/accounting/units';

export interface TdsRule {
  /** The section, as it is cited: '194C', '194J'. */
  section: string;
  label: string;
  rateBps: number;
  /** A single payment at or above this attracts deduction. Null means no single-payment test. */
  thresholdSinglePaise: bigint | null;
  /** Aggregate payments in the year at or above this attract deduction. */
  thresholdAnnualPaise: bigint | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  needsCaVerification: boolean;
  sourceNote: string | null;
}

export interface TdsPaymentContext {
  /** The section the person has chosen for this nature of payment. */
  section: string;
  paymentDate: string;
  /** This payment, before tax. */
  amountPaise: bigint;
  /** Everything already paid to this party under this section this financial year. */
  paidThisYearPaise: bigint;
  /** Whether tax has already been deducted from this party this year, and how much. */
  alreadyDeductedPaise: bigint;
  /** No PAN means a higher rate under Section 206AA. */
  partyHasPan: boolean;
}

export type TdsOutcome =
  | 'deduct'
  | 'below_threshold'
  | 'no_rule'
  | 'rule_not_effective';

export interface TdsSuggestion {
  outcome: TdsOutcome;
  section: string;
  /** The rule applied, where one was found. */
  rule: TdsRule | null;
  /** The rate actually used, which may be the no-PAN rate rather than the rule's. */
  rateBpsApplied: number;
  /** Why that rate: the rule, or Section 206AA. */
  rateBasis: string;
  /**
   * The amount deduction is computed on. Once a threshold is crossed, the whole
   * year's payments come into charge, not just the payment that crossed it — so
   * this is not always the payment in front of you.
   */
  deductibleBasePaise: bigint;
  /** Total that should have been deducted this year on that base. */
  totalTdsForYearPaise: bigint;
  /** What to deduct from THIS payment, after what has already been deducted. */
  deductNowPaise: bigint;
  /** In words a person can act on. */
  reason: string;
  needsCaVerification: boolean;
}

/**
 * The rate to apply where the party has no PAN.
 *
 * Section 206AA requires the higher of twice the rule's rate and 20%. The 20% is
 * expressed in basis points and is itself a figure that has changed, so it is a
 * parameter with a documented default rather than a constant buried in the
 * calculation.
 */
export const DEFAULT_NO_PAN_FLOOR_BPS = 2000;

/** Picks the rule in force on a date. */
export function ruleInForce(
  rules: readonly TdsRule[],
  section: string,
  onDate: string,
): TdsRule | null {
  const candidates = rules
    .filter((r) => r.section === section)
    .filter((r) => r.effectiveFrom <= onDate)
    .filter((r) => r.effectiveTo === null || r.effectiveTo >= onDate)
    // The latest rule that had come into force by this date.
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return candidates[0] ?? null;
}

/**
 * Suggests what to deduct from a payment.
 *
 * Returns an outcome rather than a bare number, because "nothing to deduct" and
 * "no rule for this section" are different answers and only one of them means the
 * payment is safe to make.
 */
export function suggestTds(input: {
  rules: readonly TdsRule[];
  payment: TdsPaymentContext;
  noPanFloorBps?: number;
}): TdsSuggestion {
  const { payment } = input;
  const noPanFloor = input.noPanFloorBps ?? DEFAULT_NO_PAN_FLOOR_BPS;

  const anyForSection = input.rules.some((r) => r.section === payment.section);
  const rule = ruleInForce(input.rules, payment.section, payment.paymentDate);

  if (!rule) {
    return {
      outcome: anyForSection ? 'rule_not_effective' : 'no_rule',
      section: payment.section,
      rule: null,
      rateBpsApplied: 0,
      rateBasis: 'No rule found',
      deductibleBasePaise: 0n,
      totalTdsForYearPaise: 0n,
      deductNowPaise: 0n,
      reason: anyForSection
        ? `A rule exists for section ${payment.section} but none is in force on ${payment.paymentDate}. ` +
          'Check the effective dates before paying.'
        : `No rule for section ${payment.section} is set up. Nothing can be suggested, which is ` +
          'not the same as nothing being deductible.',
      needsCaVerification: true,
    };
  }

  const aggregatePaise = payment.paidThisYearPaise + payment.amountPaise;

  // Either test can trigger deduction. The single-payment test looks at this
  // payment; the annual test looks at everything paid this year including it.
  const singleCrossed =
    rule.thresholdSinglePaise !== null && payment.amountPaise >= rule.thresholdSinglePaise;
  const annualCrossed =
    rule.thresholdAnnualPaise !== null && aggregatePaise >= rule.thresholdAnnualPaise;
  const noThresholds = rule.thresholdSinglePaise === null && rule.thresholdAnnualPaise === null;

  if (!singleCrossed && !annualCrossed && !noThresholds) {
    return {
      outcome: 'below_threshold',
      section: payment.section,
      rule,
      rateBpsApplied: 0,
      rateBasis: 'Below the threshold',
      deductibleBasePaise: 0n,
      totalTdsForYearPaise: 0n,
      deductNowPaise: 0n,
      reason: describeBelowThreshold(rule, payment, aggregatePaise),
      needsCaVerification: rule.needsCaVerification,
    };
  }

  // Section 206AA: the higher of twice the rule's rate and the floor.
  const rateBpsApplied = payment.partyHasPan
    ? rule.rateBps
    : Math.max(rule.rateBps * 2, noPanFloor);
  const rateBasis = payment.partyHasPan
    ? `Section ${rule.section} at ${(rule.rateBps / 100).toFixed(2)}%`
    : `Section 206AA — no PAN, so the higher of twice ${(rule.rateBps / 100).toFixed(2)}% and ` +
      `${(noPanFloor / 100).toFixed(0)}%`;

  // Once a threshold is crossed, the year's payments come into charge, not only
  // the payment that crossed it. This is the part most easily got wrong, and it
  // is why `paidThisYearPaise` has to be supplied.
  const deductibleBasePaise = annualCrossed && !singleCrossed ? aggregatePaise : payment.amountPaise;

  const totalTdsForYearPaise = divideHalfUp(
    deductibleBasePaise * BigInt(rateBpsApplied),
    BPS_SCALE,
  );
  const outstanding = totalTdsForYearPaise - payment.alreadyDeductedPaise;
  const deductNowPaise = outstanding > 0n ? outstanding : 0n;

  return {
    outcome: 'deduct',
    section: payment.section,
    rule,
    rateBpsApplied,
    rateBasis,
    deductibleBasePaise,
    totalTdsForYearPaise,
    deductNowPaise,
    reason: describeDeduct({
      rule,
      payment,
      aggregatePaise,
      singleCrossed,
      annualCrossed,
      deductibleBasePaise,
      rateBpsApplied,
      deductNowPaise,
      alreadyDeductedPaise: payment.alreadyDeductedPaise,
    }),
    needsCaVerification: rule.needsCaVerification,
  };
}

const rupees = (paise: bigint) => {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? '-' : ''}₹${(abs / 100n).toString()}`;
};

function describeBelowThreshold(
  rule: TdsRule,
  payment: TdsPaymentContext,
  aggregatePaise: bigint,
): string {
  const parts: string[] = [];
  if (rule.thresholdSinglePaise !== null) {
    parts.push(
      `this payment of ${rupees(payment.amountPaise)} is below the single-payment threshold of ` +
        rupees(rule.thresholdSinglePaise),
    );
  }
  if (rule.thresholdAnnualPaise !== null) {
    parts.push(
      `the year's payments of ${rupees(aggregatePaise)} are below the annual threshold of ` +
        rupees(rule.thresholdAnnualPaise),
    );
  }
  return `No deduction suggested under section ${rule.section}: ${parts.join(', and ')}.`;
}

function describeDeduct(input: {
  rule: TdsRule;
  payment: TdsPaymentContext;
  aggregatePaise: bigint;
  singleCrossed: boolean;
  annualCrossed: boolean;
  deductibleBasePaise: bigint;
  rateBpsApplied: number;
  deductNowPaise: bigint;
  alreadyDeductedPaise: bigint;
}): string {
  const why = input.singleCrossed
    ? `this payment of ${rupees(input.payment.amountPaise)} is at or above the single-payment ` +
      `threshold of ${rupees(input.rule.thresholdSinglePaise ?? 0n)}`
    : input.annualCrossed
      ? `the year's payments of ${rupees(input.aggregatePaise)} have reached the annual threshold ` +
        `of ${rupees(input.rule.thresholdAnnualPaise ?? 0n)}, which brings the whole year into charge`
      : `section ${input.rule.section} has no threshold`;

  const already =
    input.alreadyDeductedPaise > 0n
      ? ` ${rupees(input.alreadyDeductedPaise)} has already been deducted this year, so ` +
        `${rupees(input.deductNowPaise)} is outstanding.`
      : '';

  return (
    `Deduct ${rupees(input.deductNowPaise)} under section ${input.rule.section}: ${why}. ` +
    `At ${(input.rateBpsApplied / 100).toFixed(2)}% on ${rupees(input.deductibleBasePaise)}.${already}`
  );
}
