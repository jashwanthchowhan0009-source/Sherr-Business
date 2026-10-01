/**
 * What a model is allowed to return, and what that return means.
 *
 * One rule governs this whole directory: **the model never produces a number that
 * reaches the ledger.** It reads a document and reports what it believes it saw,
 * as text, with a confidence. Everything after that is ours — our parser turns the
 * text into integer paise, our GST engine recomputes the tax from the rate and the
 * taxable value, and a person approves the result. If the model's claimed total
 * disagrees with our own arithmetic, that is a finding for the reviewer, never a
 * figure to prefer.
 *
 * This is why every amount here is a `string`. A number parsed by the model's own
 * tokeniser is a number nobody can audit; `"1,18,000.00"` is a claim about a
 * document, and `11800000n` is an accounting fact. Keeping the two apart in the
 * type system is what stops them being confused in the code.
 *
 * Confidence is per field rather than per document, because a model is often
 * certain about an invoice number and guessing at a GSTIN, and one number for the
 * whole page would hide exactly the field a reviewer should look at.
 */

/** What the model believes a single field says. */
export interface ExtractedField<T = string> {
  /** As it appears on the document, not normalised. Null when not found. */
  value: T | null;
  /**
   * 0 to 1. A model's own estimate, so it is evidence about where to look and
   * never a reason to skip looking: {@link CONFIDENCE_FLOOR} decides what is
   * shown as uncertain, and nothing decides what may be posted unread.
   */
  confidence: number;
  /** Where on the document it was read from, when the model says. */
  note?: string | null;
}

export interface ExtractedLine {
  description: ExtractedField;
  hsnSac: ExtractedField;
  quantity: ExtractedField;
  unit: ExtractedField;
  /** Rate per unit, as text. */
  rate: ExtractedField;
  /** Line value before tax, as text. */
  taxableAmount: ExtractedField;
  /** GST rate as a percentage, as text: "18", "0", "5". */
  gstRatePercent: ExtractedField;
}

export type DocumentKind = 'purchase_invoice' | 'sales_invoice' | 'receipt' | 'other';

/**
 * The whole of what a model may return about one document.
 *
 * Deliberately flat and small. Every addition here is another thing a reviewer has
 * to check, and a field the product does not use is a field nobody checks.
 */
export interface ExtractedDocument {
  kind: DocumentKind;
  /** Why the model thinks it is that kind. Shown to the reviewer. */
  kindReason: string | null;

  supplierName: ExtractedField;
  supplierGstin: ExtractedField;
  supplierStateCode: ExtractedField;

  buyerName: ExtractedField;
  buyerGstin: ExtractedField;
  placeOfSupplyStateCode: ExtractedField;

  invoiceNumber: ExtractedField;
  /** As printed. Normalising a date is our job, not the model's. */
  invoiceDate: ExtractedField;

  lines: ExtractedLine[];

  /** The totals as *printed on the document*, for cross-checking our own. */
  statedTaxableTotal: ExtractedField;
  statedCgst: ExtractedField;
  statedSgst: ExtractedField;
  statedIgst: ExtractedField;
  statedCess: ExtractedField;
  statedRoundOff: ExtractedField;
  statedGrandTotal: ExtractedField;

  /** True when the document says tax is payable by the recipient. */
  reverseCharge: ExtractedField<boolean>;

  /** Anything the model could not read, in its own words. */
  unreadable: string[];
}

/** Below this, a field is shown as uncertain and pre-flagged for the reviewer. */
export const CONFIDENCE_FLOOR = 0.75;

/**
 * The provider contract.
 *
 * One method, so swapping Gemini for anything else is a one-line change and no
 * caller learns which model answered. The provider's job ends at returning text
 * and confidences; it computes nothing and it touches no database.
 */
export interface ExtractionProvider {
  /** For the audit row, so a figure can be traced to what produced it. */
  readonly name: string;
  readonly model: string;
  /** Bumped whenever the prompt changes, so old extractions stay interpretable. */
  readonly promptVersion: string;

  extract(input: {
    bytes: Buffer;
    mimeType: string;
    /** What the uploader said it is, as a hint. The model may disagree. */
    declaredType?: string | null;
  }): Promise<ProviderResult>;
}

export type ProviderResult =
  | { ok: true; document: ExtractedDocument; raw: unknown; usage?: ProviderUsage }
  | { ok: false; reason: string; raw?: unknown };

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Thrown when a provider is asked for but not configured. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
