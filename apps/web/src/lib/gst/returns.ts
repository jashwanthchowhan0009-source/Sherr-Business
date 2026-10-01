/**
 * GSTR-1 and GSTR-3B summaries.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  These are WORKINGS, not returns. They are a reading of the return formats
 *  intended to let a person or their CA see what the books say a return would
 *  contain. Nothing here files anything, and nothing here has been verified
 *  against the portal's own validation.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Both are built from posted vouchers only, and both are reconciled against the
 * ledger by the test suite rather than trusted: a return that disagrees with the
 * books it was drawn from is worse than no return at all, because it will be
 * filed and then have to be amended.
 *
 * Pure and integer-only.
 */
import { addTax, zeroTax, type TaxAmounts } from './set-off';

/** A posted outward or inward supply, as a return needs to see it. */
export interface ReturnSupply {
  voucherId: string;
  voucherNo: string;
  voucherType: 'sales' | 'purchase' | 'credit_note' | 'debit_note';
  voucherDate: string;
  partyName: string | null;
  /** Null means the counterparty is unregistered. */
  partyGstin: string | null;
  placeOfSupplyStateCode: string | null;
  supplyType: 'intra_state' | 'inter_state' | 'zero_rated' | 'exempt' | null;
  taxablePaise: bigint;
  tax: TaxAmounts;
  reverseCharge: boolean;
  /** HSN or SAC lines, for the HSN summary. */
  hsnLines: {
    hsnSac: string | null;
    description: string;
    /** Scaled by QTY_SCALE. */
    quantity: bigint;
    unit: string | null;
    taxablePaise: bigint;
    tax: TaxAmounts;
  }[];
}

// ── GSTR-1: outward supplies ────────────────────────────────────────────────

export type Gstr1Table =
  | 'b2b'
  | 'b2cl'
  | 'b2cs'
  | 'exports'
  | 'nil_exempt'
  | 'credit_notes_registered'
  | 'credit_notes_unregistered';

export const GSTR1_TABLE_LABELS: Record<Gstr1Table, string> = {
  b2b: 'B2B — supplies to registered persons',
  b2cl: 'B2CL — inter-state supplies to unregistered persons above the threshold',
  b2cs: 'B2CS — other supplies to unregistered persons',
  exports: 'Exports and supplies to SEZ',
  nil_exempt: 'Nil-rated, exempt and non-GST supplies',
  credit_notes_registered: 'Credit and debit notes — registered',
  credit_notes_unregistered: 'Credit and debit notes — unregistered',
};

/**
 * The B2CL threshold: an inter-state supply to an unregistered person above
 * this invoice value is reported invoice-by-invoice rather than in aggregate.
 *
 * ₹2,50,000 is the figure I have taken. It has changed before and may change
 * again, which is exactly why it lives in the versioned tax_rules table and is
 * passed in rather than hardcoded at the point of use.
 */
export const DEFAULT_B2CL_THRESHOLD_PAISE = 2_50_000_00n;

export interface Gstr1Section {
  table: Gstr1Table;
  label: string;
  invoiceCount: number;
  taxablePaise: bigint;
  tax: TaxAmounts;
  /** Named invoices, for the tables that report them individually. */
  invoices: {
    voucherNo: string;
    voucherDate: string;
    partyName: string | null;
    partyGstin: string | null;
    placeOfSupplyStateCode: string | null;
    taxablePaise: bigint;
    tax: TaxAmounts;
  }[];
}

export interface HsnSummaryRow {
  hsnSac: string;
  description: string;
  unit: string | null;
  quantity: bigint;
  taxablePaise: bigint;
  tax: TaxAmounts;
}

export interface Gstr1Summary {
  from: string;
  to: string;
  sections: Gstr1Section[];
  hsnSummary: HsnSummaryRow[];
  totalTaxablePaise: bigint;
  totalTax: TaxAmounts;
  /** Supplies with no HSN on any line, which the portal will reject. */
  invoicesMissingHsn: string[];
  /** Registered supplies whose counterparty GSTIN is absent. */
  invoicesMissingGstin: string[];
  needsCaVerification: true;
}

