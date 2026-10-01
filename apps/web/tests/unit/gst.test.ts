import { describe, expect, it } from 'vitest';
import {
  calculateInvoice,
  calculateLine,
  determineSupplyType,
  lineTaxableValue,
  type GstLineInput,
} from '../../src/lib/accounting/gst';
import { divideHalfUp, parseQuantity, percentToBps, QTY_SCALE } from '../../src/lib/accounting/units';
import { formatRupees, paise, rupeesToPaise } from '../../src/lib/money';

/** One unit priced at the given rupee amount, taxed at the given percent. */
const line = (rupees: string, percent: string, extra: Partial<GstLineInput> = {}): GstLineInput => ({
  quantity: QTY_SCALE,
  unitPricePaise: rupeesToPaise(rupees),
  gstRateBps: percentToBps(percent),
  ...extra,
});

describe('supply type', () => {
  it('is intra-state when the place of supply matches the supplier state', () => {
    expect(
      determineSupplyType({ supplierStateCode: '29', placeOfSupplyStateCode: '29' }),
    ).toBe('intra_state');
  });

  it('is inter-state when they differ', () => {
    expect(
      determineSupplyType({ supplierStateCode: '29', placeOfSupplyStateCode: '33' }),
    ).toBe('inter_state');
  });

  it('treats export and SEZ as zero-rated, not merely inter-state', () => {
    // They are reported separately in GSTR-1, so the distinction has to survive
    // into the stored voucher rather than being inferred from a zero rate.
    expect(
      determineSupplyType({ supplierStateCode: '29', placeOfSupplyStateCode: '96', isExport: true }),
    ).toBe('zero_rated');
    expect(
      determineSupplyType({ supplierStateCode: '29', placeOfSupplyStateCode: '29', isSez: true }),
    ).toBe('zero_rated');
  });

  it('puts exempt ahead of everything else', () => {
    expect(
      determineSupplyType({ supplierStateCode: '29', placeOfSupplyStateCode: '33', isExempt: true }),
    ).toBe('exempt');
  });
});

describe('acceptance: the cases in the specification', () => {
  it('intra-state ₹1,00,000 at 18% gives CGST ₹9,000 and SGST ₹9,000', () => {
    const result = calculateInvoice([line('100000', '18')], 'intra_state');
    expect(formatRupees(paise(result.taxablePaise))).toBe('₹1,00,000.00');
    expect(formatRupees(paise(result.cgstPaise))).toBe('₹9,000.00');
    expect(formatRupees(paise(result.sgstPaise))).toBe('₹9,000.00');
    expect(result.igstPaise).toBe(0n);
    expect(formatRupees(paise(result.totalPaise))).toBe('₹1,18,000.00');
  });

  it('the same sale inter-state gives IGST ₹18,000 and no CGST or SGST', () => {
    const result = calculateInvoice([line('100000', '18')], 'inter_state');
    expect(formatRupees(paise(result.igstPaise))).toBe('₹18,000.00');
    expect(result.cgstPaise).toBe(0n);
    expect(result.sgstPaise).toBe(0n);
    expect(formatRupees(paise(result.totalPaise))).toBe('₹1,18,000.00');
  });

  it('charges the same total either way at the same rate', () => {
    const intra = calculateInvoice([line('100000', '18')], 'intra_state');
    const inter = calculateInvoice([line('100000', '18')], 'inter_state');
    expect(intra.totalPaise).toBe(inter.totalPaise);
    expect(intra.totalTaxPaise).toBe(inter.totalTaxPaise);
  });
});

describe('the CGST/SGST split', () => {
  it('always splits exactly in half, even at an odd rate', () => {
    // CGST and SGST must be equal on the face of the invoice. Computing each
    // independently can differ by a paisa when the halved rate does not divide
    // cleanly, which is why the half is computed once and used twice.
    for (const percent of ['0.25', '3', '5', '12', '18', '28', '0.1']) {
      const result = calculateInvoice([line('7777.77', percent)], 'intra_state');
      expect(result.cgstPaise, percent).toBe(result.sgstPaise);
    }
  });

  it('keeps CGST + SGST within a paisa of the IGST at the same rate', () => {
    for (const percent of ['5', '12', '18', '28']) {
      const intra = calculateInvoice([line('12345.67', percent)], 'intra_state');
      const inter = calculateInvoice([line('12345.67', percent)], 'inter_state');
      const difference = intra.cgstPaise + intra.sgstPaise - inter.igstPaise;
      expect(difference >= -1n && difference <= 1n, percent).toBe(true);
    }
  });
});

