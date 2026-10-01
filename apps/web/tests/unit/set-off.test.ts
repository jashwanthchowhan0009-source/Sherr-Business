import { describe, expect, it } from 'vitest';
import {
  addTax,
  setOffInputTaxCredit,
  totalTax,
  zeroTax,
  type TaxAmounts,
} from '../../src/lib/gst/set-off';

const tax = (over: Partial<TaxAmounts> = {}): TaxAmounts => ({ ...zeroTax(), ...over });

const run = (liability: Partial<TaxAmounts>, creditAvailable: Partial<TaxAmounts>) =>
  setOffInputTaxCredit({ liability: tax(liability), creditAvailable: tax(creditAvailable) });

/** Credit applied from one head to another, across all steps. */
const applied = (
  result: ReturnType<typeof setOffInputTaxCredit>,
  from: string,
  to: string,
): bigint =>
  result.steps
    .filter((s) => s.creditHead === from && s.liabilityHead === to)
    .reduce((acc, s) => acc + s.amountPaise, 0n);

describe('the absolute constraints', () => {
  it('never pays SGST with CGST credit', () => {
    // There is no provision permitting it, and doing so is the classic set-off
    // error. A surplus of CGST credit beside an SGST liability must stay unused.
    const result = run({ sgst: 10_000_00n }, { cgst: 50_000_00n });
    expect(applied(result, 'cgst', 'sgst')).toBe(0n);
    expect(result.payableInCash.sgst).toBe(10_000_00n);
    expect(result.creditCarriedForward.cgst).toBe(50_000_00n);
  });

  it('never pays CGST with SGST credit', () => {
    const result = run({ cgst: 10_000_00n }, { sgst: 50_000_00n });
    expect(applied(result, 'sgst', 'cgst')).toBe(0n);
    expect(result.payableInCash.cgst).toBe(10_000_00n);
  });

  it('never pays anything but cess with cess credit', () => {
    const result = run({ igst: 10_000_00n, cgst: 5_000_00n }, { cess: 99_000_00n });
    expect(result.steps.filter((s) => s.creditHead === 'cess')).toEqual([]);
    expect(result.totalPayableInCashPaise).toBe(15_000_00n);
  });

  it('never pays cess with anything but cess credit', () => {
    const result = run({ cess: 10_000_00n }, { igst: 99_000_00n, cgst: 99_000_00n });
    expect(result.payableInCash.cess).toBe(10_000_00n);
    expect(result.steps.filter((s) => s.liabilityHead === 'cess')).toEqual([]);
  });
});

describe('the order of utilisation', () => {
  it('uses IGST credit before CGST or SGST credit, as Section 49A requires', () => {
    // Liability CGST 10,000. Credit: IGST 10,000 and CGST 10,000. The IGST
    // credit must go first, leaving the CGST credit untouched.
    const result = run({ cgst: 10_000_00n }, { igst: 10_000_00n, cgst: 10_000_00n });
    expect(applied(result, 'igst', 'cgst')).toBe(10_000_00n);
    expect(applied(result, 'cgst', 'cgst')).toBe(0n);
    expect(result.creditCarriedForward.cgst).toBe(10_000_00n);
    expect(result.creditCarriedForward.igst).toBe(0n);
  });

  it('pays IGST liability from IGST credit before spending it elsewhere', () => {
    const result = run(
      { igst: 6_000_00n, cgst: 6_000_00n },
      { igst: 10_000_00n },
    );
    expect(applied(result, 'igst', 'igst')).toBe(6_000_00n);
    expect(applied(result, 'igst', 'cgst')).toBe(4_000_00n);
    expect(result.payableInCash.cgst).toBe(2_000_00n);
  });

  it('spreads surplus IGST credit to CGST before SGST, by convention', () => {
    // Rule 88A permits either order. CGST first is the convention taken, and the
    // choice is recorded in the step's authority so a CA can see it was a choice.
    const result = run(
      { cgst: 5_000_00n, sgst: 5_000_00n },
      { igst: 7_000_00n },
    );
    expect(applied(result, 'igst', 'cgst')).toBe(5_000_00n);
    expect(applied(result, 'igst', 'sgst')).toBe(2_000_00n);
    expect(result.steps.some((s) => s.authority.includes('Rule 88A'))).toBe(true);
  });

  it('uses own-head credit before cross-utilising to IGST', () => {
    const result = run(
      { igst: 10_000_00n, cgst: 4_000_00n },
      { cgst: 10_000_00n },
    );
    // CGST credit pays its own CGST liability first, then the balance goes to IGST.
    expect(applied(result, 'cgst', 'cgst')).toBe(4_000_00n);
    expect(applied(result, 'cgst', 'igst')).toBe(6_000_00n);
    expect(result.payableInCash.igst).toBe(4_000_00n);
  });

  it('records the provision relied on for every step', () => {
    const result = run(
      { igst: 1_000_00n, cgst: 1_000_00n, sgst: 1_000_00n, cess: 1_000_00n },
      { igst: 1_000_00n, cgst: 1_000_00n, sgst: 1_000_00n, cess: 1_000_00n },
    );
    expect(result.steps.length).toBeGreaterThan(0);
    for (const step of result.steps) {
      expect(
        step.authority,
        `${step.creditHead} credit to ${step.liabilityHead} liability`,
      ).toMatch(/Section 49/);
    }
  });
});

