import { describe, expect, it } from 'vitest';
import {
  UnreadableGstr2bError,
  normalisePortalDate,
  parseGstr2b,
  portalAmountToPaise,
  reconKey,
  reconcileGstr2b,
  type BookPurchase,
  type Gstr2bInvoice,
} from '../../src/lib/gst/gstr2b';
import { zeroTax, type TaxAmounts } from '../../src/lib/gst/set-off';

const tax = (over: Partial<TaxAmounts> = {}): TaxAmounts => ({ ...zeroTax(), ...over });

describe('portalAmountToPaise', () => {
  it('reads a whole rupee figure', () => {
    expect(portalAmountToPaise(18000)).toBe(18_000_00n);
    expect(portalAmountToPaise('18000')).toBe(18_000_00n);
  });

  it('reads paise without losing one to a float', () => {
    // 18000.07 * 100 is 1800006.9999999998 in IEEE-754, and truncating that
    // loses a paisa on a figure that has to match the portal exactly.
    expect(portalAmountToPaise(18000.07)).toBe(18_000_07n);
    expect(portalAmountToPaise('18000.07')).toBe(18_000_07n);
    expect(portalAmountToPaise(0.07)).toBe(7n);
    expect(portalAmountToPaise(1.1)).toBe(110n);
  });

  it('agrees with integer arithmetic across every paise value in a rupee', () => {
    for (let p = 0; p < 100; p += 1) {
      const value = Number(`1.${String(p).padStart(2, '0')}`);
      expect(portalAmountToPaise(value), String(value)).toBe(100n + BigInt(p));
    }
  });

  it('treats a missing figure as nothing', () => {
    expect(portalAmountToPaise(null)).toBe(0n);
    expect(portalAmountToPaise(undefined)).toBe(0n);
  });

  it('refuses text it cannot read rather than guessing zero', () => {
    expect(portalAmountToPaise('abc')).toBeNull();
    expect(portalAmountToPaise({})).toBeNull();
    expect(portalAmountToPaise('')).toBeNull();
  });

  it('handles a negative, which a credit note carries', () => {
    expect(portalAmountToPaise(-500.5)).toBe(-500_50n);
  });
});

describe('normalisePortalDate', () => {
  it('reads the portal’s day-first format', () => {
    expect(normalisePortalDate('15-06-2025')).toBe('2025-06-15');
    expect(normalisePortalDate('05/06/2025')).toBe('2025-06-05');
  });

  it('reads an ISO date too', () => {
    expect(normalisePortalDate('2025-06-15')).toBe('2025-06-15');
  });

  it('refuses an impossible date rather than rolling it over', () => {
    expect(normalisePortalDate('31-02-2025')).toBeNull();
    expect(normalisePortalDate('29-02-2025')).toBeNull();
    expect(normalisePortalDate('15-13-2025')).toBeNull();
  });

  it('accepts 29 February in a leap year', () => {
    expect(normalisePortalDate('29-02-2024')).toBe('2024-02-29');
  });

  it('returns null for anything else', () => {
    for (const bad of ['', 'June 2025', '15-06-25', 42, null]) {
      expect(normalisePortalDate(bad as unknown), String(bad)).toBeNull();
    }
  });
});

