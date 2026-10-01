import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NO_PAN_FLOOR_BPS,
  ruleInForce,
  suggestTds,
  type TdsRule,
} from '../../src/lib/tds/engine';

const rule = (over: Partial<TdsRule> = {}): TdsRule => ({
  section: '194C',
  label: 'Payments to contractors',
  rateBps: 200, // 2%
  thresholdSinglePaise: 30_000_00n,
  thresholdAnnualPaise: 1_00_000_00n,
  effectiveFrom: '2020-04-01',
  effectiveTo: null,
  needsCaVerification: true,
  sourceNote: null,
  ...over,
});

const ask = (
  payment: Partial<Parameters<typeof suggestTds>[0]['payment']> = {},
  rules: readonly TdsRule[] = [rule()],
) =>
  suggestTds({
    rules,
    payment: {
      section: '194C',
      paymentDate: '2025-06-15',
      amountPaise: 50_000_00n,
      paidThisYearPaise: 0n,
      alreadyDeductedPaise: 0n,
      partyHasPan: true,
      ...payment,
    },
  });

describe('ruleInForce', () => {
  const old = rule({ rateBps: 500, effectiveFrom: '2020-04-01', effectiveTo: '2024-09-30' });
  const current = rule({ rateBps: 200, effectiveFrom: '2024-10-01', effectiveTo: null });

  it('picks the rule in force on the date', () => {
    expect(ruleInForce([old, current], '194C', '2024-09-15')?.rateBps).toBe(500);
    expect(ruleInForce([old, current], '194C', '2024-10-15')?.rateBps).toBe(200);
  });

  it('respects the boundary days exactly', () => {
    expect(ruleInForce([old, current], '194C', '2024-09-30')?.rateBps).toBe(500);
    expect(ruleInForce([old, current], '194C', '2024-10-01')?.rateBps).toBe(200);
  });

  it('finds nothing before any rule came into force', () => {
    expect(ruleInForce([old, current], '194C', '2019-01-01')).toBeNull();
  });

  it('finds nothing for another section', () => {
    expect(ruleInForce([old, current], '194J', '2025-06-15')).toBeNull();
  });

  it('prefers the latest rule where two overlap', () => {
    // A rule left open-ended and a later one starting inside it: the later wins.
    const openEnded = rule({ rateBps: 500, effectiveFrom: '2020-04-01', effectiveTo: null });
    const later = rule({ rateBps: 200, effectiveFrom: '2024-10-01', effectiveTo: null });
    expect(ruleInForce([openEnded, later], '194C', '2025-01-01')?.rateBps).toBe(200);
  });
});

describe('thresholds', () => {
  it('suggests nothing below both thresholds', () => {
    const result = ask({ amountPaise: 20_000_00n, paidThisYearPaise: 10_000_00n });
    expect(result.outcome).toBe('below_threshold');
    expect(result.deductNowPaise).toBe(0n);
    expect(result.reason).toMatch(/below the single-payment threshold/);
    expect(result.reason).toMatch(/below the annual threshold/);
  });

  it('deducts when a single payment reaches the single threshold', () => {
    const result = ask({ amountPaise: 30_000_00n });
    expect(result.outcome).toBe('deduct');
    // 2% of ₹30,000.
    expect(result.deductNowPaise).toBe(600_00n);
  });

  it('treats the threshold as inclusive', () => {
    expect(ask({ amountPaise: 30_000_00n }).outcome).toBe('deduct');
    expect(ask({ amountPaise: 29_999_99n }).outcome).toBe('below_threshold');
  });

  it('catches a supplier paid in instalments below the single threshold', () => {
    // ₹25,000 a month: never crosses the single threshold, crosses the annual one
    // on the fourth payment. An engine looking only at the payment in front of it
    // would miss deduction on ₹3,00,000 a year.
    const monthly = 25_000_00n;
    const first = ask({ amountPaise: monthly, paidThisYearPaise: 0n });
    expect(first.outcome).toBe('below_threshold');

    const fourth = ask({ amountPaise: monthly, paidThisYearPaise: monthly * 3n });
    expect(fourth.outcome).toBe('deduct');
  });

  it('brings the whole year into charge once the annual threshold is crossed', () => {
    // Not just the payment that crossed it. This is the part most easily got
    // wrong, and the mistake that produces a demand with interest.
    const result = ask({ amountPaise: 25_000_00n, paidThisYearPaise: 75_000_00n });
    expect(result.deductibleBasePaise).toBe(1_00_000_00n);
    // 2% of the full ₹1,00,000, not of the ₹25,000.
    expect(result.deductNowPaise).toBe(2_000_00n);
    expect(result.reason).toMatch(/brings the whole year into charge/);
  });

  it('nets off what has already been deducted', () => {
    const result = ask({
      amountPaise: 25_000_00n,
      paidThisYearPaise: 1_00_000_00n,
      alreadyDeductedPaise: 2_000_00n,
    });
    // 2% of ₹1,25,000 is ₹2,500, less ₹2,000 already taken.
    expect(result.totalTdsForYearPaise).toBe(2_500_00n);
    expect(result.deductNowPaise).toBe(500_00n);
    expect(result.reason).toMatch(/already been deducted/);
  });

  it('never suggests a negative deduction when too much was taken already', () => {
    const result = ask({
      amountPaise: 30_000_00n,
      alreadyDeductedPaise: 99_000_00n,
    });
    expect(result.deductNowPaise).toBe(0n);
  });

  it('deducts from the first rupee where a section has no threshold', () => {
    const result = ask(
      { amountPaise: 1_00n },
      [rule({ section: '192', thresholdSinglePaise: null, thresholdAnnualPaise: null })],
    );
    expect(ask({ section: '192', amountPaise: 1_00n }, [
      rule({ section: '192', thresholdSinglePaise: null, thresholdAnnualPaise: null }),
    ]).outcome).toBe('deduct');
    expect(result.section).toBe('194C');
  });
});

