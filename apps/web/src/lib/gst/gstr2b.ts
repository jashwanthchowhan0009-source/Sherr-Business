/**
 * GSTR-2B: what suppliers say they sold us, reconciled against what we recorded.
 *
 * GSTR-2B is the government's own statement of the invoices our suppliers have
 * filed against our GSTIN. Input tax credit may only be claimed on what appears
 * there, so the difference between it and our purchase register is the difference
 * between the credit we have claimed and the credit we are entitled to.
 *
 * Three kinds of difference matter, and each means something different:
 *
 *   in_2b_not_in_books   The supplier filed it and we never recorded it. Credit
 *                        we are entitled to and have not taken.
 *   in_books_not_in_2b   We recorded it and the supplier has not filed it. Credit
 *                        we have taken and may have to reverse — the expensive
 *                        one, and the reason this report exists.
 *   mismatched           Both have it, with different figures. One of us is wrong.
 *
 * The parser accepts the JSON the portal downloads. Nothing is guessed: a record
 * it cannot read is reported with its position rather than skipped, because a
 * silently dropped invoice is a silently lost credit.
 */
import { PAISE_PER_RUPEE } from '@/lib/accounting/units';
import { addTax, zeroTax, type TaxAmounts } from './set-off';

export interface Gstr2bInvoice {
  supplierGstin: string;
  supplierName: string | null;
  invoiceNo: string;
  invoiceDate: string;
  taxablePaise: bigint;
  tax: TaxAmounts;
  /** The portal's own flag for whether the credit is available. */
  itcAvailable: boolean;
  /** The portal's reason where it is not. */
  itcReason: string | null;
}

export interface Gstr2bParseProblem {
  path: string;
  reason: string;
}

export interface ParsedGstr2b {
  /** The return period the file is for, as the portal states it. */
  period: string | null;
  gstin: string | null;
  invoices: Gstr2bInvoice[];
  problems: Gstr2bParseProblem[];
}

export class UnreadableGstr2bError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableGstr2bError';
  }
}

/**
 * Reads a rupee figure from the portal's JSON into integer paise.
 *
 * The portal emits numbers, so this is the one place a float legitimately
 * arrives from outside. It is converted through its decimal string rather than
 * by multiplication: `18000.07 * 100` is 1800006.9999999998, and truncating that
 * loses a paisa on a figure that has to match the portal exactly.
 */
