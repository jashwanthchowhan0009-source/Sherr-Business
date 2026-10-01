/**
 * Reading a model's reply.
 *
 * A model returns whatever it returns: prose around the JSON, a fenced code block,
 * a missing field, a confidence of 95 where 0.95 was asked for, `"N/A"` where null
 * was asked for, an extra field nobody wants. None of that may reach the rest of
 * the product, so this module is strict in one direction and forgiving in the
 * other: forgiving about the shape of the envelope, strict about what comes out.
 *
 * It never invents a value. A field it cannot read becomes `null` with confidence
 * zero, which the reviewer sees as "not found" — not as an empty string that looks
 * like a deliberate blank, and never as a plausible guess.
 */
import {
  CONFIDENCE_FLOOR,
  type DocumentKind,
  type ExtractedDocument,
  type ExtractedField,
  type ExtractedLine,
} from './contract';

export { CONFIDENCE_FLOOR };

const KINDS: readonly DocumentKind[] = [
  'purchase_invoice',
  'sales_invoice',
  'receipt',
  'other',
];

/**
 * Strings a model uses to mean "nothing here".
 *
 * Treated as absence rather than as content, because `"N/A"` posted into a GSTIN
 * field is worse than a blank: it looks like data.
 */
const NULLISH = new Set([
  '',
  '-',
  '--',
  'n/a',
  'na',
  'nil',
  'none',
  'null',
  'undefined',
  'not found',
  'not available',
  'not applicable',
  'not visible',
  'unknown',
  'not specified',
  'not mentioned',
  'illegible',
]);

/** The JSON inside whatever the model wrapped it in. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  // The common cases first: bare JSON, or a fenced block.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter((c): c is string => typeof c === 'string');

  for (const candidate of candidates) {
    const parsed = tryParse(candidate.trim());
    if (parsed !== undefined) return parsed;
  }

  // Last resort: the span from the first brace to the last. Scanning for a
  // balanced object would be more precise, but a model that emits two objects has
  // not answered the question and should fail rather than have one picked for it.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const parsed = tryParse(trimmed.slice(first, last + 1));
    if (parsed !== undefined) return parsed;
  }

  throw new UnreadableReplyError('The model did not return JSON.');
}

function tryParse(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class UnreadableReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableReplyError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A confidence, normalised.
 *
 * Models say 0.95, 95, "95%", "high" and sometimes nothing. All of those become a
 * number in 0..1, and anything unrecognisable becomes 0 — the value that means
 * "look at this", which is the safe direction to fail in.
 */
export function parseConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return 0;
    // A model asked for 0..1 that answers 95 means 95%.
    if (value > 1) return value > 100 ? 1 : value / 100;
    return value;
  }

  if (typeof value === 'string') {
    const text = value.trim().toLowerCase().replace(/%$/, '');
    const word = { high: 0.9, medium: 0.6, moderate: 0.6, low: 0.3, none: 0 }[text];
    if (word !== undefined) return word;
    const n = Number(text);
    if (Number.isFinite(n)) return parseConfidence(n);
  }

  return 0;
}

/** One field, from whatever the model put there. */
export function parseField(value: unknown): ExtractedField {
  // A bare string or number, where an object was asked for. Taken at face value
  // with no confidence, since none was offered.
  if (typeof value === 'string' || typeof value === 'number') {
    return { value: cleanText(value), confidence: cleanText(value) === null ? 0 : 0.5, note: null };
  }

  const record = asRecord(value);
  if (!('value' in record) && !('confidence' in record)) {
    return { value: null, confidence: 0, note: null };
  }

  const text = cleanText(record.value);
  return {
    value: text,
    // A value that is not there cannot be confident, whatever the model claims.
    confidence: text === null ? 0 : parseConfidence(record.confidence),
    note: cleanText(record.note) ?? null,
  };
}

/** A boolean field. Absence is not false — it is unknown, so confidence stays 0. */
export function parseBooleanField(value: unknown): ExtractedField<boolean> {
  const record = asRecord(value);
  const raw = typeof value === 'boolean' ? value : record.value;

  let parsed: boolean | null = null;
  if (typeof raw === 'boolean') parsed = raw;
  else if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(text)) parsed = true;
    else if (['false', 'no', 'n', '0'].includes(text)) parsed = false;
  }

  return {
    value: parsed,
    confidence: parsed === null ? 0 : parseConfidence(record.confidence ?? 1),
    note: cleanText(record.note) ?? null,
  };
}