describe('the worked example from the §11 acceptance cases', () => {
  // Output tax on ₹1,00,000 of intra-state sales at 18%, input credit from a
  // ₹50,000 intra-state purchase at 18%.
  const result = run(
    { cgst: 9_000_00n, sgst: 9_000_00n },
    { cgst: 4_500_00n, sgst: 4_500_00n },
  );

  it('sets off each head against its own', () => {
    expect(applied(result, 'cgst', 'cgst')).toBe(4_500_00n);
    expect(applied(result, 'sgst', 'sgst')).toBe(4_500_00n);
  });

  it('leaves the balance payable in cash', () => {
    expect(result.payableInCash.cgst).toBe(4_500_00n);
    expect(result.payableInCash.sgst).toBe(4_500_00n);
    expect(result.totalPayableInCashPaise).toBe(9_000_00n);
  });

  it('carries nothing forward', () => {
    expect(totalTax(result.creditCarriedForward)).toBe(0n);
  });
});

describe('arithmetic that must always hold', () => {
  const cases: [Partial<TaxAmounts>, Partial<TaxAmounts>][] = [
    [{}, {}],
    [{ igst: 1n }, {}],
    [{}, { igst: 1n }],
    [{ igst: 10_000_00n, cgst: 5_000_00n, sgst: 5_000_00n, cess: 1_000_00n },
     { igst: 3_000_00n, cgst: 6_000_00n, sgst: 2_000_00n, cess: 500_00n }],
    [{ cgst: 100_00n, sgst: 100_00n }, { igst: 1_00_000_00n }],
    [{ igst: 1_00_000_00n }, { cgst: 50_000_00n, sgst: 50_000_00n }],
    [{ sgst: 7n }, { cgst: 7n }],
    [{ igst: 9_999_99n, cgst: 1n }, { igst: 1n, cgst: 9_999_99n }],
  ];

  it('never uses more credit than was available', () => {
    for (const [liability, credit] of cases) {
      const result = run(liability, credit);
      for (const head of ['igst', 'cgst', 'sgst', 'cess'] as const) {
        expect(result.creditUsed[head]).toBeLessThanOrEqual(result.creditAvailable[head]);
      }
    }
  });

  it('accounts for every rupee of credit, used or carried forward', () => {
    for (const [liability, credit] of cases) {
      const result = run(liability, credit);
      expect(totalTax(addTax(result.creditUsed, result.creditCarriedForward))).toBe(
        totalTax(result.creditAvailable),
      );
    }
  });

  it('accounts for every rupee of liability, by credit or in cash', () => {
    for (const [liability, credit] of cases) {
      const result = run(liability, credit);
      expect(result.totalCreditUsedPaise + result.totalPayableInCashPaise).toBe(
        totalTax(result.liability),
      );
    }
  });

  it('never leaves both credit and liability outstanding on the same head', () => {
    // Except where the rules forbid the set-off: a CGST surplus beside an SGST
    // liability is correct, so the check is per head rather than overall.
    for (const [liability, credit] of cases) {
      const result = run(liability, credit);
      for (const head of ['igst', 'cgst', 'sgst', 'cess'] as const) {
        const stillOwed = result.payableInCash[head];
        const unusedSameHead = result.creditCarriedForward[head];
        expect(
          stillOwed === 0n || unusedSameHead === 0n,
          `${head}: owed ${stillOwed}, unused ${unusedSameHead}`,
        ).toBe(true);
      }
    }
  });

  it('never carries forward IGST credit while any liability remains', () => {
    // IGST credit can pay any head, so an unpaid liability alongside unused IGST
    // credit would be a bug in the ordering.
    for (const [liability, credit] of cases) {
      const result = run(liability, credit);
      if (result.creditCarriedForward.igst > 0n) {
        // Cess is the exception: IGST credit cannot pay it.
        expect(result.payableInCash.igst).toBe(0n);
        expect(result.payableInCash.cgst).toBe(0n);
        expect(result.payableInCash.sgst).toBe(0n);
      }
    }
  });

  it('is a no-op with no liability and no credit', () => {
    const result = run({}, {});
    expect(result.steps).toEqual([]);
    expect(result.totalPayableInCashPaise).toBe(0n);
  });

  it('refuses a negative liability or credit rather than producing nonsense', () => {
    expect(() => run({ igst: -1n }, {})).toThrow(/cannot be negative/);
    expect(() => run({}, { cgst: -1n })).toThrow(/cannot be negative/);
  });
});

describe('the verification flag', () => {
  it('always says the rule needs CA verification', () => {
    // The product has no verified set-off rule and will not claim one until a
    // professional signs this sequence off.
    expect(run({ igst: 1n }, { igst: 1n }).needsCaVerification).toBe(true);
    expect(run({}, {}).needsCaVerification).toBe(true);
  });
});
