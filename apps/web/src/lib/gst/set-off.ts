/**
 * The input tax credit set-off order.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE MOST COMPLIANCE-SENSITIVE CALCULATION IN THE PRODUCT.
 *
 *  The sequence below is my reading of Section 49, Section 49A and Rule 88A of
 *  the CGST Act and Rules. It is NOT professional advice, it has NOT been
 *  verified by a qualified professional, and the rule carrying it is flagged
 *  `needs_ca_verification` until one signs it off. Every figure it produces is
 *  presented as a working, with each step shown, precisely so that a CA can
 *  check the reasoning rather than being asked to trust a total.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The order, as I read it:
 *
 *   1. IGST credit pays IGST liability.
 *   2. IGST credit remaining pays CGST, then SGST. Rule 88A permits either
 *      order between the two; CGST first is the common convention and the one
 *      taken here.
 *   3. Section 49A requires IGST credit to be exhausted before CGST or SGST
 *      credit is used at all, so nothing below runs until step 2 has taken the
 *      IGST credit as far as it goes.
 *   4. CGST credit pays CGST liability.
 *   5. SGST credit pays SGST liability.
 *   6. CGST credit remaining pays IGST liability.
 *   7. SGST credit remaining pays IGST liability.
 *   8. Cess credit pays cess liability, and nothing else.
 *
 * Two constraints are absolute and are asserted by the tests:
 *   - CGST credit can never pay SGST, and SGST credit can never pay CGST.
 *   - Cess credit can pay nothing but cess.
 *
 * Integer paise throughout. A rounding error in a set-off becomes a mismatch
 * with the portal, and a mismatch with the portal becomes a notice.
 */

export type TaxHead = 'igst' | 'cgst' | 'sgst' | 'cess';

export interface TaxAmounts {
  igst: bigint;
  cgst: bigint;
  sgst: bigint;
  cess: bigint;
}

export const zeroTax = (): TaxAmounts => ({ igst: 0n, cgst: 0n, sgst: 0n, cess: 0n });

export const addTax = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => ({
  igst: a.igst + b.igst,
  cgst: a.cgst + b.cgst,
  sgst: a.sgst + b.sgst,
  cess: a.cess + b.cess,
});

export const totalTax = (t: TaxAmounts): bigint => t.igst + t.cgst + t.sgst + t.cess;

export interface SetOffStep {
  /** Which credit was used. */
  creditHead: TaxHead;
  /** Which liability it was applied to. */
  liabilityHead: TaxHead;
  amountPaise: bigint;
  /** The rule this step implements, for a CA to check against. */
  authority: string;
}

export interface SetOffResult {
  liability: TaxAmounts;
  creditAvailable: TaxAmounts;
  /** Every application of credit to liability, in the order it was made. */
  steps: SetOffStep[];
  /** Credit used, by head. */
  creditUsed: TaxAmounts;
  /** Credit left over, carried forward. */
  creditCarriedForward: TaxAmounts;
  /** Liability left after credit, payable in cash. */
  payableInCash: TaxAmounts;
  totalPayableInCashPaise: bigint;
  totalCreditUsedPaise: bigint;
  /**
   * Always true. The product does not have a verified set-off rule, and will
   * not until a professional signs this sequence off.
   */
  needsCaVerification: true;
}

/** Applies as much credit as both the credit and the liability allow. */
function apply(
  credit: { remaining: bigint },
  liability: { remaining: bigint },
  creditHead: TaxHead,
  liabilityHead: TaxHead,
  authority: string,
  steps: SetOffStep[],
): void {
  if (credit.remaining <= 0n || liability.remaining <= 0n) return;
  const amountPaise =
    credit.remaining < liability.remaining ? credit.remaining : liability.remaining;
  credit.remaining -= amountPaise;
  liability.remaining -= amountPaise;
  steps.push({ creditHead, liabilityHead, amountPaise, authority });
}

/**
 * Works out how a period's liability is settled from available credit.
 *
 * Deterministic and pure. The returned `steps` are the working: each names the
 * credit used, the liability it paid and the provision relied on, so the result
 * can be checked rather than taken on trust.
 */
