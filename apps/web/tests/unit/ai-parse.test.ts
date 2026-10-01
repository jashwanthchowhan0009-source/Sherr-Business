import { describe, expect, it } from 'vitest';
import {
  MAX_LINES,
  UnreadableReplyError,
  cleanText,
  extractJsonObject,
  parseBooleanField,
  parseConfidence,
  parseExtractedDocument,
  parseField,
} from '@/lib/ai/parse';

describe('extractJsonObject', () => {
  it('reads bare JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON inside a fenced block, which models emit constantly', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads JSON wrapped in the prose a model adds despite being asked not to', () => {
    expect(
      extractJsonObject('Here is the extraction:\n```json\n{"a":1}\n```\nLet me know!'),
    ).toEqual({ a: 1 });
  });

  it('falls back to the span between the outer braces', () => {
    expect(extractJsonObject('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('throws rather than guessing when there is no JSON at all', () => {
    expect(() => extractJsonObject('I cannot read this image.')).toThrow(UnreadableReplyError);
    expect(() => extractJsonObject('')).toThrow(UnreadableReplyError);
  });

  it('throws on JSON that is merely broken, rather than repairing it', () => {
    // Repairing would mean deciding what the model meant, which is exactly the
    // judgement this product does not let a model make.
    expect(() => extractJsonObject('{"a":1,}garbage{')).toThrow(UnreadableReplyError);
  });
});

describe('parseConfidence', () => {
  it('takes a fraction as given', () => {
    expect(parseConfidence(0.95)).toBe(0.95);
    expect(parseConfidence(0)).toBe(0);
    expect(parseConfidence(1)).toBe(1);
  });

  it('reads a percentage, which models return about as often', () => {
    expect(parseConfidence(95)).toBe(0.95);
    expect(parseConfidence('95%')).toBe(0.95);
    expect(parseConfidence('88')).toBe(0.88);
  });

  it('reads the words a model uses when it ignores the number', () => {
    expect(parseConfidence('high')).toBe(0.9);
    expect(parseConfidence('medium')).toBe(0.6);
    expect(parseConfidence('low')).toBe(0.3);
  });

  it('falls to zero on anything unrecognisable, which means "look at this"', () => {
    for (const value of [undefined, null, {}, [], 'very sure', NaN, Infinity]) {
      expect(parseConfidence(value)).toBe(0);
    }
  });

  it('clamps rather than trusting a number out of range', () => {
    expect(parseConfidence(-1)).toBe(0);
    expect(parseConfidence(200)).toBe(1);
  });
});

describe('cleanText', () => {
  it('turns every way a model says "nothing" into nothing', () => {
    for (const text of ['', '-', 'N/A', 'n/a', 'NIL', 'none', 'null', 'not found', 'Unknown', 'illegible']) {
      expect(cleanText(text), `"${text}" should read as absent`).toBeNull();
    }
  });

  it('collapses the whitespace a value read across two lines arrives with', () => {
    expect(cleanText('Acme\n  Traders   Pvt Ltd')).toBe('Acme Traders Pvt Ltd');
  });

  it('keeps a legitimate value that merely looks empty-ish', () => {
    expect(cleanText('0')).toBe('0');
    expect(cleanText(0)).toBe('0');
    expect(cleanText('NA Industries')).toBe('NA Industries');
  });

  it('rejects a non-finite number rather than writing "NaN"', () => {
    expect(cleanText(NaN)).toBeNull();
    expect(cleanText(Infinity)).toBeNull();
  });
});

describe('parseField', () => {
  it('reads the asked-for shape', () => {
    expect(parseField({ value: 'INV/001', confidence: 0.9 })).toEqual({
      value: 'INV/001',
      confidence: 0.9,
      note: null,
    });
  });

  it('accepts a bare string, but will not claim the model was confident', () => {
    expect(parseField('INV/001')).toEqual({ value: 'INV/001', confidence: 0.5, note: null });
  });

  it('gives a value that is absent a confidence of zero, whatever was claimed', () => {
    // A model that says it is 99% sure of nothing has not found the field.
    expect(parseField({ value: null, confidence: 0.99 })).toEqual({
      value: null,
      confidence: 0,
      note: null,
    });
    expect(parseField({ value: 'N/A', confidence: 1 }).confidence).toBe(0);
  });

  it('reads an unrecognisable field as not found', () => {
    expect(parseField(undefined)).toEqual({ value: null, confidence: 0, note: null });
    expect(parseField({ nonsense: true })).toEqual({ value: null, confidence: 0, note: null });
  });
});

describe('parseBooleanField', () => {
  it('reads a boolean and the words for one', () => {
    expect(parseBooleanField({ value: true, confidence: 1 }).value).toBe(true);
    expect(parseBooleanField({ value: 'yes', confidence: 1 }).value).toBe(true);
    expect(parseBooleanField({ value: 'No', confidence: 1 }).value).toBe(false);
    expect(parseBooleanField(true).value).toBe(true);
  });

  it('treats absence as unknown rather than as false', () => {
    // Reverse charge is the field this matters for: defaulting it to false would
    // silently drop a liability the recipient owes.
    const result = parseBooleanField(undefined);
    expect(result.value).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('treats a word it does not recognise as unknown', () => {
    expect(parseBooleanField({ value: 'probably' }).value).toBeNull();
  });
});

describe('parseExtractedDocument', () => {
  const minimal = {
    kind: 'purchase_invoice',
    supplierName: { value: 'Acme Traders', confidence: 0.98 },
    lines: [{ description: 'Rice', taxableAmount: '100000', gstRatePercent: '5' }],
  };

  it('reads a well-formed reply', () => {
    const doc = parseExtractedDocument(minimal);
    expect(doc.kind).toBe('purchase_invoice');
    expect(doc.supplierName.value).toBe('Acme Traders');
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]!.taxableAmount.value).toBe('100000');
  });

  it('accepts the field names a model uses instead of the ones asked for', () => {
    const doc = parseExtractedDocument({
      documentKind: 'sales_invoice',
      invoiceNo: 'INV/1',
      placeOfSupply: '36',
      total: '118000',
      lines: [{ description: 'Rice', hsn: '1006', amount: '100000', gstRate: '5', qty: '10', uom: 'QTL' }],
    });
    expect(doc.kind).toBe('sales_invoice');
    expect(doc.invoiceNumber.value).toBe('INV/1');
    expect(doc.placeOfSupplyStateCode.value).toBe('36');
    expect(doc.statedGrandTotal.value).toBe('118000');
    expect(doc.lines[0]!.hsnSac.value).toBe('1006');
    expect(doc.lines[0]!.quantity.value).toBe('10');
    expect(doc.lines[0]!.unit.value).toBe('QTL');
  });

  it('falls to `other` on a kind it does not recognise, so a person chooses', () => {
    // "tax invoice" says nothing about direction, and guessing wrong puts a
    // purchase in the sales register.
    expect(parseExtractedDocument({ ...minimal, kind: 'tax invoice' }).kind).toBe('other');
    expect(parseExtractedDocument({ ...minimal, kind: 'bill' }).kind).toBe('other');
    expect(parseExtractedDocument({ ...minimal, kind: undefined }).kind).toBe('other');
  });

  it('normalises the separators in a kind it does recognise', () => {
    expect(parseExtractedDocument({ ...minimal, kind: 'purchase invoice' }).kind).toBe(
      'purchase_invoice',
    );
    expect(parseExtractedDocument({ ...minimal, kind: 'Purchase-Invoice' }).kind).toBe(
      'purchase_invoice',
    );
  });

  it('drops keys the contract does not define', () => {
    const doc = parseExtractedDocument({ ...minimal, vendorBankAccount: '1234567890' });
    expect(Object.keys(doc)).not.toContain('vendorBankAccount');
  });

  it('throws on an empty object rather than returning a blank document', () => {
    expect(() => parseExtractedDocument({})).toThrow(UnreadableReplyError);
    expect(() => parseExtractedDocument(null)).toThrow(UnreadableReplyError);
    expect(() => parseExtractedDocument('a string')).toThrow(UnreadableReplyError);
  });

  it('survives a missing lines array', () => {
    const doc = parseExtractedDocument({ kind: 'purchase_invoice' });
    expect(doc.lines).toEqual([]);
  });

  it('caps the lines and says so, rather than dropping them silently', () => {
    const doc = parseExtractedDocument({
      kind: 'purchase_invoice',
      lines: Array.from({ length: MAX_LINES + 5 }, () => ({ description: 'x' })),
    });
    expect(doc.lines).toHaveLength(MAX_LINES);
    expect(doc.unreadable.join(' ')).toContain(`${MAX_LINES + 5} lines`);
  });

  it('carries the model’s own list of what it could not read', () => {
    const doc = parseExtractedDocument({
      ...minimal,
      unreadable: ['the stamp in the corner', '', null, 'the second page'],
    });
    expect(doc.unreadable).toEqual(['the stamp in the corner', 'the second page']);
  });
});
