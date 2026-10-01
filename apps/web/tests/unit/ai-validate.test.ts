import { describe, expect, it } from 'vitest';
import { parseDocumentDate, validateExtraction } from '@/lib/ai/validate';
import { parseExtractedDocument } from '@/lib/ai/parse';
import type { ExtractedDocument } from '@/lib/ai/contract';

/**
 * Checksum-valid GSTINs, verified with the project's own `gstinCheckDigit` rather
 * than recalled. Two of my first attempts here had the wrong check digit and the
 * validator correctly rejected them, which is the test doing its job on itself.
 */
const SUPPLIER_GSTIN = '36AABCU9603R1ZO';
const OWN_GSTIN = '36AAACI1195H1ZN';
const OTHER_STATE_GSTIN = '27AAACI1195H1ZM';

const TODAY = '2025-07-15';

/**
 * An intra-state purchase of ₹1,00,000 at 5%: CGST ₹2,500 and SGST ₹2,500,
 * ₹1,05,000 in all. Every figure here is one a reader can check by hand.
 */
function document(over: Record<string, unknown> = {}): ExtractedDocument {
  return parseExtractedDocument({
    kind: 'purchase_invoice',
    supplierName: { value: 'Acme Traders', confidence: 0.97 },
    supplierGstin: { value: SUPPLIER_GSTIN, confidence: 0.95 },
    supplierStateCode: { value: '36', confidence: 0.95 },
    buyerName: { value: 'Our Company', confidence: 0.9 },
    buyerGstin: { value: OWN_GSTIN, confidence: 0.92 },
    placeOfSupplyStateCode: { value: '36', confidence: 0.9 },
    invoiceNumber: { value: 'AT/2025-26/0042', confidence: 0.96 },
    invoiceDate: { value: '10/07/2025', confidence: 0.94 },
    lines: [
      {
        description: { value: 'Sona Masoori rice', confidence: 0.95 },
        hsnSac: { value: '1006', confidence: 0.9 },
        quantity: { value: '10', confidence: 0.9 },
        unit: { value: 'QTL', confidence: 0.9 },
        rate: { value: '10000', confidence: 0.9 },
        taxableAmount: { value: '100000', confidence: 0.95 },
        gstRatePercent: { value: '5', confidence: 0.95 },
      },
    ],
    statedTaxableTotal: { value: '100000', confidence: 0.95 },
    statedCgst: { value: '2500', confidence: 0.95 },
    statedSgst: { value: '2500', confidence: 0.95 },
    statedGrandTotal: { value: '105000', confidence: 0.96 },
    ...over,
  });
}

const check = (doc: ExtractedDocument, context = {}) =>
  validateExtraction(doc, { today: TODAY, ownGstin: OWN_GSTIN, ownStateCode: '36', ...context });

const messages = (r: ReturnType<typeof check>) => r.findings.map((f) => f.message).join(' | ');
const blockers = (r: ReturnType<typeof check>) => r.findings.filter((f) => f.severity === 'blocker');

describe('parseDocumentDate', () => {
  it('reads a day-first date, which is what Indian documents print', () => {
    // The one ambiguity that would move an invoice into the wrong return period.
    expect(parseDocumentDate('03/04/2025').iso).toBe('2025-04-03');
    expect(parseDocumentDate('3-4-2025').iso).toBe('2025-04-03');
    expect(parseDocumentDate('03.04.25').iso).toBe('2025-04-03');
  });

  it('reads an ISO date unchanged', () => {
    expect(parseDocumentDate('2025-07-10').iso).toBe('2025-07-10');
  });

  it('reads a named month either way round', () => {
    expect(parseDocumentDate('15 July 2025').iso).toBe('2025-07-15');
    expect(parseDocumentDate('15-Jul-2025').iso).toBe('2025-07-15');
    expect(parseDocumentDate('July 15, 2025').iso).toBe('2025-07-15');
  });

  it('refuses a date that does not exist rather than rolling it over', () => {
    expect(parseDocumentDate('31/02/2025').iso).toBeNull();
    expect(parseDocumentDate('31/02/2025').problem).toMatch(/not a real date/);
    expect(parseDocumentDate('32/01/2025').iso).toBeNull();
  });

  it('refuses what it cannot read instead of guessing', () => {
    expect(parseDocumentDate('sometime in July').iso).toBeNull();
    expect(parseDocumentDate('07/2025').iso).toBeNull();
  });

  it('reports nothing for a field that was not found', () => {
    expect(parseDocumentDate(null)).toEqual({ iso: null, problem: null });
  });
});