describe('parseGstr2b', () => {
  const portalJson = {
    data: {
      gstin: '29aabcs1234a1zx',
      rtnprd: '062025',
      docdata: {
        b2b: [
          {
            ctin: '27aaacs9999a1z1',
            trdnm: 'Mumbai Supplies Pvt Ltd',
            inv: [
              {
                inum: 'MS/2025/0441',
                dt: '12-06-2025',
                val: 118000,
                itcavl: 'Y',
                items: [
                  { rt: 18, txval: 100000, iamt: 18000, camt: 0, samt: 0, csamt: 0 },
                ],
              },
              {
                inum: 'MS/2025/0442',
                dt: '20-06-2025',
                val: 5900,
                itcavl: 'N',
                rsn: 'Supplier has not filed GSTR-3B',
                items: [{ rt: 18, txval: 5000, iamt: 900, camt: 0, samt: 0, csamt: 0 }],
              },
            ],
          },
          {
            ctin: '29aaacs8888a1z2',
            trdnm: 'Bengaluru Traders',
            inv: [
              {
                inum: 'BT-77',
                dt: '15-06-2025',
                itcavl: 'Y',
                items: [
                  { rt: 9, txval: 50000, iamt: 0, camt: 4500, samt: 4500, csamt: 0 },
                  { rt: 9, txval: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0 },
                ],
              },
            ],
          },
        ],
      },
    },
  };

  const parsed = parseGstr2b(portalJson);

  it('reads every invoice', () => {
    expect(parsed.invoices).toHaveLength(3);
    expect(parsed.problems).toEqual([]);
  });

  it('reads the period and our own GSTIN, upper-cased', () => {
    expect(parsed.period).toBe('062025');
    expect(parsed.gstin).toBe('29AABCS1234A1ZX');
  });

  it('sums the rate blocks on one invoice', () => {
    const bt = parsed.invoices.find((i) => i.invoiceNo === 'BT-77')!;
    expect(bt.taxablePaise).toBe(60_000_00n);
    expect(bt.tax.cgst).toBe(5_400_00n);
    expect(bt.tax.sgst).toBe(5_400_00n);
  });

  it('carries the portal’s own credit-availability flag and reason', () => {
    const blocked = parsed.invoices.find((i) => i.invoiceNo === 'MS/2025/0442')!;
    expect(blocked.itcAvailable).toBe(false);
    expect(blocked.itcReason).toBe('Supplier has not filed GSTR-3B');

    const fine = parsed.invoices.find((i) => i.invoiceNo === 'MS/2025/0441')!;
    expect(fine.itcAvailable).toBe(true);
  });

  it('upper-cases the supplier GSTIN', () => {
    expect(parsed.invoices[0]?.supplierGstin).toBe('27AAACS9999A1Z1');
  });

  it('reports a record it cannot read rather than dropping it', () => {
    // A silently dropped invoice is a silently lost credit.
    const broken = parseGstr2b({
      data: {
        docdata: {
          b2b: [
            {
              ctin: '27AAACS9999A1Z1',
              inv: [
                { inum: 'GOOD', dt: '01-06-2025', items: [{ txval: 100, iamt: 18 }] },
                { dt: '01-06-2025', items: [] },
                { inum: 'BADDATE', dt: 'not a date', items: [] },
                { inum: 'BADAMOUNT', dt: '01-06-2025', items: [{ txval: 'abc' }] },
              ],
            },
          ],
        },
      },
    });
    expect(broken.invoices.map((i) => i.invoiceNo)).toEqual(['GOOD']);
    expect(broken.problems).toHaveLength(3);
    expect(broken.problems.every((p) => p.path.startsWith('data.docdata.b2b[0].inv['))).toBe(true);
  });

  it('handles figures on the invoice rather than in items', () => {
    const flat = parseGstr2b({
      data: {
        docdata: {
          b2b: [
            {
              ctin: '27AAACS9999A1Z1',
              inv: [{ inum: 'FLAT', dt: '01-06-2025', txval: 1000, iamt: 180 }],
            },
          ],
        },
      },
    });
    expect(flat.invoices[0]?.taxablePaise).toBe(1_000_00n);
    expect(flat.invoices[0]?.tax.igst).toBe(180_00n);
  });

  it('refuses a file with no B2B section, naming what it should be', () => {
    expect(() => parseGstr2b({ data: { docdata: {} } })).toThrow(UnreadableGstr2bError);
    expect(() => parseGstr2b({ data: { docdata: {} } })).toThrow(/downloaded from the portal/);
  });

  it('refuses something that is not an object at all', () => {
    expect(() => parseGstr2b('a string')).toThrow(UnreadableGstr2bError);
    expect(() => parseGstr2b([1, 2, 3])).toThrow(UnreadableGstr2bError);
  });
});

describe('reconKey', () => {
  it('ignores punctuation and case, as people type invoice numbers both ways', () => {
    expect(reconKey('29AAA', 'MS/2025/0441')).toBe(reconKey('29aaa', 'ms-2025-0441'));
  });

  it('keeps different invoices apart', () => {
    expect(reconKey('29AAA', 'INV1')).not.toBe(reconKey('29AAA', 'INV2'));
    expect(reconKey('29AAA', 'INV1')).not.toBe(reconKey('27BBB', 'INV1'));
  });
});