/**
 * Which GSTR-1 table a supply belongs in.
 *
 * The decision rests on three facts about the supply: whether the counterparty
 * is registered, whether it crosses a state line, and its value. Nothing is
 * inferred from the amount of tax charged, because a zero-rated supply and a
 * nil-rated one both carry none and belong in different places.
 */
export function gstr1TableFor(
  supply: ReturnSupply,
  b2clThresholdPaise: bigint,
): Gstr1Table {
  const isNote = supply.voucherType === 'credit_note' || supply.voucherType === 'debit_note';
  if (isNote) {
    return supply.partyGstin ? 'credit_notes_registered' : 'credit_notes_unregistered';
  }
  if (supply.supplyType === 'zero_rated') return 'exports';
  if (supply.supplyType === 'exempt') return 'nil_exempt';
  if (supply.partyGstin) return 'b2b';
  // Unregistered: inter-state above the threshold is reported individually.
  if (supply.supplyType === 'inter_state' && supply.taxablePaise > b2clThresholdPaise) {
    return 'b2cl';
  }
  return 'b2cs';
}

/** Tables that report invoice by invoice rather than in aggregate. */
const INVOICE_LEVEL: ReadonlySet<Gstr1Table> = new Set([
  'b2b',
  'b2cl',
  'exports',
  'credit_notes_registered',
]);

export function buildGstr1(input: {
  from: string;
  to: string;
  supplies: readonly ReturnSupply[];
  b2clThresholdPaise?: bigint;
}): Gstr1Summary {
  const threshold = input.b2clThresholdPaise ?? DEFAULT_B2CL_THRESHOLD_PAISE;
  const sections = new Map<Gstr1Table, Gstr1Section>();
  const hsn = new Map<string, HsnSummaryRow>();
  const invoicesMissingHsn: string[] = [];
  const invoicesMissingGstin: string[] = [];

  for (const supply of input.supplies) {
    const table = gstr1TableFor(supply, threshold);

    let section = sections.get(table);
    if (!section) {
      section = {
        table,
        label: GSTR1_TABLE_LABELS[table],
        invoiceCount: 0,
        taxablePaise: 0n,
        tax: zeroTax(),
        invoices: [],
      };
      sections.set(table, section);
    }

    section.invoiceCount += 1;
    section.taxablePaise += supply.taxablePaise;
    section.tax = addTax(section.tax, supply.tax);

    if (INVOICE_LEVEL.has(table)) {
      section.invoices.push({
        voucherNo: supply.voucherNo,
        voucherDate: supply.voucherDate,
        partyName: supply.partyName,
        partyGstin: supply.partyGstin,
        placeOfSupplyStateCode: supply.placeOfSupplyStateCode,
        taxablePaise: supply.taxablePaise,
        tax: supply.tax,
      });
    }

    // The portal rejects a B2B invoice without the counterparty's GSTIN, and a
    // return without HSN where HSN is required. Both are reported here rather
    // than discovered at filing.
    if (table === 'b2b' && !supply.partyGstin) invoicesMissingGstin.push(supply.voucherNo);
    if (supply.hsnLines.length > 0 && supply.hsnLines.every((l) => !l.hsnSac)) {
      invoicesMissingHsn.push(supply.voucherNo);
    }

    for (const line of supply.hsnLines) {
      if (!line.hsnSac) continue;
      const key = `${line.hsnSac}|${line.unit ?? ''}`;
      const existing = hsn.get(key);
      if (existing) {
        existing.quantity += line.quantity;
        existing.taxablePaise += line.taxablePaise;
        existing.tax = addTax(existing.tax, line.tax);
      } else {
        hsn.set(key, {
          hsnSac: line.hsnSac,
          description: line.description,
          unit: line.unit,
          quantity: line.quantity,
          taxablePaise: line.taxablePaise,
          tax: line.tax,
        });
      }
    }
  }

  const ORDER: Gstr1Table[] = [
    'b2b',
    'b2cl',
    'b2cs',
    'exports',
    'nil_exempt',
    'credit_notes_registered',
    'credit_notes_unregistered',
  ];
  const ordered = ORDER.filter((t) => sections.has(t)).map((t) => sections.get(t)!);

  return {
    from: input.from,
    to: input.to,
    sections: ordered,
    hsnSummary: [...hsn.values()].sort((a, b) => a.hsnSac.localeCompare(b.hsnSac)),
    totalTaxablePaise: ordered.reduce((acc, s) => acc + s.taxablePaise, 0n),
    totalTax: ordered.reduce((acc, s) => addTax(acc, s.tax), zeroTax()),
    invoicesMissingHsn,
    invoicesMissingGstin,
    needsCaVerification: true,
  };
}