describe('validateExtraction', () => {
  it('passes a document whose arithmetic agrees, with nothing to resolve', () => {
    const result = check(document());
    expect(blockers(result)).toEqual([]);
    expect(result.readyForReview).toBe(true);
    expect(result.computed).not.toBeNull();
    expect(result.computed!.cgstPaise).toBe(2_500_00n);
    expect(result.computed!.sgstPaise).toBe(2_500_00n);
    expect(result.computed!.totalPaise).toBe(1_05_000_00n);
  });

  it('computes the tax itself rather than believing the document’s figure', () => {
    // The document claims ₹9,000 of CGST on a 5% line. Our own computation stands
    // at ₹2,500 and the claim becomes a finding — this is the whole rule.
    const result = check(document({ statedCgst: { value: '9000', confidence: 0.99 } }));
    expect(result.computed!.cgstPaise).toBe(2_500_00n);
    expect(messages(result)).toContain('₹9000.00');
    expect(messages(result)).toContain('₹2500.00');
    expect(blockers(result).length).toBeGreaterThan(0);
  });

  it('treats a disagreement within a rupee as rounding, not as an error', () => {
    const result = check(document({ statedGrandTotal: { value: '105000.50', confidence: 0.9 } }));
    const total = result.findings.find((f) => f.field === 'statedGrandTotal');
    expect(total?.severity).toBe('check');
  });

  it('blocks a GSTIN that fails its own check digit', () => {
    // A GSTIN carries a checksum, so this is arithmetic rather than a guess.
    const result = check(document({ supplierGstin: { value: '36AABCU9603R1ZX', confidence: 0.99 } }));
    expect(blockers(result).some((f) => f.field === 'supplierGstin')).toBe(true);
    expect(messages(result)).toMatch(/misread or the document is wrong/);
  });

  it('refuses a document on which the company is neither party', () => {
    const result = check(
      document({ buyerGstin: { value: OTHER_STATE_GSTIN, confidence: 0.9 } }),
      { ownGstin: OWN_GSTIN },
    );
    expect(messages(result)).toMatch(/does not belong in these books/);
  });

  it('catches a purchase that is really a sale', () => {
    const result = check(
      document({
        supplierGstin: { value: OWN_GSTIN, confidence: 0.95 },
        buyerGstin: { value: SUPPLIER_GSTIN, confidence: 0.95 },
      }),
    );
    expect(messages(result)).toMatch(/It is a sales invoice/);
  });

  it('refuses a document whose two parties are the same', () => {
    const result = check(
      document({ supplierGstin: { value: OWN_GSTIN, confidence: 0.9 } }),
    );
    expect(messages(result)).toMatch(/same GSTIN/);
  });

  it('blocks a document that cannot be dated', () => {
    const result = check(document({ invoiceDate: { value: null, confidence: 0 } }));
    expect(blockers(result).some((f) => f.field === 'invoiceDate')).toBe(true);
  });

  it('blocks a date inside a closed period', () => {
    const result = check(document(), { lockedUpto: '2025-07-31' });
    expect(messages(result)).toMatch(/books are closed to 2025-07-31/);
  });

  it('blocks a date before the books begin', () => {
    const result = check(document(), { booksStartDate: '2025-08-01' });
    expect(messages(result)).toMatch(/before the books start/);
  });

  it('flags a future date without blocking it', () => {
    const result = check(document({ invoiceDate: { value: '10/09/2025', confidence: 0.9 } }));
    const finding = result.findings.find((f) => f.field === 'invoiceDate');
    expect(finding?.severity).toBe('check');
    expect(finding?.message).toMatch(/in the future/);
  });

  it('refuses IGST and CGST/SGST on the same document', () => {
    const result = check(document({ statedIgst: { value: '5000', confidence: 0.9 } }));
    expect(messages(result)).toMatch(/either inter-state or intra-state, not both/);
  });

  it('notices CGST and SGST that are not equal', () => {
    const result = check(document({ statedSgst: { value: '2400', confidence: 0.9 } }));
    expect(messages(result)).toMatch(/halves of one rate and should be equal/);
  });

  it('reports a stated figure that is absent while ours is not, without reading it as nil', () => {
    // "No IGST line" and "IGST of nil" are different claims about a document.
    const result = check(
      document({
        supplierStateCode: { value: '27', confidence: 0.9 },
        statedCgst: { value: null, confidence: 0 },
        statedSgst: { value: null, confidence: 0 },
        statedGrandTotal: { value: '105000', confidence: 0.9 },
      }),
    );
    expect(messages(result)).toMatch(/shows no IGST, but ₹5000.00 was computed/);
  });

  it('blocks a line with no GST rate rather than assuming one', () => {
    const result = check(
      document({
        lines: [{ description: 'Rice', taxableAmount: '100000' }],
      }),
    );
    expect(blockers(result).some((f) => f.message.includes('no GST rate'))).toBe(true);
  });

  it('flags a rate outside the usual slabs, which is what a misread 18 looks like', () => {
    const result = check(
      document({
        lines: [{ description: 'Rice', taxableAmount: '100000', gstRatePercent: '1.8' }],
        statedCgst: { value: '900', confidence: 0.9 },
        statedSgst: { value: '900', confidence: 0.9 },
        statedGrandTotal: { value: '101800', confidence: 0.9 },
      }),
    );
    expect(messages(result)).toMatch(/not one of the usual GST rates/);
  });

  it('cross-checks quantity × rate against the printed line amount', () => {
    // A misread quantity shows up here and nowhere else.
    const result = check(
      document({
        lines: [
          {
            description: 'Rice',
            quantity: '100',
            rate: '10000',
            taxableAmount: '100000',
            gstRatePercent: '5',
          },
        ],
      }),
    );
    expect(messages(result)).toMatch(/comes to ₹1000000.00, but the line amount reads ₹100000.00/);
  });

  it('determines IGST from the state codes, not from the document’s tax lines', () => {
    const result = check(
      document({
        supplierStateCode: { value: '27', confidence: 0.9 },
        placeOfSupplyStateCode: { value: '36', confidence: 0.9 },
        statedCgst: { value: null, confidence: 0 },
        statedSgst: { value: null, confidence: 0 },
        statedIgst: { value: '5000', confidence: 0.9 },
      }),
    );
    expect(result.computed!.igstPaise).toBe(5_000_00n);
    expect(result.computed!.cgstPaise).toBe(0n);
    expect(result.computed!.supplyType).toBe('inter_state');
  });

  it('asks for the place of supply when it cannot tell which tax applies', () => {
    const result = check(
      document({
        supplierStateCode: { value: null, confidence: 0 },
        supplierGstin: { value: null, confidence: 0 },
        placeOfSupplyStateCode: { value: null, confidence: 0 },
      }),
    );
    expect(messages(result)).toMatch(/cannot be determined from the document/);
    expect(result.computed).toBeNull();
  });

  it('blocks a document it cannot classify', () => {
    const result = check(document({ kind: 'tax invoice' }));
    expect(blockers(result).some((f) => f.field === 'kind')).toBe(true);
  });

  it('surfaces a low confidence on a field it did read', () => {
    const result = check(document({ invoiceNumber: { value: 'AT/0042', confidence: 0.4 } }));
    const finding = result.findings.find((f) => f.field === 'invoiceNumber');
    expect(finding?.message).toMatch(/40% confident/);
    expect(finding?.severity).toBe('check');
  });

  it('warns that a missing invoice number defeats duplicate detection', () => {
    const result = check(document({ invoiceNumber: { value: null, confidence: 0 } }));
    expect(messages(result)).toMatch(/duplicate bill cannot be detected/);
  });

  it('notes reverse charge, and charges no tax when the document says so', () => {
    const result = check(
      document({
        reverseCharge: { value: true, confidence: 0.9 },
        statedCgst: { value: null, confidence: 0 },
        statedSgst: { value: null, confidence: 0 },
        statedGrandTotal: { value: '100000', confidence: 0.9 },
      }),
    );
    expect(result.computed!.cgstPaise).toBe(0n);
    expect(result.computed!.totalPaise).toBe(1_00_000_00n);
    expect(messages(result)).toMatch(/payable by the recipient/);
  });

  it('carries the model’s own list of what it could not read into the findings', () => {
    const result = check(document({ unreadable: ['the second page'] }));
    expect(messages(result)).toMatch(/could not read: the second page/);
  });

  it('never reports readyForReview on a document with a blocker', () => {
    const result = check(document({ invoiceDate: { value: 'sometime', confidence: 0.9 } }));
    expect(result.readyForReview).toBe(false);
  });
});
