/**
 * Turns a calculated voucher into the ledger entries that record it.
 *
 * Pure, and deliberately separate from the GST engine: `gst.ts` decides how
 * much tax there is, this module decides which accounts that tax lands in. Both
 * stay out of the database, so a posting can be asserted in a unit test without
 * a transaction.
 *
 * Every function here returns entries that balance. `assertBalanced` is applied
 * before the entries are returned, so a caller cannot receive an unbalanced set
 * and discover it later at COMMIT — the database trigger is the backstop, not
 * the first line of defence.
 */
import type { GstInvoiceResult } from './gst';

/** An account referenced by its stable code, resolved to an id when written. */
export interface PostingEntry {
  accountCode: string;
  debitPaise: bigint;
  creditPaise: bigint;
  /** Set on the party's own control account, so a ledger can be filtered. */
  withParty?: boolean;
  narration?: string;
}

export class UnbalancedPostingError extends Error {
  constructor(
    readonly debitPaise: bigint,
    readonly creditPaise: bigint,
  ) {
    super(
      `Posting does not balance: debits ${debitPaise} paise, credits ${creditPaise} paise ` +
        `(difference ${debitPaise - creditPaise})`,
    );
    this.name = 'UnbalancedPostingError';
  }
}

export function totals(entries: readonly PostingEntry[]): {
  debitPaise: bigint;
  creditPaise: bigint;
} {
  let debitPaise = 0n;
  let creditPaise = 0n;
  for (const e of entries) {
    debitPaise += e.debitPaise;
    creditPaise += e.creditPaise;
  }
  return { debitPaise, creditPaise };
}

export function assertBalanced(entries: readonly PostingEntry[]): readonly PostingEntry[] {
  const { debitPaise, creditPaise } = totals(entries);
  if (debitPaise !== creditPaise) throw new UnbalancedPostingError(debitPaise, creditPaise);
  for (const e of entries) {
    if (e.debitPaise < 0n || e.creditPaise < 0n) {
      throw new RangeError(`Negative amount on ${e.accountCode}: use the other side instead`);
    }
    if (e.debitPaise > 0n && e.creditPaise > 0n) {
      throw new RangeError(`${e.accountCode} has both a debit and a credit on one entry`);
    }
  }
  return entries;
}

/** Places a signed amount on whichever side its sign calls for. */
function signed(accountCode: string, amountPaise: bigint, narration?: string): PostingEntry[] {
  if (amountPaise === 0n) return [];
  return [
    amountPaise > 0n
      ? { accountCode, debitPaise: amountPaise, creditPaise: 0n, ...(narration ? { narration } : {}) }
      : { accountCode, debitPaise: 0n, creditPaise: -amountPaise, ...(narration ? { narration } : {}) },
  ];
}

const OUTPUT_TAX_ACCOUNTS = {
  cgstPaise: 'OUTPUT_CGST',
  sgstPaise: 'OUTPUT_SGST',
  igstPaise: 'OUTPUT_IGST',
  cessPaise: 'OUTPUT_CESS',
} as const;

const INPUT_TAX_ACCOUNTS = {
  cgstPaise: 'INPUT_CGST',
  sgstPaise: 'INPUT_SGST',
  igstPaise: 'INPUT_IGST',
  cessPaise: 'INPUT_CESS',
} as const;

/**
 * A sales invoice.
 *
 *   Dr Sundry Debtors      the whole amount the customer owes
 *     Cr Sales             the taxable value
 *     Cr Output CGST/SGST/IGST/Cess  the tax, which is the government's money
 *     Cr/Dr Round Off      the difference from rounding to the nearest rupee
 *
 * Round Off takes either side. Rounding up means the customer owes a few paise
 * more than the arithmetic, which is a gain and so a credit; rounding down is a
 * debit. It nets to a few rupees a year and must still be recorded, or the
 * trial balance will not tie.
 */
export function salesInvoiceEntries(invoice: GstInvoiceResult): readonly PostingEntry[] {
  const entries: PostingEntry[] = [
    {
      accountCode: 'SUNDRY_DEBTORS',
      debitPaise: invoice.totalPaise,
      creditPaise: 0n,
      withParty: true,
    },
    { accountCode: 'SALES', debitPaise: 0n, creditPaise: invoice.taxablePaise },
  ];

  for (const [field, accountCode] of Object.entries(OUTPUT_TAX_ACCOUNTS)) {
    const amount = invoice[field as keyof typeof OUTPUT_TAX_ACCOUNTS];
    if (amount > 0n) entries.push({ accountCode, debitPaise: 0n, creditPaise: amount });
  }

  // A positive round-off increased what the customer pays, so it is a credit.
  entries.push(...signed('ROUND_OFF', -invoice.roundOffPaise, 'Rounded to the nearest rupee'));

  return assertBalanced(entries);
}