// ── GSTR-3B: the summary return ─────────────────────────────────────────────

export interface Gstr3bSummary {
  from: string;
  to: string;
  /** 3.1(a): outward taxable supplies, other than zero-rated, nil and exempt. */
  outwardTaxable: { taxablePaise: bigint; tax: TaxAmounts };
  /** 3.1(b): zero-rated. */
  outwardZeroRated: { taxablePaise: bigint; tax: TaxAmounts };
  /** 3.1(c): nil-rated and exempt. */
  outwardNilExempt: { taxablePaise: bigint };
  /** 3.1(d): inward supplies on which tax is payable by us under reverse charge. */
  inwardReverseCharge: { taxablePaise: bigint; tax: TaxAmounts };
  /** 4(A): input tax credit available. */
  itcAvailable: TaxAmounts;
  /** 4(B): credit reversed. Nothing computes a reversal, so this is always nil. */
  itcReversed: TaxAmounts;
  /** 4(C): net credit available. */
  itcNet: TaxAmounts;
  /** Total output liability, including reverse charge payable by us. */
  totalLiability: TaxAmounts;
  needsCaVerification: true;
}

/**
 * The GSTR-3B working.
 *
 * `itcReversed` is always nil: credit reversal under Rules 42 and 43, for
 * non-business or exempt use, is a judgement about how inputs were used and
 * this product has no basis for making it. Reporting a computed reversal of nil
 * is honest; implying none is needed would not be, so the field is shown with
 * that note rather than hidden.
 */
export function buildGstr3b(input: {
  from: string;
  to: string;
  outward: readonly ReturnSupply[];
  inward: readonly ReturnSupply[];
}): Gstr3bSummary {
  const outwardTaxable = { taxablePaise: 0n, tax: zeroTax() };
  const outwardZeroRated = { taxablePaise: 0n, tax: zeroTax() };
  const outwardNilExempt = { taxablePaise: 0n };
  const inwardReverseCharge = { taxablePaise: 0n, tax: zeroTax() };
  let itcAvailable = zeroTax();

  for (const supply of input.outward) {
    // A credit note reduces the period's outward supplies, and arrives here with
    // negative amounts so that it does so by addition.
    if (supply.supplyType === 'zero_rated') {
      outwardZeroRated.taxablePaise += supply.taxablePaise;
      outwardZeroRated.tax = addTax(outwardZeroRated.tax, supply.tax);
    } else if (supply.supplyType === 'exempt') {
      outwardNilExempt.taxablePaise += supply.taxablePaise;
    } else {
      outwardTaxable.taxablePaise += supply.taxablePaise;
      outwardTaxable.tax = addTax(outwardTaxable.tax, supply.tax);
    }
  }

  for (const supply of input.inward) {
    if (supply.reverseCharge) {
      // Tax on a reverse-charge purchase is both a liability and a credit, so it
      // appears in 3.1(d) and in 4(A). It nets to nothing in cash, which is
      // correct and is why the two must both be shown.
      inwardReverseCharge.taxablePaise += supply.taxablePaise;
      inwardReverseCharge.tax = addTax(inwardReverseCharge.tax, supply.tax);
    }
    itcAvailable = addTax(itcAvailable, supply.tax);
  }

  const itcReversed = zeroTax();
  const itcNet: TaxAmounts = {
    igst: itcAvailable.igst - itcReversed.igst,
    cgst: itcAvailable.cgst - itcReversed.cgst,
    sgst: itcAvailable.sgst - itcReversed.sgst,
    cess: itcAvailable.cess - itcReversed.cess,
  };

  return {
    from: input.from,
    to: input.to,
    outwardTaxable,
    outwardZeroRated,
    outwardNilExempt,
    inwardReverseCharge,
    itcAvailable,
    itcReversed,
    itcNet,
    totalLiability: addTax(outwardTaxable.tax, inwardReverseCharge.tax),
    needsCaVerification: true,
  };
}
