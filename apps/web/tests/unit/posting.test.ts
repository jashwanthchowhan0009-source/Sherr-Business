import { describe, expect, it } from 'vitest';
import {
  calculateInvoice,
  determineSupplyType,
  type GstLineInput,
  type SupplyType,
} from '../../src/lib/accounting/gst';
import {
  UnbalancedPostingError,
  assertBalanced,
  paymentEntries,
  purchaseBillEntries,
  receiptEntries,
  reverseEntries,
  salesInvoiceEntries,
  totals,
} from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';

/**
 * Composes the two engine calls the way a real posting does: the states decide
 * the supply type, then the lines are calculated under it.
 */
const calc = (input: {
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  supplyType?: SupplyType;
  lines: readonly GstLineInput[];
}) =>
  calculateInvoice(
    input.lines,
    input.supplyType ??
      determineSupplyType({
        supplierStateCode: input.supplierStateCode,
        placeOfSupplyStateCode: input.placeOfSupplyStateCode,
      }),
  );

const line = (rupees: bigint, rateBps: number, qty = 1n) => ({
  quantity: qty * QTY_SCALE,
  unitPricePaise: rupees * 100n,
  gstRateBps: rateBps,
});

const sum = (entries: readonly { accountCode: string; debitPaise: bigint; creditPaise: bigint }[],
             code: string) =>
  entries
    .filter((e) => e.accountCode === code)
    .reduce((acc, e) => acc + e.debitPaise - e.creditPaise, 0n);

describe('assertBalanced', () => {
  it('rejects an unbalanced set', () => {
    expect(() =>
      assertBalanced([
        { accountCode: 'CASH', debitPaise: 100n, creditPaise: 0n },
        { accountCode: 'SALES', debitPaise: 0n, creditPaise: 99n },
      ]),
    ).toThrow(UnbalancedPostingError);
  });

  it('names the difference, so the error is actionable', () => {
    expect(() =>
      assertBalanced([
        { accountCode: 'CASH', debitPaise: 100n, creditPaise: 0n },
        { accountCode: 'SALES', debitPaise: 0n, creditPaise: 99n },
      ]),
    ).toThrow(/difference 1/);
  });

  it('rejects a negative amount rather than flipping it silently', () => {
    expect(() =>
      assertBalanced([
        { accountCode: 'CASH', debitPaise: -100n, creditPaise: 0n },
        { accountCode: 'SALES', debitPaise: 0n, creditPaise: -100n },
      ]),
    ).toThrow(/Negative amount/);
  });

  it('rejects a debit and a credit on the same entry', () => {
    expect(() =>
      assertBalanced([{ accountCode: 'CASH', debitPaise: 100n, creditPaise: 100n }]),
    ).toThrow(/both a debit and a credit/);
  });
});