describe('reconcileGstr2b', () => {
  const portal = (over: Partial<Gstr2bInvoice> = {}): Gstr2bInvoice => ({
    supplierGstin: '27AAACS9999A1Z1',
    supplierName: 'Mumbai Supplies',
    invoiceNo: 'MS/2025/0441',
    invoiceDate: '2025-06-12',
    taxablePaise: 1_00_000_00n,
    tax: tax({ igst: 18_000_00n }),
    itcAvailable: true,
    itcReason: null,
    ...over,
  });

  const book = (over: Partial<BookPurchase> = {}): BookPurchase => ({
    voucherId: 'b1',
    voucherNo: 'BILL/25-26/0001',
    supplierGstin: '27AAACS9999A1Z1',
    supplierName: 'Mumbai Supplies',
    supplierInvoiceNo: 'MS/2025/0441',
    supplierInvoiceDate: '2025-06-12',
    taxablePaise: 1_00_000_00n,
    tax: tax({ igst: 18_000_00n }),
    ...over,
  });

  it('matches an invoice both sides agree on', () => {
    const result = reconcileGstr2b({
      period: '062025',
      portalInvoices: [portal()],
      bookPurchases: [book()],
    });
    expect(result.counts.matched).toBe(1);
    expect(result.creditAtRiskPaise).toBe(0n);
    expect(result.creditUnclaimedPaise).toBe(0n);
  });

  it('matches across differently punctuated invoice numbers', () => {
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [portal({ invoiceNo: 'MS/2025/0441' })],
      bookPurchases: [book({ supplierInvoiceNo: 'ms-2025-0441' })],
    });
    expect(result.counts.matched).toBe(1);
  });

  it('flags credit claimed that the supplier has not filed, and prices it', () => {
    // The expensive case: this is credit already taken that may have to go back.
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [],
      bookPurchases: [book()],
    });
    expect(result.counts.in_books_not_in_2b).toBe(1);
    expect(result.creditAtRiskPaise).toBe(18_000_00n);
    expect(result.rows[0]?.consequence).toMatch(/may have to be reversed/);
  });

  it('flags credit the supplier filed that the books have not claimed', () => {
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [portal()],
      bookPurchases: [],
    });
    expect(result.counts.in_2b_not_in_books).toBe(1);
    expect(result.creditUnclaimedPaise).toBe(18_000_00n);
    expect(result.rows[0]?.consequence).toMatch(/entitled to and have not taken/);
  });

  it('does not count credit the portal says is unavailable as unclaimed', () => {
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [portal({ itcAvailable: false, itcReason: 'Supplier has not filed GSTR-3B' })],
      bookPurchases: [],
    });
    expect(result.creditUnclaimedPaise).toBe(0n);
    expect(result.rows[0]?.consequence).toMatch(/nothing to claim/);
  });

  it('reports a figure mismatch with the difference by head', () => {
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [portal({ tax: tax({ igst: 18_000_00n }) })],
      bookPurchases: [book({ tax: tax({ igst: 19_000_00n }) })],
    });
    expect(result.counts.mismatched).toBe(1);
    expect(result.rows[0]?.taxDifference?.igst).toBe(-1_000_00n);
    // Books claim more than was filed, so the excess is at risk.
    expect(result.creditAtRiskPaise).toBe(1_000_00n);
  });

  it('treats a difference in taxable value as a mismatch even when the tax agrees', () => {
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [portal({ taxablePaise: 1_00_000_00n })],
      bookPurchases: [book({ taxablePaise: 99_000_00n })],
    });
    expect(result.counts.mismatched).toBe(1);
  });

  it('treats a one-paisa difference as a mismatch, since the portal will', () => {
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [portal({ tax: tax({ igst: 18_000_00n }) })],
      bookPurchases: [book({ tax: tax({ igst: 18_000_01n }) })],
    });
    expect(result.counts.mismatched).toBe(1);
  });

  it('puts the expensive differences first', () => {
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [
        portal({ invoiceNo: 'MATCHED' }),
        portal({ invoiceNo: 'ONLY_PORTAL' }),
      ],
      bookPurchases: [
        book({ supplierInvoiceNo: 'MATCHED' }),
        book({ voucherId: 'b2', voucherNo: 'BILL/2', supplierInvoiceNo: 'ONLY_BOOKS' }),
      ],
    });
    expect(result.rows[0]?.status).toBe('in_books_not_in_2b');
    expect(result.rows.at(-1)?.status).toBe('matched');
  });

  it('ignores a book purchase with no supplier invoice number', () => {
    // Without one there is nothing to match on, and inventing a match would be
    // worse than reporting none.
    const result = reconcileGstr2b({
      period: null,
      portalInvoices: [],
      bookPurchases: [book({ supplierInvoiceNo: null })],
    });
    expect(result.rows).toEqual([]);
  });

  it('is empty for an empty period', () => {
    const result = reconcileGstr2b({ period: null, portalInvoices: [], bookPurchases: [] });
    expect(result.rows).toEqual([]);
    expect(result.creditAtRiskPaise).toBe(0n);
  });

  it('always says it needs CA verification', () => {
    expect(
      reconcileGstr2b({ period: null, portalInvoices: [], bookPurchases: [] }).needsCaVerification,
    ).toBe(true);
  });
});
