/**
 * The GST calculation engine.
 *
 * Deterministic and pure: same inputs, same numbers, every time. No AI touches
 * this, nothing here reads a clock or a database, and every value is an integer
 * so no step can drift by a rounding error.
 *
 * The one rule that governs everything: whether a supply attracts CGST+SGST or
 * IGST is decided by the place of supply against the supplier's own state, not
 * by where the customer is billed or where the goods physically go.
 */
import { BPS_SCALE, PAISE_PER_RUPEE, QTY_SCALE, divideHalfUp } from './units';

export type SupplyType =
  /** Supplier and place of supply in the same state: CGST + SGST, half each. */
  | 'intra_state'
  /** Different states, or a union-territory crossing: IGST at the full rate. */
  | 'inter_state'
  /** Zero-rated: export or SEZ. Tax computed at 0 but the supply is reported. */
  | 'zero_rated'
  /** Outside GST entirely (exempt, nil-rated, non-GST). */
  | 'exempt';

export interface GstLineInput {
  /** Quantity scaled by QTY_SCALE (4 decimal places). */
  quantity: bigint;
  /** Price per unit, in paise. */
  unitPricePaise: bigint;
  /** Line discount in paise, subtracted before tax. */
  discountPaise?: bigint;
  /** GST rate in basis points: 1800 is 18%. */
  gstRateBps: number;
  /** Compensation cess in basis points, where it applies. */
  cessRateBps?: number;
  /** Reverse charge: the recipient pays, so the supplier charges no tax. */
  reverseCharge?: boolean;
}

export interface GstLineResult {
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  totalTaxPaise: bigint;
  linePaise: bigint;
}

export interface GstInvoiceResult {
  lines: readonly GstLineResult[];
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  totalTaxPaise: bigint;
  /** Taxable + tax, before rounding. */
  subtotalPaise: bigint;
  /** Subtotal rounded to the nearest rupee — what the customer pays. */
  totalPaise: bigint;
  /** rounded − exact. Posts to the Round Off ledger. Can be either sign. */
  roundOffPaise: bigint;
  supplyType: SupplyType;
}

/**
 * Decides CGST+SGST versus IGST.
 *
 * Export and SEZ are zero-rated but are still *inter-state* supplies for
 * reporting; they are modelled as their own type so a later GSTR-1 can place
 * them in the right table rather than inferring it from a zero rate.
 */
export function determineSupplyType(input: {
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  isExport?: boolean;
  isSez?: boolean;
  isExempt?: boolean;
}): SupplyType {
  if (input.isExempt) return 'exempt';
  if (input.isExport || input.isSez) return 'zero_rated';
  return input.supplierStateCode === input.placeOfSupplyStateCode
    ? 'intra_state'
    : 'inter_state';
}

/** Taxable value of one line: quantity × unit price − discount. */
export function lineTaxableValue(line: GstLineInput): bigint {
  const gross = divideHalfUp(line.quantity * line.unitPricePaise, QTY_SCALE);
  const taxable = gross - (line.discountPaise ?? 0n);
  if (taxable < 0n) {
    throw new RangeError('Discount exceeds the line value');
  }
  return taxable;
}

export function calculateLine(line: GstLineInput, supplyType: SupplyType): GstLineResult {
  const taxablePaise = lineTaxableValue(line);

  const noTax: GstLineResult = {
    taxablePaise,
    cgstPaise: 0n,
    sgstPaise: 0n,
    igstPaise: 0n,
    cessPaise: 0n,
    totalTaxPaise: 0n,
    linePaise: taxablePaise,
  };

  // Under reverse charge the recipient accounts for the tax, so the supplier
  // charges none — but the taxable value is still reported.
  if (line.reverseCharge || supplyType === 'exempt' || supplyType === 'zero_rated') {
    return noTax;
  }

  const rateBps = BigInt(line.gstRateBps);
  const cessPaise = line.cessRateBps
    ? divideHalfUp(taxablePaise * BigInt(line.cessRateBps), BPS_SCALE)
    : 0n;

  let cgstPaise = 0n;
  let sgstPaise = 0n;
  let igstPaise = 0n;

  if (supplyType === 'intra_state') {
    // CGST and SGST must be equal, so the half-rate tax is computed once and
    // used twice. Computing each independently could differ by a paisa when the
    // rate is odd, which is not legal on an invoice.
    const half = divideHalfUp(taxablePaise * rateBps, BPS_SCALE * 2n);
    cgstPaise = half;
    sgstPaise = half;
  } else {
    igstPaise = divideHalfUp(taxablePaise * rateBps, BPS_SCALE);
  }

  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise + cessPaise;
  return {
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    cessPaise,
    totalTaxPaise,
    linePaise: taxablePaise + totalTaxPaise,
  };
}

/**
 * Totals an invoice and rounds it.
 *
 * Tax is computed per line and then summed, never computed on the summed
 * taxable value: lines can carry different rates, and summing first would be
 * wrong the moment an invoice mixes them.
 */
export function calculateInvoice(
  lines: readonly GstLineInput[],
  supplyType: SupplyType,
): GstInvoiceResult {
  const results = lines.map((line) => calculateLine(line, supplyType));

  const sum = (pick: (r: GstLineResult) => bigint) =>
    results.reduce<bigint>((acc, r) => acc + pick(r), 0n);

  const taxablePaise = sum((r) => r.taxablePaise);
  const cgstPaise = sum((r) => r.cgstPaise);
  const sgstPaise = sum((r) => r.sgstPaise);
  const igstPaise = sum((r) => r.igstPaise);
  const cessPaise = sum((r) => r.cessPaise);
  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise + cessPaise;
  const subtotalPaise = taxablePaise + totalTaxPaise;

  // Invoices are settled in whole rupees; the difference is a real posting, not
  // a display convenience, so it goes to its own ledger.
  const totalPaise = divideHalfUp(subtotalPaise, PAISE_PER_RUPEE) * PAISE_PER_RUPEE;

  return {
    lines: results,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    cessPaise,
    totalTaxPaise,
    subtotalPaise,
    totalPaise,
    roundOffPaise: totalPaise - subtotalPaise,
    supplyType,
  };
}