/**
 * A purchase bill. The mirror of a sales invoice, except that input tax is an
 * asset — a claim against output tax — rather than a liability.
 *
 *   Dr Purchases                   the taxable value
 *   Dr Input CGST/SGST/IGST/Cess   input tax credit
 *     Cr Sundry Creditors          what we owe the supplier
 *     Cr/Dr Round Off
 *
 * Reverse charge is the one case where the supplier charges no tax but we still
 * owe it: `gst.ts` returns zero tax on such a line, and the liability is raised
 * by a separate journal rather than here, so this function never invents a
 * number the invoice does not show.
 */
export function purchaseBillEntries(bill: GstInvoiceResult): readonly PostingEntry[] {
  const entries: PostingEntry[] = [
    { accountCode: 'PURCHASES', debitPaise: bill.taxablePaise, creditPaise: 0n },
  ];

  for (const [field, accountCode] of Object.entries(INPUT_TAX_ACCOUNTS)) {
    const amount = bill[field as keyof typeof INPUT_TAX_ACCOUNTS];
    if (amount > 0n) entries.push({ accountCode, debitPaise: amount, creditPaise: 0n });
  }

  entries.push({
    accountCode: 'SUNDRY_CREDITORS',
    debitPaise: 0n,
    creditPaise: bill.totalPaise,
    withParty: true,
  });
  entries.push(...signed('ROUND_OFF', bill.roundOffPaise, 'Rounded to the nearest rupee'));

  return assertBalanced(entries);
}

/**
 * A receipt against a customer.
 *
 *   Dr Bank or Cash    what arrived
 *     Cr Sundry Debtors  clearing what the customer owed
 *
 * A discount allowed on settlement is a third leg, so the entries still balance
 * when the customer pays less than the invoice by agreement.
 */
export function receiptEntries(input: {
  amountPaise: bigint;
  intoAccountCode: string;
  discountAllowedPaise?: bigint;
}): readonly PostingEntry[] {
  const discount = input.discountAllowedPaise ?? 0n;
  if (input.amountPaise <= 0n) throw new RangeError('A receipt must be for a positive amount');
  if (discount < 0n) throw new RangeError('A discount allowed cannot be negative');

  const entries: PostingEntry[] = [
    { accountCode: input.intoAccountCode, debitPaise: input.amountPaise, creditPaise: 0n },
  ];
  if (discount > 0n) {
    entries.push({ accountCode: 'DISCOUNT_ALLOWED', debitPaise: discount, creditPaise: 0n });
  }
  entries.push({
    accountCode: 'SUNDRY_DEBTORS',
    debitPaise: 0n,
    creditPaise: input.amountPaise + discount,
    withParty: true,
  });

  return assertBalanced(entries);
}

/**
 * A payment to a supplier: the mirror of a receipt.
 */
export function paymentEntries(input: {
  amountPaise: bigint;
  fromAccountCode: string;
  discountReceivedPaise?: bigint;
}): readonly PostingEntry[] {
  const discount = input.discountReceivedPaise ?? 0n;
  if (input.amountPaise <= 0n) throw new RangeError('A payment must be for a positive amount');
  if (discount < 0n) throw new RangeError('A discount received cannot be negative');

  const entries: PostingEntry[] = [
    {
      accountCode: 'SUNDRY_CREDITORS',
      debitPaise: input.amountPaise + discount,
      creditPaise: 0n,
      withParty: true,
    },
    { accountCode: input.fromAccountCode, debitPaise: 0n, creditPaise: input.amountPaise },
  ];
  if (discount > 0n) {
    entries.push({ accountCode: 'DISCOUNT_RECEIVED', debitPaise: 0n, creditPaise: discount });
  }

  return assertBalanced(entries);
}

/**
 * Reverses a posted voucher by swapping every side.
 *
 * This is the only sanctioned correction. A posted voucher cannot be edited, so
 * an error becomes a reversal plus a fresh, correct voucher — which leaves both
 * the mistake and the fix visible in the audit trail, as the Companies Act
 * audit-trail requirement expects.
 */
export function reverseEntries(entries: readonly PostingEntry[]): readonly PostingEntry[] {
  return assertBalanced(
    entries.map((e) => ({
      ...e,
      debitPaise: e.creditPaise,
      creditPaise: e.debitPaise,
    })),
  );
}