/** Text, with the model's ways of saying "nothing" turned into nothing. */
export function cleanText(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== 'string') return null;

  // Collapse whitespace: a value read across two lines of a scan arrives with a
  // newline in the middle of it, and no field here is meaningfully multi-line.
  const text = value.replace(/\s+/g, ' ').trim();
  if (NULLISH.has(text.toLowerCase())) return null;
  return text === '' ? null : text;
}

function parseLine(value: unknown): ExtractedLine {
  const record = asRecord(value);
  return {
    description: parseField(record.description),
    hsnSac: parseField(record.hsnSac ?? record.hsn ?? record.sac),
    quantity: parseField(record.quantity ?? record.qty),
    unit: parseField(record.unit ?? record.uom),
    rate: parseField(record.rate ?? record.unitPrice),
    taxableAmount: parseField(record.taxableAmount ?? record.amount ?? record.taxableValue),
    gstRatePercent: parseField(record.gstRatePercent ?? record.gstRate ?? record.taxRate),
  };
}

function parseKind(value: unknown): DocumentKind {
  const text = cleanText(asRecord(value).value ?? value)?.toLowerCase().replace(/[\s-]+/g, '_');
  const match = KINDS.find((k) => k === text);
  if (match) return match;

  // A model that says "tax invoice" has told us something useful but not which
  // direction it points, and guessing the direction wrong puts a purchase in the
  // sales register. `other` makes the reviewer choose.
  return 'other';
}

/**
 * The whole document, strictly.
 *
 * Unknown keys are dropped rather than carried: anything not in the contract has
 * no reviewer, no validation and no use, so keeping it would only invite someone
 * to read it later and trust it.
 */
export function parseExtractedDocument(value: unknown): ExtractedDocument {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    throw new UnreadableReplyError('The model returned an empty object.');
  }

  const rawLines = Array.isArray(record.lines) ? record.lines : [];

  return {
    kind: parseKind(record.kind ?? record.documentKind),
    kindReason: cleanText(record.kindReason ?? record.reason),

    supplierName: parseField(record.supplierName),
    supplierGstin: parseField(record.supplierGstin),
    supplierStateCode: parseField(record.supplierStateCode),

    buyerName: parseField(record.buyerName),
    buyerGstin: parseField(record.buyerGstin),
    placeOfSupplyStateCode: parseField(record.placeOfSupplyStateCode ?? record.placeOfSupply),

    invoiceNumber: parseField(record.invoiceNumber ?? record.invoiceNo),
    invoiceDate: parseField(record.invoiceDate),

    // A cap, because a model looping on a table can emit thousands of lines and a
    // reviewer cannot check thousands. What is dropped is reported as unreadable
    // rather than silently lost.
    lines: rawLines.slice(0, MAX_LINES).map(parseLine),

    statedTaxableTotal: parseField(record.statedTaxableTotal ?? record.taxableTotal),
    statedCgst: parseField(record.statedCgst ?? record.cgst),
    statedSgst: parseField(record.statedSgst ?? record.sgst),
    statedIgst: parseField(record.statedIgst ?? record.igst),
    statedCess: parseField(record.statedCess ?? record.cess),
    statedRoundOff: parseField(record.statedRoundOff ?? record.roundOff),
    statedGrandTotal: parseField(record.statedGrandTotal ?? record.grandTotal ?? record.total),

    reverseCharge: parseBooleanField(record.reverseCharge),

    unreadable: [
      ...(Array.isArray(record.unreadable) ? record.unreadable : [])
        .map((u) => cleanText(u))
        .filter((u): u is string => u !== null),
      ...(rawLines.length > MAX_LINES
        ? [`The document has ${rawLines.length} lines; only the first ${MAX_LINES} were read.`]
        : []),
    ],
  };
}

/** More lines than a person will check one by one. */
export const MAX_LINES = 200;
