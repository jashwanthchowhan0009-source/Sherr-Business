import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderInvoicePdf, type InvoicePdfInput } from '../../src/lib/pdf/invoice';

/**
 * The invoice PDF is rendered for real and then read back.
 *
 * Asserting on the input would prove nothing: the thing that goes wrong with a
 * PDF is the output — a missing glyph for the rupee sign, a total that
 * disagrees with the words beside it, a draft that prints as if it were
 * issued. So the bytes are produced and inspected.
 */

const base: InvoicePdfInput = {
  company: {
    legalName: 'Sample Traders Private Limited',
    tradeName: 'Sample Traders',
    gstin: '29AABCS1234A1ZX',
    pan: 'AABCS1234A',
    stateCode: '29',
  },
  voucher: {
    voucherNo: 'INV/25-26/0001',
    voucherDate: '2025-06-15',
    status: 'posted',
    reference: 'PO-4471',
    narration: null,
    supplyType: 'intra_state',
    supplierStateCode: '29',
    placeOfSupplyStateCode: '29',
    // The spec §11 acceptance case: ₹1,00,000 at 18% within one state.
    taxablePaise: 1_00_000_00n,
    cgstPaise: 9_000_00n,
    sgstPaise: 9_000_00n,
    igstPaise: 0n,
    cessPaise: 0n,
    roundOffPaise: 0n,
    totalPaise: 1_18_000_00n,
  },
  party: {
    name: 'Anand Enterprises',
    legalName: 'Anand Enterprises LLP',
    gstin: '29AAACA1111A1Z7',
    stateCode: '29',
    billingAddress: '14 MG Road, Bengaluru 560001',
  },
  lines: [
    {
      lineNo: 1,
      description: 'Basmati rice, premium grade',
      hsnSac: '1006',
      unit: 'KGS',
      quantity: 10_000n,
      unitPricePaise: 1_00_000_00n,
      gstRateBps: 1800,
      taxablePaise: 1_00_000_00n,
      cgstPaise: 9_000_00n,
      sgstPaise: 9_000_00n,
      igstPaise: 0n,
      lineTotalPaise: 1_18_000_00n,
    },
  ],
};

/**
 * Reads the text back out of a rendered PDF.
 *
 * pdfjs rather than a hand-rolled extractor: the font is a subset, so the text
 * operators carry glyph codes rather than ASCII, and recovering characters
 * means following the embedded ToUnicode map. Asserting on the input instead
 * would prove nothing about what reached the page.
 */
async function pdfText(pdf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    // No system fonts to look up and no worker in Node.
    useSystemFonts: false,
  }).promise;

  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' '),
    );
  }
  await doc.cleanup();
  return pages.join('\n').replace(/\s+/g, ' ');
}

describe('invoice PDF', () => {
  let pdf: Buffer;
  let text: string;

  beforeAll(async () => {
    pdf = await renderInvoicePdf(base);
    text = await pdfText(pdf);
  }, 60_000);

  afterAll(() => undefined);

  it('produces a real PDF', () => {
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(2000);
    expect(pdf.subarray(-6).toString()).toContain('EOF');
  });

  it('embeds a font, so the rupee sign is not a missing glyph', () => {
    // Helvetica and the other built-in PDF fonts use WinAnsi, which has no
    // rupee sign: an invoice set in one prints every amount with a gap. The
    // presence of an embedded font file is what rules that out.
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/FontFile2/);
    expect(raw).toMatch(/\/Subtype\s*\/TrueType|\/Type0/);
  });

  it('renders the rupee sign as a rupee sign', () => {
    // The point of carrying a font in the repo. Read back through the embedded
    // ToUnicode map, so this is the character that a reader of the PDF sees,
    // not merely the character that went in.
    expect(text).toContain('₹');
    expect(text).toContain('₹1,18,000.00');
  });

  it('states the figures from the voucher', () => {
    expect(text).toContain('INV/25-26/0001');
    expect(text).toContain('1,00,000.00'); // taxable
    expect(text).toContain('9,000.00'); // CGST and SGST
    expect(text).toContain('1,18,000.00'); // total
  });

  it('names both GSTINs and the place of supply', () => {
    expect(text).toContain('29AABCS1234A1ZX');
    expect(text).toContain('29AAACA1111A1Z7');
    expect(text).toContain('Karnataka');
  });

  it('states the total in words, agreeing with the figures', () => {
    expect(text).toContain('Rupees One Lakh Eighteen Thousand Only');
  });

  it('carries the professional-review footer the spec requires', () => {
    expect(text).toContain('Prepared by SherrByte');
    expect(text.toLowerCase()).toContain('qualified professional');
  });

  it('shows CGST and SGST for an intra-state supply, and no IGST', () => {
    expect(text).toContain('CGST');
    expect(text).toContain('SGST');
    expect(text).not.toContain('IGST');
  });

  it('shows IGST alone for an inter-state supply', async () => {
    const interState = await renderInvoicePdf({
      ...base,
      voucher: {
        ...base.voucher,
        supplyType: 'inter_state',
        placeOfSupplyStateCode: '27',
        cgstPaise: 0n,
        sgstPaise: 0n,
        igstPaise: 18_000_00n,
      },
      lines: [
        { ...base.lines[0]!, cgstPaise: 0n, sgstPaise: 0n, igstPaise: 18_000_00n },
      ],
    });
    const interText = await pdfText(interState);
    expect(interText).toContain('IGST');
    expect(interText).toContain('18,000.00');
    expect(interText).toContain('Maharashtra');
    expect(interText).not.toContain('CGST');
  });

  it('marks a draft as not a valid tax invoice', async () => {
    const draft = await renderInvoicePdf({
      ...base,
      voucher: { ...base.voucher, status: 'draft' },
    });
    const draftText = await pdfText(draft);
    expect(draftText).toContain('DRAFT');
    expect(draftText).toContain('not a valid tax invoice');
  });

  it('says plainly when the supplier is not registered, rather than omitting tax silently', async () => {
    const unregistered = await renderInvoicePdf({
      ...base,
      company: { ...base.company, gstin: null },
    });
    const unregText = await pdfText(unregistered);
    expect(unregText).toContain('not GST-registered');
  });

  it('shows a round-off line only when there is one', async () => {
    expect(text).not.toContain('Round off');

    const rounded = await renderInvoicePdf({
      ...base,
      voucher: { ...base.voucher, roundOffPaise: -37n, totalPaise: 1_17_999_63n },
    });
    expect(await pdfText(rounded)).toContain('Round off');
  });

  it('handles an unregistered buyer without inventing a GSTIN', async () => {
    const cashSale = await renderInvoicePdf({ ...base, party: null });
    const cashText = await pdfText(cashSale);
    expect(cashText).toContain('Cash sale');
    expect(cashText).toContain('Unregistered');
  });
});