describe('salesInvoiceEntries', () => {
  it('posts the spec §11 intra-state invoice', () => {
    // ₹1,00,000 at 18% within Karnataka.
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(100_000n, 1800)],
    });
    const entries = salesInvoiceEntries(invoice);

    expect(sum(entries, 'SUNDRY_DEBTORS')).toBe(11_800_000n); // Dr ₹1,18,000
    expect(sum(entries, 'SALES')).toBe(-10_000_000n); // Cr ₹1,00,000
    expect(sum(entries, 'OUTPUT_CGST')).toBe(-900_000n); // Cr ₹9,000
    expect(sum(entries, 'OUTPUT_SGST')).toBe(-900_000n); // Cr ₹9,000
    expect(sum(entries, 'OUTPUT_IGST')).toBe(0n);
  });

  it('posts the spec §11 inter-state invoice to IGST alone', () => {
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '27',
      lines: [line(100_000n, 1800)],
    });
    const entries = salesInvoiceEntries(invoice);

    expect(sum(entries, 'OUTPUT_IGST')).toBe(-1_800_000n); // Cr ₹18,000
    expect(sum(entries, 'OUTPUT_CGST')).toBe(0n);
    expect(sum(entries, 'OUTPUT_SGST')).toBe(0n);
    // No CGST or SGST account appears at all, rather than appearing at zero.
    expect(entries.map((e) => e.accountCode)).not.toContain('OUTPUT_CGST');
  });

  it('balances for every rate and quantity combination', () => {
    for (const rate of [0, 25, 300, 500, 1200, 1800, 2800, 4000]) {
      for (const rupees of [1n, 7n, 99n, 1234n, 99_999n, 1_00_00_000n]) {
        for (const qty of [1n, 3n, 17n]) {
          const invoice = calc({
            supplierStateCode: '29',
            placeOfSupplyStateCode: rate % 2 === 0 ? '29' : '27',
            lines: [line(rupees, rate, qty)],
          });
          const { debitPaise, creditPaise } = totals(salesInvoiceEntries(invoice));
          expect(debitPaise, `rate ${rate}, ₹${rupees} x ${qty}`).toBe(creditPaise);
        }
      }
    }
  });

  it('credits Round Off when rounding up and debits it when rounding down', () => {
    const up = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [{ quantity: QTY_SCALE, unitPricePaise: 9_999n, gstRateBps: 1800 }],
    });
    const down = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [{ quantity: QTY_SCALE, unitPricePaise: 10_020n, gstRateBps: 1800 }],
    });

    // The sign of the round-off decides the side; whichever it is, the
    // debtor's balance equals the invoice total exactly.
    for (const invoice of [up, down]) {
      const entries = salesInvoiceEntries(invoice);
      expect(sum(entries, 'SUNDRY_DEBTORS')).toBe(invoice.totalPaise);
      expect(sum(entries, 'ROUND_OFF')).toBe(-invoice.roundOffPaise);
      expect(invoice.totalPaise % 100n).toBe(0n);
    }
  });

  it('omits Round Off entirely when the total is already whole rupees', () => {
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(100_000n, 1800)],
    });
    expect(invoice.roundOffPaise).toBe(0n);
    expect(salesInvoiceEntries(invoice).map((e) => e.accountCode)).not.toContain('ROUND_OFF');
  });

  it('marks exactly one entry as the party control account', () => {
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(500n, 500)],
    });
    const withParty = salesInvoiceEntries(invoice).filter((e) => e.withParty);
    expect(withParty).toHaveLength(1);
    expect(withParty[0]!.accountCode).toBe('SUNDRY_DEBTORS');
  });

  it('posts an exempt supply with no tax accounts at all', () => {
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      supplyType: 'exempt',
      lines: [line(100_000n, 1800)],
    });
    const codes = salesInvoiceEntries(invoice).map((e) => e.accountCode);
    expect(codes).toEqual(['SUNDRY_DEBTORS', 'SALES']);
  });
});

describe('purchaseBillEntries', () => {
  it('debits input tax as an asset rather than crediting it', () => {
    const bill = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(50_000n, 1200)],
    });
    const entries = purchaseBillEntries(bill);

    expect(sum(entries, 'PURCHASES')).toBe(5_000_000n); // Dr ₹50,000
    expect(sum(entries, 'INPUT_CGST')).toBe(300_000n); // Dr ₹3,000
    expect(sum(entries, 'INPUT_SGST')).toBe(300_000n); // Dr ₹3,000
    expect(sum(entries, 'SUNDRY_CREDITORS')).toBe(-5_600_000n); // Cr ₹56,000
  });

  it('balances for every rate', () => {
    for (const rate of [0, 500, 1200, 1800, 2800]) {
      const bill = calc({
        supplierStateCode: '29',
        placeOfSupplyStateCode: '33',
        lines: [{ quantity: 3n * QTY_SCALE, unitPricePaise: 77_777n, gstRateBps: rate }],
      });
      const { debitPaise, creditPaise } = totals(purchaseBillEntries(bill));
      expect(debitPaise, `rate ${rate}`).toBe(creditPaise);
    }
  });

  it('charges no input tax on a reverse-charge line', () => {
    const bill = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [{ quantity: QTY_SCALE, unitPricePaise: 100_000n, gstRateBps: 1800, reverseCharge: true }],
    });
    const entries = purchaseBillEntries(bill);
    expect(sum(entries, 'INPUT_CGST')).toBe(0n);
    expect(sum(entries, 'SUNDRY_CREDITORS')).toBe(-100_000n);
  });
});

