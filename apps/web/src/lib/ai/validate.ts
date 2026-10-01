/**
 * Checking what the model said against what must be true.
 *
 * The model has read a document and reported text. This module converts that text
 * into accounting values with our own parser, recomputes the tax with our own GST
 * engine, and compares the result to the totals printed on the document. Three
 * things can then be said, and they are genuinely different:
 *
 * - **Our arithmetic and the document agree.** The reviewer still approves it, but
 *   there is nothing to resolve.
 * - **They disagree.** Either the model misread a figure or the document itself is
 *   wrong. Both happen, and only a person can tell which, so the difference is
 *   reported in rupees and the reviewer decides.
 * - **We cannot tell**, because a field is missing. Reported as missing, never
 *   assumed to be zero — a missing IGST and an IGST of nil are different claims.
 *
 * Nothing here is advice and nothing here blocks: a finding is something a reviewer
 * must look at, and the one thing the product refuses outright is posting without a
 * person having looked.
 */
import {
  QTY_SCALE,
  divideHalfUp,
  parseQuantity,
  parseRupees,
  percentToBps,
} from '@/lib/accounting/units';
import {
  calculateInvoice,
  determineSupplyType,
  type GstLineInput,
  type SupplyType,
} from '@/lib/accounting/gst';
import { validateGstin, panFromGstin, stateFromGstin } from '@/lib/india/gstin';
import { parseDateParts } from '@/lib/accounting/fiscal-year';
import { CONFIDENCE_FLOOR, type ExtractedDocument, type ExtractedField } from './contract';

export type FindingSeverity =
  /** Must be resolved before this becomes a voucher. */
  | 'blocker'
  /** A person should look, but it can be approved as it stands. */
  | 'check'
  /** Worth knowing. */
  | 'note';

export interface Finding {
  severity: FindingSeverity;
  /** Which field it is about, for highlighting. Null when it spans several. */
  field: string | null;
  message: string;
}

/** A field converted to an accounting value, with how it went. */
export interface ParsedAmount {
  paise: bigint | null;
  /** The text we were given, kept so a reviewer can see what was read. */
  text: string | null;
  problem: string | null;
}

export interface ValidationResult {
  findings: Finding[];
  /** Our own computation from the lines, independent of the stated totals. */
  computed: {
    taxablePaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    cessPaise: bigint;
    roundOffPaise: bigint;
    totalPaise: bigint;
    supplyType: SupplyType | null;
  } | null;
  /** The totals as printed, parsed. */
  stated: {
    taxablePaise: bigint | null;
    cgstPaise: bigint | null;
    sgstPaise: bigint | null;
    igstPaise: bigint | null;
    cessPaise: bigint | null;
    grandTotalPaise: bigint | null;
  };
  /** True when nothing is a blocker. Still requires a person to approve. */
  readyForReview: boolean;
}

/** Text to paise, reporting rather than throwing. */
export function parseAmount(field: ExtractedField): ParsedAmount {
  if (field.value === null) return { paise: null, text: null, problem: null };
  try {
    return { paise: parseRupees(field.value), text: field.value, problem: null };
  } catch (err) {
    return {
      paise: null,
      text: field.value,
      problem: err instanceof Error ? err.message : 'could not be read as an amount',
    };
  }
}

/**
 * A date as printed, to ISO.
 *
 * Indian documents are day-first, and a two-digit year is this century. `03/04/2025`
 * is 3 April, not 4 March — the one ambiguity that would silently move an invoice
 * into the wrong return period, so an unparseable date is a blocker rather than a
 * guess.
 */