export function setOffInputTaxCredit(input: {
  liability: TaxAmounts;
  creditAvailable: TaxAmounts;
}): SetOffResult {
  for (const [head, value] of Object.entries(input.liability)) {
    if (value < 0n) throw new RangeError(`Liability for ${head} cannot be negative`);
  }
  for (const [head, value] of Object.entries(input.creditAvailable)) {
    if (value < 0n) throw new RangeError(`Credit for ${head} cannot be negative`);
  }

  const credit = {
    igst: { remaining: input.creditAvailable.igst },
    cgst: { remaining: input.creditAvailable.cgst },
    sgst: { remaining: input.creditAvailable.sgst },
    cess: { remaining: input.creditAvailable.cess },
  };
  const liability = {
    igst: { remaining: input.liability.igst },
    cgst: { remaining: input.liability.cgst },
    sgst: { remaining: input.liability.sgst },
    cess: { remaining: input.liability.cess },
  };

  const steps: SetOffStep[] = [];
  const S49_5_A = 'Section 49(5)(a): IGST credit towards IGST, then CGST, then SGST';
  const S49A = 'Section 49A: IGST credit must be fully used before CGST or SGST credit';
  const S49_5_B = 'Section 49(5)(b): CGST credit towards CGST, then IGST';
  const S49_5_C = 'Section 49(5)(c): SGST credit towards SGST, then IGST';
  const S49_5_E = 'Section 49(5)(e)-(f): cess credit towards cess only';

  // 1-2. IGST credit first, across IGST then CGST then SGST. Rule 88A allows
  // either order between CGST and SGST; CGST first is the common convention.
  apply(credit.igst, liability.igst, 'igst', 'igst', S49_5_A, steps);
  apply(credit.igst, liability.cgst, 'igst', 'cgst', `${S49_5_A} (Rule 88A)`, steps);
  apply(credit.igst, liability.sgst, 'igst', 'sgst', `${S49_5_A} (Rule 88A)`, steps);

  // 3-5. Only now may CGST and SGST credit be used, each against its own head
  // first. Section 49A is what orders these after the IGST credit above.
  apply(credit.cgst, liability.cgst, 'cgst', 'cgst', `${S49_5_B}; ${S49A}`, steps);
  apply(credit.sgst, liability.sgst, 'sgst', 'sgst', `${S49_5_C}; ${S49A}`, steps);

  // 6-7. Whatever CGST or SGST credit is left may pay IGST. It may never pay
  // the other state head — that constraint is the absence of any step here, and
  // the tests assert it rather than relying on the omission being noticed.
  apply(credit.cgst, liability.igst, 'cgst', 'igst', S49_5_B, steps);
  apply(credit.sgst, liability.igst, 'sgst', 'igst', S49_5_C, steps);

  // 8. Cess is self-contained in both directions.
  apply(credit.cess, liability.cess, 'cess', 'cess', S49_5_E, steps);

  const creditUsed: TaxAmounts = {
    igst: input.creditAvailable.igst - credit.igst.remaining,
    cgst: input.creditAvailable.cgst - credit.cgst.remaining,
    sgst: input.creditAvailable.sgst - credit.sgst.remaining,
    cess: input.creditAvailable.cess - credit.cess.remaining,
  };

  const payableInCash: TaxAmounts = {
    igst: liability.igst.remaining,
    cgst: liability.cgst.remaining,
    sgst: liability.sgst.remaining,
    cess: liability.cess.remaining,
  };

  return {
    liability: input.liability,
    creditAvailable: input.creditAvailable,
    steps,
    creditUsed,
    creditCarriedForward: {
      igst: credit.igst.remaining,
      cgst: credit.cgst.remaining,
      sgst: credit.sgst.remaining,
      cess: credit.cess.remaining,
    },
    payableInCash,
    totalPayableInCashPaise: totalTax(payableInCash),
    totalCreditUsedPaise: totalTax(creditUsed),
    needsCaVerification: true,
  };
}

export const HEAD_LABELS: Record<TaxHead, string> = {
  igst: 'IGST',
  cgst: 'CGST',
  sgst: 'SGST',
  cess: 'Cess',
};