describe('receiptEntries', () => {
  it('debits the bank and clears the debtor', () => {
    const entries = receiptEntries({ amountPaise: 11_800_000n, intoAccountCode: 'CASH' });
    expect(sum(entries, 'CASH')).toBe(11_800_000n);
    expect(sum(entries, 'SUNDRY_DEBTORS')).toBe(-11_800_000n);
  });

  it('clears the full invoice when a discount is allowed on settlement', () => {
    const entries = receiptEntries({
      amountPaise: 9_900_000n,
      intoAccountCode: 'CASH',
      discountAllowedPaise: 100_000n,
    });
    // The customer paid ₹99,000 and was allowed ₹1,000, so ₹1,00,000 is cleared.
    expect(sum(entries, 'SUNDRY_DEBTORS')).toBe(-10_000_000n);
    expect(sum(entries, 'DISCOUNT_ALLOWED')).toBe(100_000n);
    const { debitPaise, creditPaise } = totals(entries);
    expect(debitPaise).toBe(creditPaise);
  });

  it('refuses a zero or negative receipt', () => {
    expect(() => receiptEntries({ amountPaise: 0n, intoAccountCode: 'CASH' })).toThrow(/positive/);
    expect(() => receiptEntries({ amountPaise: -1n, intoAccountCode: 'CASH' })).toThrow(/positive/);
  });
});

describe('paymentEntries', () => {
  it('clears the creditor and credits the bank', () => {
    const entries = paymentEntries({ amountPaise: 5_600_000n, fromAccountCode: 'CASH' });
    expect(sum(entries, 'SUNDRY_CREDITORS')).toBe(5_600_000n);
    expect(sum(entries, 'CASH')).toBe(-5_600_000n);
  });

  it('balances with a discount received', () => {
    const entries = paymentEntries({
      amountPaise: 4_900_000n,
      fromAccountCode: 'CASH',
      discountReceivedPaise: 100_000n,
    });
    expect(sum(entries, 'SUNDRY_CREDITORS')).toBe(5_000_000n);
    const { debitPaise, creditPaise } = totals(entries);
    expect(debitPaise).toBe(creditPaise);
  });
});

describe('reverseEntries', () => {
  it('swaps every side and still balances', () => {
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(100_000n, 1800)],
    });
    const original = salesInvoiceEntries(invoice);
    const reversed = reverseEntries(original);

    expect(sum(reversed, 'SUNDRY_DEBTORS')).toBe(-sum(original, 'SUNDRY_DEBTORS'));
    expect(sum(reversed, 'SALES')).toBe(-sum(original, 'SALES'));
    const { debitPaise, creditPaise } = totals(reversed);
    expect(debitPaise).toBe(creditPaise);
  });

  it('nets to nothing when applied to its own original', () => {
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '27',
      lines: [line(33_333n, 1800), line(777n, 500)],
    });
    const original = salesInvoiceEntries(invoice);
    const both = [...original, ...reverseEntries(original)];
    for (const code of new Set(both.map((e) => e.accountCode))) {
      expect(sum(both, code), `${code} must net to zero after reversal`).toBe(0n);
    }
  });

  it('reversing twice returns the original', () => {
    const invoice = calc({
      supplierStateCode: '29',
      placeOfSupplyStateCode: '29',
      lines: [line(1_234n, 1200)],
    });
    const original = salesInvoiceEntries(invoice);
    expect(reverseEntries(reverseEntries(original))).toEqual(original);
  });
});