describe('line values', () => {
  it('multiplies a fractional quantity without a float', () => {
    const taxable = lineTaxableValue({
      quantity: parseQuantity('2.5'),
      unitPricePaise: rupeesToPaise('100'),
      gstRateBps: 1800,
    });
    expect(formatRupees(paise(taxable))).toBe('₹250.00');
  });

  it('subtracts the discount before tax', () => {
    const result = calculateLine(
      { ...line('1000', '18'), discountPaise: rupeesToPaise('100') },
      'intra_state',
    );
    expect(formatRupees(paise(result.taxablePaise))).toBe('₹900.00');
    expect(formatRupees(paise(result.cgstPaise))).toBe('₹81.00');
  });

  it('refuses a discount larger than the line', () => {
    expect(() =>
      calculateLine({ ...line('100', '18'), discountPaise: rupeesToPaise('200') }, 'intra_state'),
    ).toThrow(/Discount exceeds/);
  });

  it('charges no tax under reverse charge but still reports the value', () => {
    const result = calculateLine({ ...line('1000', '18'), reverseCharge: true }, 'intra_state');
    expect(result.totalTaxPaise).toBe(0n);
    expect(formatRupees(paise(result.taxablePaise))).toBe('₹1,000.00');
  });

  it('charges no tax on zero-rated or exempt supplies', () => {
    for (const supply of ['zero_rated', 'exempt'] as const) {
      const result = calculateLine(line('1000', '18'), supply);
      expect(result.totalTaxPaise, supply).toBe(0n);
      expect(result.taxablePaise, supply).toBe(rupeesToPaise('1000'));
    }
  });

  it('adds compensation cess on top of GST', () => {
    const result = calculateLine({ ...line('1000', '28'), cessRateBps: 1200 }, 'inter_state');
    expect(formatRupees(paise(result.igstPaise))).toBe('₹280.00');
    expect(formatRupees(paise(result.cessPaise))).toBe('₹120.00');
    expect(formatRupees(paise(result.linePaise))).toBe('₹1,400.00');
  });
});

describe('invoice totals', () => {
  it('taxes each line at its own rate rather than the summed value', () => {
    const result = calculateInvoice(
      [line('1000', '5'), line('1000', '18'), line('1000', '28')],
      'inter_state',
    );
    expect(formatRupees(paise(result.taxablePaise))).toBe('₹3,000.00');
    expect(formatRupees(paise(result.igstPaise))).toBe('₹510.00'); // 50 + 180 + 280
  });

  it('rounds the total to the nearest rupee and posts the difference', () => {
    // 999.99 at 18% = 1179.9882, which must present as ₹1,180 with 1.18 paise
    // of round-off, not as a fractional rupee.
    const result = calculateInvoice([line('999.99', '18')], 'inter_state');
    expect(result.subtotalPaise).toBe(117998n + 1n);
    expect(result.totalPaise % 100n).toBe(0n);
    expect(result.roundOffPaise).toBe(result.totalPaise - result.subtotalPaise);
    expect(formatRupees(paise(result.totalPaise))).toBe('₹1,180.00');
  });

  it('keeps the round-off within half a rupee in both directions', () => {
    let sawPositive = false;
    let sawNegative = false;
    for (let p = 1; p <= 400; p += 7) {
      const result = calculateInvoice([line(`${p}.${String(p % 100).padStart(2, '0')}`, '18')], 'inter_state');
      expect(result.roundOffPaise <= 50n && result.roundOffPaise >= -50n).toBe(true);
      if (result.roundOffPaise > 0n) sawPositive = true;
      if (result.roundOffPaise < 0n) sawNegative = true;
      // The identity that makes the voucher balance.
      expect(result.totalPaise).toBe(result.subtotalPaise + result.roundOffPaise);
    }
    expect(sawPositive && sawNegative, 'round-off must swing both ways').toBe(true);
  });

  it('totals an empty invoice to zero rather than throwing', () => {
    const result = calculateInvoice([], 'intra_state');
    expect(result.totalPaise).toBe(0n);
    expect(result.roundOffPaise).toBe(0n);
  });
});

describe('half-up rounding', () => {
  it('rounds away from zero on a tie, in both directions', () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideHalfUp(4n, 2n)).toBe(2n);
    expect(divideHalfUp(1n, 3n)).toBe(0n);
    expect(divideHalfUp(2n, 3n)).toBe(1n);
  });

  it('refuses division by zero', () => {
    expect(() => divideHalfUp(1n, 0n)).toThrow(/divide by zero/);
  });
});

describe('scaled input parsing', () => {
  it('parses quantities to four decimal places', () => {
    expect(parseQuantity('1')).toBe(10_000n);
    expect(parseQuantity('2.5')).toBe(25_000n);
    expect(parseQuantity('0.0001')).toBe(1n);
    expect(() => parseQuantity('1.00001')).toThrow(/quantity/);
  });

  it('parses percentages to basis points', () => {
    expect(percentToBps('18')).toBe(1800);
    expect(percentToBps('0.25')).toBe(25);
    expect(percentToBps('28')).toBe(2800);
    expect(() => percentToBps('18.005')).toThrow(/percentage/);
  });
});