export function portalAmountToPaise(value: unknown): bigint | null {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value * PAISE_PER_RUPEE;

  const text =
    typeof value === 'number'
      ? // toFixed(2) rounds half-away-from-zero on the decimal representation,
        // which is what the portal's own figures already are.
        value.toFixed(2)
      : typeof value === 'string'
        ? value.trim()
        : null;
  if (text === null || text === '') return null;

  const match = /^-?\d+(\.\d{1,2})?$/.exec(text);
  if (!match) return null;

  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  const paise = BigInt(whole) * PAISE_PER_RUPEE + BigInt(frac.padEnd(2, '0'));
  return negative ? -paise : paise;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Parses the GSTR-2B JSON the portal downloads.
 *
 * The shape is `{ data: { docdata: { b2b: [ { ctin, supfilingdt, inv: [...] } ] } } }`,
 * with each invoice carrying `inum`, `dt`, `val`, and an `items` array of rate
 * blocks holding `txval`, `iamt`, `camt`, `samt`, `csamt`.
 *
 * Both the nested and the flattened variants the portal has emitted are handled,
 * and anything unrecognised becomes a problem naming its path.
 */
export function parseGstr2b(json: unknown): ParsedGstr2b {
  const root = asRecord(json);
  if (!root) throw new UnreadableGstr2bError('That file is not a JSON object.');

  const data = asRecord(root.data) ?? root;
  const docdata = asRecord(data.docdata) ?? data;
  const b2b = asArray(docdata.b2b);

  if (b2b.length === 0) {
    throw new UnreadableGstr2bError(
      'No B2B section found. This should be the GSTR-2B JSON downloaded from the portal, not a ' +
        'spreadsheet export or a GSTR-2A file.',
    );
  }

  const invoices: Gstr2bInvoice[] = [];
  const problems: Gstr2bParseProblem[] = [];

  for (const [supplierIndex, supplierRaw] of b2b.entries()) {
    const supplier = asRecord(supplierRaw);
    const supplierPath = `data.docdata.b2b[${supplierIndex}]`;
    if (!supplier) {
      problems.push({ path: supplierPath, reason: 'Not an object.' });
      continue;
    }

    const supplierGstin = typeof supplier.ctin === 'string' ? supplier.ctin.toUpperCase() : null;
    if (!supplierGstin) {
      problems.push({ path: `${supplierPath}.ctin`, reason: 'No supplier GSTIN.' });
      continue;
    }
    const supplierName = typeof supplier.trdnm === 'string' ? supplier.trdnm : null;

    for (const [invoiceIndex, invoiceRaw] of asArray(supplier.inv).entries()) {
      const invoice = asRecord(invoiceRaw);
      const path = `${supplierPath}.inv[${invoiceIndex}]`;
      if (!invoice) {
        problems.push({ path, reason: 'Not an object.' });
        continue;
      }

      const invoiceNo = typeof invoice.inum === 'string' ? invoice.inum : null;
      if (!invoiceNo) {
        problems.push({ path: `${path}.inum`, reason: 'No invoice number.' });
        continue;
      }

      const invoiceDate = normalisePortalDate(invoice.dt);
      if (!invoiceDate) {
        problems.push({
          path: `${path}.dt`,
          reason: `Could not read the invoice date ${JSON.stringify(invoice.dt)}.`,
        });
        continue;
      }

      let taxablePaise = 0n;
      let tax = zeroTax();
      let amountsReadable = true;

      const items = asArray(invoice.items);
      // Some exports put the figures on the invoice itself rather than in items.
      const blocks = items.length > 0 ? items : [invoice];

      for (const [itemIndex, itemRaw] of blocks.entries()) {
        const item = asRecord(itemRaw);
        if (!item) {
          problems.push({ path: `${path}.items[${itemIndex}]`, reason: 'Not an object.' });
          amountsReadable = false;
          break;
        }
        const txval = portalAmountToPaise(item.txval);
        const iamt = portalAmountToPaise(item.iamt);
        const camt = portalAmountToPaise(item.camt);
        const samt = portalAmountToPaise(item.samt);
        const csamt = portalAmountToPaise(item.csamt);

        if (txval === null || iamt === null || camt === null || samt === null || csamt === null) {
          problems.push({
            path: `${path}.items[${itemIndex}]`,
            reason: 'An amount on this line could not be read.',
          });
          amountsReadable = false;
          break;
        }

        taxablePaise += txval;
        tax = addTax(tax, { igst: iamt, cgst: camt, sgst: samt, cess: csamt });
      }

      if (!amountsReadable) continue;

      // The portal marks credit as unavailable with 'N'; anything else is taken
      // as available, which is the portal's own default.
      const itcAvailable = invoice.itcavl !== 'N';

      invoices.push({
        supplierGstin,
        supplierName,
        invoiceNo,
        invoiceDate,
        taxablePaise,
        tax,
        itcAvailable,
        itcReason: typeof invoice.rsn === 'string' ? invoice.rsn : null,
      });
    }
  }

  return {
    period: typeof data.rtnprd === 'string' ? data.rtnprd : null,
    gstin: typeof data.gstin === 'string' ? data.gstin.toUpperCase() : null,
    invoices,
    problems,
  };
}

/**
 * The portal writes dates as `DD-MM-YYYY`. Day-first, as everywhere else in this
 * product, and an impossible date is refused rather than rolled over.
 */
export function normalisePortalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return check(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
  if (dmy) return check(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  return null;
}

function check(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  const daysIn =
    month === 2
      ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (day < 1 || day > daysIn) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

// ── reconciliation ──────────────────────────────────────────────────────────

export interface BookPurchase {
  voucherId: string;
  voucherNo: string;
  supplierGstin: string | null;
  supplierName: string | null;
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  taxablePaise: bigint;
  tax: TaxAmounts;
}

export type ReconStatus = 'matched' | 'mismatched' | 'in_2b_not_in_books' | 'in_books_not_in_2b';

export const RECON_STATUS_LABELS: Record<ReconStatus, string> = {
  matched: 'Matched',
  mismatched: 'Figures differ',
  in_2b_not_in_books: 'Filed by the supplier, not in your books',
  in_books_not_in_2b: 'In your books, not filed by the supplier',
};

export interface ReconRow {
  status: ReconStatus;
  supplierGstin: string | null;
  supplierName: string | null;
  invoiceNo: string;
  invoiceDate: string | null;
  /** From GSTR-2B, where present. */
  portalTaxablePaise: bigint | null;
  portalTax: TaxAmounts | null;
  /** From the books, where present. */
  bookTaxablePaise: bigint | null;
  bookTax: TaxAmounts | null;
  bookVoucherNo: string | null;
  /** Portal tax less book tax, by head. Zero on a match. */
  taxDifference: TaxAmounts | null;
  /** The portal's own note where it says the credit is not available. */
  itcAvailable: boolean | null;
  itcReason: string | null;
  /** What this difference means for the credit claimed. */
  consequence: string;
}

export interface Gstr2bReconciliation {
  period: string | null;
  rows: ReconRow[];
  /** Credit the books have claimed that GSTR-2B does not support. */
  creditAtRiskPaise: bigint;
  /** Credit GSTR-2B offers that the books have not claimed. */
  creditUnclaimedPaise: bigint;
  counts: Record<ReconStatus, number>;
  needsCaVerification: true;
}

/** A comparison key tolerant of how differently the same number gets typed. */
export function reconKey(gstin: string | null, invoiceNo: string): string {
  return `${(gstin ?? '').toUpperCase()}|${invoiceNo.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

const taxTotal = (t: TaxAmounts) => t.igst + t.cgst + t.sgst + t.cess;

/**
 * Reconciles GSTR-2B against the purchase register.
 *
 * Matched on the supplier's GSTIN and invoice number, normalised, because the
 * same invoice number is routinely typed with and without its slashes. The
 * amounts are then compared exactly: a difference of a rupee is a difference the
 * portal will see, so nothing is treated as near enough.
 */
export function reconcileGstr2b(input: {
  period: string | null;
  portalInvoices: readonly Gstr2bInvoice[];
  bookPurchases: readonly BookPurchase[];
}): Gstr2bReconciliation {
  const books = new Map<string, BookPurchase>();
  for (const purchase of input.bookPurchases) {
    if (!purchase.supplierInvoiceNo) continue;
    books.set(reconKey(purchase.supplierGstin, purchase.supplierInvoiceNo), purchase);
  }

  const rows: ReconRow[] = [];
  const seen = new Set<string>();

  for (const portal of input.portalInvoices) {
    const key = reconKey(portal.supplierGstin, portal.invoiceNo);
    seen.add(key);
    const book = books.get(key);

    if (!book) {
      rows.push({
        status: 'in_2b_not_in_books',
        supplierGstin: portal.supplierGstin,
        supplierName: portal.supplierName,
        invoiceNo: portal.invoiceNo,
        invoiceDate: portal.invoiceDate,
        portalTaxablePaise: portal.taxablePaise,
        portalTax: portal.tax,
        bookTaxablePaise: null,
        bookTax: null,
        bookVoucherNo: null,
        taxDifference: null,
        itcAvailable: portal.itcAvailable,
        itcReason: portal.itcReason,
        consequence: portal.itcAvailable
          ? 'Credit you are entitled to and have not taken. Enter the bill to claim it.'
          : 'The portal says credit is not available on this invoice, so there is nothing to claim.',
      });
      continue;
    }

    const difference: TaxAmounts = {
      igst: portal.tax.igst - book.tax.igst,
      cgst: portal.tax.cgst - book.tax.cgst,
      sgst: portal.tax.sgst - book.tax.sgst,
      cess: portal.tax.cess - book.tax.cess,
    };
    const matched =
      taxTotal(difference) === 0n &&
      difference.igst === 0n &&
      difference.cgst === 0n &&
      difference.sgst === 0n &&
      difference.cess === 0n &&
      portal.taxablePaise === book.taxablePaise;

    rows.push({
      status: matched ? 'matched' : 'mismatched',
      supplierGstin: portal.supplierGstin,
      supplierName: portal.supplierName ?? book.supplierName,
      invoiceNo: portal.invoiceNo,
      invoiceDate: portal.invoiceDate,
      portalTaxablePaise: portal.taxablePaise,
      portalTax: portal.tax,
      bookTaxablePaise: book.taxablePaise,
      bookTax: book.tax,
      bookVoucherNo: book.voucherNo,
      taxDifference: difference,
      itcAvailable: portal.itcAvailable,
      itcReason: portal.itcReason,
      consequence: matched
        ? 'The books and the portal agree.'
        : taxTotal(difference) < 0n
          ? 'Your books claim more credit than the supplier filed. The excess may have to be reversed.'
          : 'The supplier filed more than your books record. Check the bill was entered in full.',
    });
  }

  for (const purchase of input.bookPurchases) {
    if (!purchase.supplierInvoiceNo) continue;
    const key = reconKey(purchase.supplierGstin, purchase.supplierInvoiceNo);
    if (seen.has(key)) continue;

    rows.push({
      status: 'in_books_not_in_2b',
      supplierGstin: purchase.supplierGstin,
      supplierName: purchase.supplierName,
      invoiceNo: purchase.supplierInvoiceNo,
      invoiceDate: purchase.supplierInvoiceDate,
      portalTaxablePaise: null,
      portalTax: null,
      bookTaxablePaise: purchase.taxablePaise,
      bookTax: purchase.tax,
      bookVoucherNo: purchase.voucherNo,
      taxDifference: null,
      itcAvailable: null,
      itcReason: null,
      consequence:
        'You have claimed this credit and the supplier has not filed it. Chase the supplier, ' +
        'or the credit may have to be reversed.',
    });
  }

  let creditAtRiskPaise = 0n;
  let creditUnclaimedPaise = 0n;
  const counts: Record<ReconStatus, number> = {
    matched: 0,
    mismatched: 0,
    in_2b_not_in_books: 0,
    in_books_not_in_2b: 0,
  };

  for (const row of rows) {
    counts[row.status] += 1;
    if (row.status === 'in_books_not_in_2b' && row.bookTax) {
      creditAtRiskPaise += taxTotal(row.bookTax);
    }
    if (row.status === 'in_2b_not_in_books' && row.portalTax && row.itcAvailable) {
      creditUnclaimedPaise += taxTotal(row.portalTax);
    }
    if (row.status === 'mismatched' && row.taxDifference) {
      const excess = -taxTotal(row.taxDifference);
      if (excess > 0n) creditAtRiskPaise += excess;
      else creditUnclaimedPaise += -excess;
    }
  }

  // Unmatched first, and the expensive kind first of all: credit already claimed
  // that the portal does not support is what costs money.
  const ORDER: ReconStatus[] = ['in_books_not_in_2b', 'mismatched', 'in_2b_not_in_books', 'matched'];
  rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  return {
    period: input.period,
    rows,
    creditAtRiskPaise,
    creditUnclaimedPaise,
    counts,
    needsCaVerification: true,
  };
}