describe('Section 206AA, where there is no PAN', () => {
  it('applies the higher of twice the rate and the floor', () => {
    // 2% doubled is 4%, which is below the 20% floor, so the floor applies.
    const result = ask({ partyHasPan: false, amountPaise: 1_00_000_00n });
    expect(result.rateBpsApplied).toBe(DEFAULT_NO_PAN_FLOOR_BPS);
    expect(result.deductNowPaise).toBe(20_000_00n);
    expect(result.rateBasis).toMatch(/206AA/);
  });

  it('uses twice the rate where that exceeds the floor', () => {
    // 15% doubled is 30%, above the 20% floor.
    const result = suggestTds({
      rules: [rule({ rateBps: 1500 })],
      payment: {
        section: '194C',
        paymentDate: '2025-06-15',
        amountPaise: 1_00_000_00n,
        paidThisYearPaise: 0n,
        alreadyDeductedPaise: 0n,
        partyHasPan: false,
      },
    });
    expect(result.rateBpsApplied).toBe(3000);
    expect(result.deductNowPaise).toBe(30_000_00n);
  });

  it('honours a floor passed in, since the figure can change', () => {
    const result = suggestTds({
      rules: [rule()],
      noPanFloorBps: 2500,
      payment: {
        section: '194C',
        paymentDate: '2025-06-15',
        amountPaise: 1_00_000_00n,
        paidThisYearPaise: 0n,
        alreadyDeductedPaise: 0n,
        partyHasPan: false,
      },
    });
    expect(result.rateBpsApplied).toBe(2500);
  });

  it('does not change the rate where there is a PAN', () => {
    expect(ask({ partyHasPan: true }).rateBpsApplied).toBe(200);
  });
});

describe('when no rule applies', () => {
  it('says so rather than suggesting nothing to deduct', () => {
    // "No rule is set up" and "nothing is deductible" are different answers, and
    // only one of them means the payment is safe to make.
    const result = ask({ section: '194Q' });
    expect(result.outcome).toBe('no_rule');
    expect(result.deductNowPaise).toBe(0n);
    expect(result.reason).toMatch(/not the same as nothing being deductible/);
  });

  it('distinguishes a rule that exists but is not yet in force', () => {
    const result = ask({ paymentDate: '2019-01-01' });
    expect(result.outcome).toBe('rule_not_effective');
    expect(result.reason).toMatch(/Check the effective dates/);
  });
});

describe('rounding', () => {
  it('rounds half away from zero, in integers', () => {
    // 0.1% of ₹1,00,005 is ₹100.005, which rounds to ₹100.01.
    const result = suggestTds({
      rules: [rule({ rateBps: 10, thresholdSinglePaise: null, thresholdAnnualPaise: null })],
      payment: {
        section: '194C',
        paymentDate: '2025-06-15',
        amountPaise: 1_00_005_00n,
        paidThisYearPaise: 0n,
        alreadyDeductedPaise: 0n,
        partyHasPan: true,
      },
    });
    expect(result.deductNowPaise).toBe(100_01n);
  });

  it('handles an amount beyond what a float holds exactly', () => {
    const result = suggestTds({
      rules: [rule({ rateBps: 200, thresholdSinglePaise: null, thresholdAnnualPaise: null })],
      payment: {
        section: '194C',
        paymentDate: '2025-06-15',
        amountPaise: 92_233_720_368_55n,
        paidThisYearPaise: 0n,
        alreadyDeductedPaise: 0n,
        partyHasPan: true,
      },
    });
    expect(result.deductNowPaise).toBe(1_844_674_407_37n);
  });
});

describe('the verification flag', () => {
  it('carries the rule’s own flag through to the suggestion', () => {
    expect(ask().needsCaVerification).toBe(true);
    expect(ask({}, [rule({ needsCaVerification: false })]).needsCaVerification).toBe(false);
  });

  it('always flags a missing rule for verification', () => {
    expect(ask({ section: '194Q' }).needsCaVerification).toBe(true);
  });
});