export function parseDocumentDate(text: string | null): { iso: string | null; problem: string | null } {
  if (text === null) return { iso: null, problem: null };

  const cleaned = text.trim();

  // Already ISO.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (iso) return finishDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Day-first with any common separator.
  const dmy = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(cleaned);
  if (dmy) {
    const year = Number(dmy[3]);
    return finishDate(year < 100 ? 2000 + year : year, Number(dmy[2]), Number(dmy[1]));
  }

  // "15 July 2025", "15-Jul-2025", "July 15, 2025".
  const named = /^(\d{1,2})[\s\-.]*([A-Za-z]{3,})[\s\-.,]*(\d{2}|\d{4})$/.exec(cleaned);
  const namedFirst = /^([A-Za-z]{3,})[\s\-.]*(\d{1,2})[\s\-.,]*(\d{2}|\d{4})$/.exec(cleaned);
  const parts = named
    ? { day: named[1]!, month: named[2]!, year: named[3]! }
    : namedFirst
      ? { day: namedFirst[2]!, month: namedFirst[1]!, year: namedFirst[3]! }
      : null;

  if (parts) {
    const month = MONTHS.indexOf(parts.month.slice(0, 3).toLowerCase()) + 1;
    if (month > 0) {
      const year = Number(parts.year);
      return finishDate(year < 100 ? 2000 + year : year, month, Number(parts.day));
    }
  }

  return { iso: null, problem: `"${text}" is not a date this product can read` };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function finishDate(year: number, month: number, day: number) {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  try {
    // Rejects 31 February and the like, by the same civil-date code the ledger uses.
    const parts = parseDateParts(iso);
    if (parts.year !== year || parts.month !== month || parts.day !== day) {
      return { iso: null, problem: `"${iso}" is not a real date` };
    }
    return { iso, problem: null };
  } catch {
    return { iso: null, problem: `"${iso}" is not a real date` };
  }
}

/**
 * Everything checkable about one extraction.
 *
 * `today` is passed in rather than read, so the result is a function of its inputs
 * and a future-dated-invoice test does not depend on the day it runs.
 */
export function validateExtraction(
  doc: ExtractedDocument,
  context: {
    today: string;
    /** The company's own GSTIN, for deciding which side of the document we are. */
    ownGstin?: string | null;
    ownStateCode?: string | null;
    /** Earliest date the books accept. */
    booksStartDate?: string | null;
    /** Latest date already locked. */
    lockedUpto?: string | null;
  },
): ValidationResult {
  const findings: Finding[] = [];
  const add = (severity: FindingSeverity, field: string | null, message: string) =>
    findings.push({ severity, field, message });

  // ── what kind of document, and whose ──────────────────────────────────────
  if (doc.kind === 'other') {
    add('blocker', 'kind', 'The model could not tell what kind of document this is. Choose one.');
  }

  const supplierGstin = checkGstin(doc.supplierGstin, 'supplierGstin', 'supplier', add);
  const buyerGstin = checkGstin(doc.buyerGstin, 'buyerGstin', 'buyer', add);

  // A document on which we are neither party is almost certainly misfiled, and
  // entering it would put someone else's transaction in these books.
  if (context.ownGstin) {
    const own = context.ownGstin.toUpperCase();
    const weAreBuyer = buyerGstin === own;
    const weAreSupplier = supplierGstin === own;

    if (supplierGstin && buyerGstin && !weAreBuyer && !weAreSupplier) {
      add(
        'blocker',
        null,
        `Neither party on this document is ${own}. It is between ${supplierGstin} and ` +
          `${buyerGstin}, so it does not belong in these books.`,
      );
    } else if (doc.kind === 'purchase_invoice' && weAreSupplier) {
      add(
        'blocker',
        'kind',
        'This was read as a purchase, but the supplier GSTIN is your own. It is a sales invoice.',
      );
    } else if (doc.kind === 'sales_invoice' && weAreBuyer) {
      add(
        'blocker',
        'kind',
        'This was read as a sale, but the buyer GSTIN is your own. It is a purchase invoice.',
      );
    }
  }

  // The PAN inside a GSTIN is part of its structure, so a mismatch between two
  // GSTINs claiming to be the same business is detectable without any lookup.
  if (supplierGstin && buyerGstin && supplierGstin === buyerGstin) {
    add('blocker', null, 'The supplier and the buyer have the same GSTIN.');
  }

  // ── the date ──────────────────────────────────────────────────────────────
  const date = parseDocumentDate(doc.invoiceDate.value);
  if (doc.invoiceDate.value === null) {
    add('blocker', 'invoiceDate', 'No invoice date was found. A voucher cannot be dated.');
  } else if (date.problem) {
    add('blocker', 'invoiceDate', date.problem);
  } else if (date.iso) {
    if (date.iso > context.today) {
      add('check', 'invoiceDate', `The document is dated ${date.iso}, which is in the future.`);
    }
    if (context.booksStartDate && date.iso < context.booksStartDate) {
      add(
        'blocker',
        'invoiceDate',
        `The document is dated ${date.iso}, before the books start on ${context.booksStartDate}.`,
      );
    }
    if (context.lockedUpto && date.iso <= context.lockedUpto) {
      add(
        'blocker',
        'invoiceDate',
        `The books are closed to ${context.lockedUpto}, so nothing can be entered on ${date.iso}.`,
      );
    }
  }

  if (doc.invoiceNumber.value === null) {
    add(
      'check',
      'invoiceNumber',
      'No invoice number was found. Without one, a duplicate bill cannot be detected.',
    );
  }

  // ── our own arithmetic, from the lines ────────────────────────────────────
  const computed = computeFromLines(doc, { supplierGstin, context, add });

  // ── the stated totals, parsed ─────────────────────────────────────────────
  const stated = {
    taxablePaise: amountOrFinding(doc.statedTaxableTotal, 'statedTaxableTotal', add),
    cgstPaise: amountOrFinding(doc.statedCgst, 'statedCgst', add),
    sgstPaise: amountOrFinding(doc.statedSgst, 'statedSgst', add),
    igstPaise: amountOrFinding(doc.statedIgst, 'statedIgst', add),
    cessPaise: amountOrFinding(doc.statedCess, 'statedCess', add),
    grandTotalPaise: amountOrFinding(doc.statedGrandTotal, 'statedGrandTotal', add),
  };

  // ── the comparison, which is the whole point ──────────────────────────────
  if (computed) {
    compare('statedTaxableTotal', 'taxable value', stated.taxablePaise, computed.taxablePaise, add);
    compare('statedCgst', 'CGST', stated.cgstPaise, computed.cgstPaise, add);
    compare('statedSgst', 'SGST', stated.sgstPaise, computed.sgstPaise, add);
    compare('statedIgst', 'IGST', stated.igstPaise, computed.igstPaise, add);
    compare('statedCess', 'cess', stated.cessPaise, computed.cessPaise, add);
    compare('statedGrandTotal', 'total', stated.grandTotalPaise, computed.totalPaise, add);

    // CGST and SGST are two halves of one rate and must be equal on the document.
    if (
      stated.cgstPaise !== null &&
      stated.sgstPaise !== null &&
      stated.cgstPaise !== stated.sgstPaise
    ) {
      add(
        'check',
        'statedSgst',
        `The document shows CGST of ${rupees(stated.cgstPaise)} and SGST of ` +
          `${rupees(stated.sgstPaise)}. They are halves of one rate and should be equal.`,
      );
    }

    // IGST and the state pair are alternatives, never both.
    const hasIgst = (stated.igstPaise ?? 0n) > 0n;
    const hasPair = (stated.cgstPaise ?? 0n) > 0n || (stated.sgstPaise ?? 0n) > 0n;
    if (hasIgst && hasPair) {
      add(
        'blocker',
        'statedIgst',
        'The document shows both IGST and CGST/SGST. A supply is either inter-state or ' +
          'intra-state, not both.',
      );
    }
  } else {
    add(
      'blocker',
      'lines',
      'No line could be read well enough to compute the tax, so nothing can be checked ' +
        'against the printed totals.',
    );
  }

  // ── low confidence, reported as such ──────────────────────────────────────
  for (const [name, field] of Object.entries(IMPORTANT_FIELDS(doc))) {
    if (field.value !== null && field.confidence < CONFIDENCE_FLOOR) {
      add(
        'check',
        name,
        `The model was ${Math.round(field.confidence * 100)}% confident of this. Check it ` +
          'against the document.',
      );
    }
  }

  for (const note of doc.unreadable) {
    add('check', null, `The model could not read: ${note}`);
  }

  return {
    findings,
    computed,
    stated,
    readyForReview: !findings.some((f) => f.severity === 'blocker'),
  };
}

/** The fields whose confidence is worth surfacing on its own. */
function IMPORTANT_FIELDS(doc: ExtractedDocument): Record<string, ExtractedField> {
  return {
    supplierName: doc.supplierName,
    supplierGstin: doc.supplierGstin,
    invoiceNumber: doc.invoiceNumber,
    invoiceDate: doc.invoiceDate,
    statedGrandTotal: doc.statedGrandTotal,
  };
}

/**
 * Our own figures, from the lines, by the same engine an invoice typed by hand uses.
 *
 * This is the part that makes the model unable to invent a number: the tax is
 * computed from the rate and the taxable value, so a model that reported an
 * impossible tax amount changes nothing except a finding.
 */
function computeFromLines(
  doc: ExtractedDocument,
  deps: {
    supplierGstin: string | null;
    context: { ownStateCode?: string | null };
    add: (s: FindingSeverity, f: string | null, m: string) => void;
  },
): ValidationResult['computed'] {
  const { add } = deps;

  const supplierState =
    doc.supplierStateCode.value ??
    (deps.supplierGstin ? stateFromGstin(deps.supplierGstin)?.code ?? null : null);
  const placeOfSupply = doc.placeOfSupplyStateCode.value ?? null;

  let supplyType: SupplyType | null = null;
  if (supplierState && placeOfSupply) {
    supplyType = determineSupplyType({
      supplierStateCode: supplierState,
      placeOfSupplyStateCode: placeOfSupply,
    });
  } else {
    add(
      'check',
      'placeOfSupplyStateCode',
      'Without both the supplier state and the place of supply, whether this is IGST or ' +
        'CGST/SGST cannot be determined from the document. Confirm it.',
    );
  }

  const reverseCharge = doc.reverseCharge.value === true;
  const lines: GstLineInput[] = [];
  doc.lines.forEach((line, i) => {
    const amount = parseAmount(line.taxableAmount);
    if (amount.paise === null) {
      if (amount.text !== null) {
        add('blocker', `lines.${i}.taxableAmount`, `Line ${i + 1}: ${amount.problem}`);
      }
      return;
    }

    if (line.gstRatePercent.value === null) {
      add('blocker', `lines.${i}.gstRatePercent`, `Line ${i + 1} has no GST rate.`);
      return;
    }

    let rateBps: number;
    try {
      rateBps = percentToBps(line.gstRatePercent.value);
    } catch {
      add(
        'blocker',
        `lines.${i}.gstRatePercent`,
        `Line ${i + 1}: "${line.gstRatePercent.value}" is not a GST rate.`,
      );
      return;
    }

    // The slabs India actually uses. A rate outside them is not refused — a cess
    // line or a rate this product has not been told about would be — but it is
    // named, because a misread 18 as 1.8 looks exactly like this.
    if (![0, 10, 25, 50, 100, 300, 500, 600, 1200, 1400, 1800, 2800].includes(rateBps)) {
      add(
        'check',
        `lines.${i}.gstRatePercent`,
        `Line ${i + 1} is at ${rateBps / 100}%, which is not one of the usual GST rates.`,
      );
    }

    // The printed line amount is the taxable base, expressed to the engine as one
    // unit at that price. That is exact — quantity QTY_SCALE makes the engine's
    // quantity × price reduce to price — and it means the tax is computed by the
    // same code a hand-typed invoice uses rather than by anything here.
    lines.push({
      quantity: QTY_SCALE,
      unitPricePaise: amount.paise,
      gstRateBps: rateBps,
      reverseCharge,
    });

    // Quantity × rate is an independent route to the same line total, so where the
    // document prints both it is worth checking: a misread quantity shows up here
    // and nowhere else.
    const quantity = line.quantity.value;
    const unitRate = parseAmount(line.rate);
    if (quantity !== null && unitRate.paise !== null) {
      try {
        const expected = divideHalfUp(parseQuantity(quantity) * unitRate.paise, QTY_SCALE);
        if (expected !== amount.paise) {
          add(
            'check',
            `lines.${i}.taxableAmount`,
            `Line ${i + 1}: ${quantity} × ${rupees(unitRate.paise)} comes to ` +
              `${rupees(expected)}, but the line amount reads ${rupees(amount.paise)}.`,
          );
        }
      } catch {
        add('check', `lines.${i}.quantity`, `Line ${i + 1}: "${quantity}" is not a quantity.`);
      }
    }
  });

  if (reverseCharge) {
    add(
      'note',
      'reverseCharge',
      'The document says tax is payable by the recipient, so the supplier charges none. ' +
        'The liability and the matching credit are both yours.',
    );
  }

  if (lines.length === 0 || supplyType === null) return null;

  const invoice = calculateInvoice(lines, supplyType);

  return {
    taxablePaise: invoice.taxablePaise,
    cgstPaise: invoice.cgstPaise,
    sgstPaise: invoice.sgstPaise,
    igstPaise: invoice.igstPaise,
    cessPaise: invoice.cessPaise,
    roundOffPaise: invoice.roundOffPaise,
    totalPaise: invoice.totalPaise,
    supplyType,
  };
}

function checkGstin(
  field: ExtractedField,
  name: string,
  who: string,
  add: (s: FindingSeverity, f: string | null, m: string) => void,
): string | null {
  if (field.value === null) {
    add('check', name, `No ${who} GSTIN was found.`);
    return null;
  }

  const normalised = field.value.replace(/\s+/g, '').toUpperCase();
  const result = validateGstin(normalised);
  if (!result.ok) {
    // A GSTIN carries its own check digit, so this is arithmetic and not a guess:
    // the number as read is wrong, whoever got it wrong.
    add(
      'blocker',
      name,
      `The ${who} GSTIN "${field.value}" is not valid (${result.problem}). Either it was ` +
        'misread or the document is wrong.',
    );
    return null;
  }

  if (panFromGstin(normalised) === null) {
    add('check', name, `The ${who} GSTIN does not contain a readable PAN.`);
  }

  return normalised;
}

function amountOrFinding(
  field: ExtractedField,
  name: string,
  add: (s: FindingSeverity, f: string | null, m: string) => void,
): bigint | null {
  const parsed = parseAmount(field);
  if (parsed.problem) add('check', name, `"${parsed.text}" ${parsed.problem}`);
  return parsed.paise;
}

/**
 * Our figure against the document's.
 *
 * A missing stated figure is reported as missing, not treated as zero: a document
 * with no IGST line and a document with IGST of nil are different claims, and
 * silently reading the first as the second would hide a whole missing tax.
 */
function compare(
  field: string,
  label: string,
  stated: bigint | null,
  computed: bigint,
  add: (s: FindingSeverity, f: string | null, m: string) => void,
): void {
  if (stated === null) {
    if (computed !== 0n) {
      add(
        'check',
        field,
        `The document shows no ${label}, but ${rupees(computed)} was computed from the lines.`,
      );
    }
    return;
  }

  if (stated === computed) return;

  const difference = stated - computed;
  add(
    // A rupee either way is a rounding convention; more than that is a real
    // disagreement about the money.
    difference > 100n || difference < -100n ? 'blocker' : 'check',
    field,
    `The document shows ${label} of ${rupees(stated)}; computed from the lines it is ` +
      `${rupees(computed)}, a difference of ${rupees(difference)}.`,
  );
}

/** For a message, not for a ledger. */
function rupees(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? '-' : ''}₹${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
