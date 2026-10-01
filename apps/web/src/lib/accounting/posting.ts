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

/**
 * A credit note against a customer: a sales return, or an agreed reduction.
 *
 *   Dr Sales Returns                 the taxable value coming back
 *   Dr Output CGST/SGST/IGST/Cess    reversing the liability we had raised
 *     Cr Sundry Debtors              reducing what the customer owes
 *     Cr/Dr Round Off
 *
 * The tax goes to the same Output accounts as the invoice did, on the opposite
 * side, rather than to a separate "output tax reversed" ledger: the GSTR-1
 * figure for a period is output tax net of credit notes, and splitting it
 * across two accounts would mean reassembling it at return time.
 */
export function creditNoteEntries(note: GstInvoiceResult): readonly PostingEntry[] {
  const entries: PostingEntry[] = [
    { accountCode: 'SALES_RETURNS', debitPaise: note.taxablePaise, creditPaise: 0n },
  ];

  for (const [field, accountCode] of Object.entries(OUTPUT_TAX_ACCOUNTS)) {
    const amount = note[field as keyof typeof OUTPUT_TAX_ACCOUNTS];
    if (amount > 0n) entries.push({ accountCode, debitPaise: amount, creditPaise: 0n });
  }

  entries.push({
    accountCode: 'SUNDRY_DEBTORS',
    debitPaise: 0n,
    creditPaise: note.totalPaise,
    withParty: true,
  });
  entries.push(...signed('ROUND_OFF', note.roundOffPaise, 'Rounded to the nearest rupee'));

  return assertBalanced(entries);
}

/**
 * A debit note to a supplier: a purchase return, or a short-supply claim.
 *
 *   Dr Sundry Creditors              reducing what we owe
 *     Cr Purchase Returns            the taxable value going back
 *     Cr Input CGST/SGST/IGST/Cess   giving up the credit we had claimed
 *     Cr/Dr Round Off
 */
export function debitNoteEntries(note: GstInvoiceResult): readonly PostingEntry[] {
  const entries: PostingEntry[] = [
    {
      accountCode: 'SUNDRY_CREDITORS',
      debitPaise: note.totalPaise,
      creditPaise: 0n,
      withParty: true,
    },
    { accountCode: 'PURCHASE_RETURNS', debitPaise: 0n, creditPaise: note.taxablePaise },
  ];

  for (const [field, accountCode] of Object.entries(INPUT_TAX_ACCOUNTS)) {
    const amount = note[field as keyof typeof INPUT_TAX_ACCOUNTS];
    if (amount > 0n) entries.push({ accountCode, debitPaise: 0n, creditPaise: amount });
  }

  entries.push(...signed('ROUND_OFF', -note.roundOffPaise, 'Rounded to the nearest rupee'));

  return assertBalanced(entries);
}

export interface JournalLineInput {
  accountCode: string;
  debitPaise: bigint;
  creditPaise: bigint;
  narration?: string;
}

/**
 * A journal: free-form lines, whatever accounts the entry needs.
 *
 * This is the one voucher where the accounts are not decided by the engine, so
 * it is the one that most needs the balance check — and it gets exactly the same
 * one. Two lines minimum, because a single-sided journal is not an entry; a
 * blank line is dropped rather than refused, since a form with spare rows is
 * normal.
 */
export function journalEntries(lines: readonly JournalLineInput[]): readonly PostingEntry[] {
  const used = lines.filter((l) => l.debitPaise !== 0n || l.creditPaise !== 0n);
  if (used.length < 2) {
    throw new RangeError('A journal needs at least two lines: something debited and something credited');
  }
  return assertBalanced(
    used.map((l) => ({
      accountCode: l.accountCode,
      debitPaise: l.debitPaise,
      creditPaise: l.creditPaise,
      ...(l.narration ? { narration: l.narration } : {}),
    })),
  );
}

/**
 * A contra: money moved between the company's own cash and bank accounts.
 *
 * Separate from a journal because it is the entry most often made and most
 * often made wrong, and because restricting both sides to cash and bank
 * accounts is the whole safeguard. A contra that touched a revenue account
 * would be a disguised sale.
 */
export function contraEntries(input: {
  fromAccountCode: string;
  toAccountCode: string;
  amountPaise: bigint;
}): readonly PostingEntry[] {
  if (input.amountPaise <= 0n) throw new RangeError('A contra must move a positive amount');
  if (input.fromAccountCode === input.toAccountCode) {
    throw new RangeError('A contra must move between two different accounts');
  }
  return assertBalanced([
    { accountCode: input.toAccountCode, debitPaise: input.amountPaise, creditPaise: 0n },
    { accountCode: input.fromAccountCode, debitPaise: 0n, creditPaise: input.amountPaise },
  ]);
}

/**
 * The liability a reverse-charge purchase creates.
 *
 * On a reverse-charge supply the supplier charges no tax, so `gst.ts` returns
 * zero on the line and the bill's own entries carry none. The recipient still
 * owes the tax and may still claim it, which is two postings of the same
 * amount:
 *
 *   Dr Input CGST/SGST/IGST    the credit we may claim
 *     Cr Output CGST/SGST/IGST the tax we owe the government
 *
 * It is raised as its own voucher rather than folded into the bill, because the
 * bill must show what the supplier's document shows. Nothing here invents an
 * amount: the caller passes the tax computed by the engine from the bill's own
 * taxable value and rate.
 */
export function reverseChargeLiabilityEntries(input: {
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
}): readonly PostingEntry[] {
  const entries: PostingEntry[] = [];
  for (const [head, amount] of [
    ['CGST', input.cgstPaise],
    ['SGST', input.sgstPaise],
    ['IGST', input.igstPaise],
  ] as const) {
    if (amount === 0n) continue;
    entries.push({ accountCode: `INPUT_${head}`, debitPaise: amount, creditPaise: 0n });
    entries.push({ accountCode: `OUTPUT_${head}`, debitPaise: 0n, creditPaise: amount });
  }
  if (entries.length === 0) {
    throw new RangeError('A reverse-charge liability of zero is not an entry');
  }
  return assertBalanced(entries);
}
