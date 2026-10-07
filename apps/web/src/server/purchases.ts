'use server';

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction, type ActionContext } from '@/lib/auth/action';
import { accounts, organizations, parties, vouchers } from '@/lib/db/schema';
import {
  allocatePayment,
  allocateSettlement,
  allocateVoucherNumber,
  createVoucher,
  postVoucher as postVoucherRow,
} from '@/lib/db/ledger';
import { calculateInvoice, determineSupplyType } from '@/lib/accounting/gst';
import {
  contraEntries,
  creditNoteEntries,
  debitNoteEntries,
  journalEntries,
  paymentEntries,
} from '@/lib/accounting/posting';
import { fyLabelFor } from '@/lib/accounting/fiscal-year';
import { parseQuantity, parseRupees } from '@/lib/accounting/units';
import { invalidInput, notFound } from '@/lib/errors';
import { enterPurchaseBill } from '@/lib/db/purchase-bill';
import { reversePostedVoucher, runCorrection, type CorrectionOpts } from '@/lib/db/corrections';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
const stateCode = z.string().trim().regex(/^[0-9]{2}$/, 'State code is two digits');
const optional = (schema: z.ZodString) => schema.optional().or(z.literal(''));

/** A GST rate that must actually be chosen: an empty field is refused, never read as 0. */
const rateBps = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce
    .number({ error: 'Choose a GST rate' })
    .int()
    .min(0)
    .max(100_000),
);

const taxLineSchema = z.object({
  itemId: z.string().uuid().optional().or(z.literal('')),
  description: z.string().trim().min(1, 'Describe the line').max(300),
  hsnSac: optional(z.string().trim()),
  unit: optional(z.string().trim().max(12)),
  quantity: z.string().trim().default('1'),
  unitPriceRupees: z.string().trim(),
  discountRupees: z.string().trim().default('0'),
  gstRateBps: rateBps,
  cessRateBps: z.coerce.number().int().min(0).max(100_000).default(0),
  reverseCharge: z.coerce.boolean().default(false),
});

/**
 * Resolves the company's own state, which decides every supply's treatment.
 *
 * The return type states that the state code is present, so every caller gets
 * it as a string rather than re-checking a nullable field that this function has
 * already refused to return empty.
 */
async function companyContext(
  tx: Parameters<typeof allocateVoucherNumber>[0],
  orgId: string,
): Promise<{ stateCode: string; fyStartMonth: number }> {
  const [company] = await tx
    .select({ stateCode: organizations.stateCode, fyStartMonth: organizations.fyStartMonth })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!company?.stateCode) {
    throw invalidInput(
      'This company has no state on its profile, so GST cannot be worked out. Set it in Data first.',
    );
  }
  return { stateCode: company.stateCode, fyStartMonth: company.fyStartMonth };
}

function mapLines(lines: readonly z.infer<typeof taxLineSchema>[]) {
  return lines.map((line) => ({
    itemId: line.itemId || null,
    description: line.description,
    hsnSac: line.hsnSac || null,
    unit: line.unit || null,
    quantity: parseQuantity(line.quantity),
    unitPricePaise: parseRupees(line.unitPriceRupees),
    discountPaise: parseRupees(line.discountRupees || '0'),
    gstRateBps: line.gstRateBps,
    cessRateBps: line.cessRateBps,
    reverseCharge: line.reverseCharge,
  }));
}

// ─── purchase bill ──────────────────────────────────────────────────────────

const purchaseBillSchema = z.object({
  partyId: z.string().uuid('Choose a supplier'),
  voucherDate: isoDate,
  /** The supplier's own number, from their document. */
  supplierInvoiceNo: z.string().trim().min(1, "Enter the supplier's invoice number").max(60),
  supplierInvoiceDate: isoDate,
  placeOfSupplyStateCode: optional(stateCode),
  narration: optional(z.string().trim().max(500)),
  lines: z.array(taxLineSchema).min(1, 'A bill needs at least one line'),
  post: z.coerce.boolean().default(true),
  /** The order and receipt this bill relates to, for the three-way match. */
  poId: z.string().uuid().optional().or(z.literal('')),
  grnId: z.string().uuid().optional().or(z.literal('')),
});

/**
 * Enters a purchase bill.
 *
 * The duplicate check is the point of this form. The same bill entered twice is
 * the most expensive data-entry error in payables, because it is then paid
 * twice, and it is easy: two people, one forwarded email, no shared view of
 * what has already gone in. The unique index in 0004 is what actually prevents
 * it — including against a concurrent second entry, which a code check would
 * miss — and this handler exists to name the clashing bill rather than surface
 * a constraint name.
 */
async function purchaseBillHandler(
  { tx, input, userId, audit }: ActionContext<z.infer<typeof purchaseBillSchema>>,
  opts: CorrectionOpts = {},
) {
  const post = input.post || opts.mustPost === true;

  // The work itself lives in enterPurchaseBill, because approving a document the
  // AI read reaches the same code. A bill entered by hand and the same bill
  // approved from its PDF must produce the same voucher.
  const created = await enterPurchaseBill(tx, {
    partyId: input.partyId,
    voucherDate: input.voucherDate,
    supplierInvoiceNo: input.supplierInvoiceNo,
    supplierInvoiceDate: input.supplierInvoiceDate,
    placeOfSupplyStateCode: input.placeOfSupplyStateCode || null,
    narration: input.narration || null,
    lines: mapLines(input.lines),
    post: post,
    poId: input.poId || opts.poId || null,
    grnId: input.grnId || opts.grnId || null,
    sourceDocumentId: opts.sourceDocumentId ?? null,
    reuseVoucherNo: opts.reuseVoucherNo ?? null,
    correctsVoucherId: opts.correctsVoucherId ?? null,
    userId,
  });

  await audit({
    action: post ? 'voucher.purchase.posted' : 'voucher.purchase.drafted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      supplierName: created.partyName,
      supplierInvoiceNo: input.supplierInvoiceNo,
      supplyType: created.supplyType,
      taxablePaise: created.taxablePaise.toString(),
      totalPaise: created.totalPaise.toString(),
      reverseChargeVoucherNo: created.reverseChargeVoucherNo,
      status: post ? 'posted' : 'draft',
    },
  });

  revalidatePath('/process');
  revalidatePath('/dashboard');
  return {
    id: created.id,
    voucherNo: created.voucherNo,
    totalPaise: created.totalPaise.toString(),
    posted: post,
    reverseChargeVoucherNo: created.reverseChargeVoucherNo,
  };
}

const createPurchaseBillAction = defineAction({
  name: 'voucher.purchase.created',
  capability: 'voucher:draft',
  input: purchaseBillSchema,
  rateLimit: { limit: 60, windowSeconds: 60 },
  handler: (ctx) => purchaseBillHandler(ctx),
});

// ─── payment ────────────────────────────────────────────────────────────────

const paymentSchema = z.object({
  partyId: z.string().uuid('Choose a supplier'),
  voucherDate: isoDate,
  amountRupees: z.string().trim(),
  fromAccountCode: z.enum(['CASH', 'BANK']).default('BANK'),
  reference: optional(z.string().trim().max(100)),
  narration: optional(z.string().trim().max(500)),
});

async function paymentHandler(
  { tx, orgId, input, userId, audit }: ActionContext<z.infer<typeof paymentSchema>>,
  opts: CorrectionOpts = {},
) {
  const company = await companyContext(tx, orgId);
  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw notFound('That supplier does not exist in this company.');

  const amountPaise = parseRupees(input.amountRupees);
  if (amountPaise <= 0n) throw invalidInput('A payment must be for more than zero.');

  const fyLabel = fyLabelFor(input.voucherDate, company.fyStartMonth);
  const voucherNo =
    opts.reuseVoucherNo ??
    (await allocateVoucherNumber(tx, { voucherType: 'payment', fyLabel, prefix: 'PMT' }));

  const created = await createVoucher(tx, {
    voucherType: 'payment',
    voucherNo,
    correctsVoucherId: opts.correctsVoucherId ?? null,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: party.id,
    supplierStateCode: null,
    placeOfSupplyStateCode: null,
    supplyType: null,
    reference: input.reference || null,
    narration: input.narration || null,
    calculation: null,
    lines: [],
    entries: paymentEntries({ amountPaise, fromAccountCode: input.fromAccountCode }),
    totalPaise: amountPaise,
  });

  // Oldest bill first, so payables ageing means something. Anything beyond
  // what is outstanding stays unallocated as an advance to the supplier.
  const allocation = await allocatePayment(tx, {
    settlementVoucherId: created.id,
    partyId: party.id,
    amountPaise,
    explicitTargets: [],
  });

  await postVoucherRow(tx, { voucherId: created.id, userId });

  await audit({
    action: 'voucher.payment.posted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      supplierName: party.name,
      amountPaise: amountPaise.toString(),
      from: input.fromAccountCode,
      allocatedPaise: allocation.allocatedPaise.toString(),
      unallocatedPaise: allocation.unallocatedPaise.toString(),
    },
  });

  revalidatePath('/process');
  return { id: created.id, voucherNo: created.voucherNo };
}

const createPaymentAction = defineAction({
  name: 'voucher.payment.created',
  capability: 'voucher:post',
  input: paymentSchema,
  handler: (ctx) => paymentHandler(ctx),
});

// ─── credit and debit notes ─────────────────────────────────────────────────

const noteSchema = z.object({
  partyId: z.string().uuid('Choose a party'),
  voucherDate: isoDate,
  /** The invoice or bill the note relates to. */
  againstVoucherId: z.string().uuid().optional().or(z.literal('')),
  supplierInvoiceNo: optional(z.string().trim().max(60)),
  placeOfSupplyStateCode: optional(stateCode),
  reason: z.string().trim().min(3, 'Say why the note is being raised').max(300),
  lines: z.array(taxLineSchema).min(1, 'A note needs at least one line'),
});

async function creditNoteHandler(
  { tx, orgId, input, userId, audit }: ActionContext<z.infer<typeof noteSchema>>,
  opts: CorrectionOpts = {},
) {
  const company = await companyContext(tx, orgId);
  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw notFound('That customer does not exist in this company.');

  const placeOfSupply =
    input.placeOfSupplyStateCode ||
    party.placeOfSupplyStateCode ||
    party.stateCode ||
    company.stateCode;
  const supplyType = determineSupplyType({
    supplierStateCode: company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
  });

  const lines = mapLines(input.lines);
  const calculation = calculateInvoice(lines, supplyType);
  const fyLabel = fyLabelFor(input.voucherDate, company.fyStartMonth);
  const voucherNo =
    opts.reuseVoucherNo ??
    (await allocateVoucherNumber(tx, { voucherType: 'credit_note', fyLabel, prefix: 'CRN' }));

  const created = await createVoucher(tx, {
    voucherType: 'credit_note',
    voucherNo,
    correctsVoucherId: opts.correctsVoucherId ?? null,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: party.id,
    supplierStateCode: company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
    supplyType,
    reference: input.againstVoucherId || null,
    narration: input.reason,
    calculation,
    lines,
    entries: creditNoteEntries(calculation),
  });

  // A credit note reduces what the customer owes, so it is allocated against
  // their open invoices exactly as a receipt is. Without this the receivable
  // would still show the full invoice after the goods came back.
  await allocateSettlement(tx, {
    settlementVoucherId: created.id,
    partyId: party.id,
    amountPaise: calculation.totalPaise,
    settles: 'sales',
    explicitTargets: input.againstVoucherId ? [input.againstVoucherId] : [],
  });

  await postVoucherRow(tx, { voucherId: created.id, userId });

  await audit({
    action: 'voucher.credit_note.posted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      partyName: party.name,
      reason: input.reason,
      totalPaise: calculation.totalPaise.toString(),
    },
  });

  revalidatePath('/process');
  return { id: created.id, voucherNo: created.voucherNo };
}

const createCreditNoteAction = defineAction({
  name: 'voucher.credit_note.created',
  capability: 'voucher:post',
  input: noteSchema,
  handler: (ctx) => creditNoteHandler(ctx),
});

async function debitNoteHandler(
  { tx, orgId, input, userId, audit }: ActionContext<z.infer<typeof noteSchema>>,
  opts: CorrectionOpts = {},
) {
  const company = await companyContext(tx, orgId);
  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw notFound('That supplier does not exist in this company.');

  const placeOfSupply = input.placeOfSupplyStateCode || company.stateCode;
  const supplyType = determineSupplyType({
    supplierStateCode: party.stateCode ?? company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
  });

  const lines = mapLines(input.lines);
  const calculation = calculateInvoice(lines, supplyType);
  const fyLabel = fyLabelFor(input.voucherDate, company.fyStartMonth);
  const voucherNo =
    opts.reuseVoucherNo ??
    (await allocateVoucherNumber(tx, { voucherType: 'debit_note', fyLabel, prefix: 'DBN' }));

  const created = await createVoucher(tx, {
    voucherType: 'debit_note',
    voucherNo,
    correctsVoucherId: opts.correctsVoucherId ?? null,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: party.id,
    supplierStateCode: party.stateCode ?? null,
    placeOfSupplyStateCode: placeOfSupply,
    supplyType,
    reference: input.againstVoucherId || null,
    supplierInvoiceNo: input.supplierInvoiceNo || null,
    narration: input.reason,
    calculation,
    lines,
    entries: debitNoteEntries(calculation),
  });

  // A debit note reduces what we owe the supplier, so it is allocated against
  // their open bills the way a payment is.
  await allocateSettlement(tx, {
    settlementVoucherId: created.id,
    partyId: party.id,
    amountPaise: calculation.totalPaise,
    settles: 'purchase',
    explicitTargets: input.againstVoucherId ? [input.againstVoucherId] : [],
  });

  await postVoucherRow(tx, { voucherId: created.id, userId });

  await audit({
    action: 'voucher.debit_note.posted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      partyName: party.name,
      reason: input.reason,
      totalPaise: calculation.totalPaise.toString(),
    },
  });

  revalidatePath('/process');
  return { id: created.id, voucherNo: created.voucherNo };
}

const createDebitNoteAction = defineAction({
  name: 'voucher.debit_note.created',
  capability: 'voucher:post',
  input: noteSchema,
  handler: (ctx) => debitNoteHandler(ctx),
});

// ─── journal and contra ─────────────────────────────────────────────────────

const journalSchema = z.object({
  voucherDate: isoDate,
  narration: z.string().trim().min(3, 'A journal needs a narration explaining it').max(500),
  lines: z
    .array(
      z.object({
        accountCode: z.string().trim().min(1),
        debitRupees: z.string().trim().default('0'),
        creditRupees: z.string().trim().default('0'),
      }),
    )
    .min(2, 'A journal needs at least two lines'),
});

/**
 * A journal: the only voucher where the accounts are chosen by hand.
 *
 * It therefore gets the strictest input handling. The narration is required
 * rather than optional: a journal nobody can explain six months later is the
 * entry an auditor asks about, and the one nobody can answer for.
 */
async function journalHandler(
  { tx, orgId, input, userId, audit }: ActionContext<z.infer<typeof journalSchema>>,
  opts: CorrectionOpts = {},
) {
  const company = await companyContext(tx, orgId);

  const codes = [...new Set(input.lines.map((l) => l.accountCode).filter(Boolean))];
  const known = await tx
    .select({ code: accounts.code })
    .from(accounts)
    .where(eq(accounts.isActive, true));
  const knownCodes = new Set(known.map((a) => a.code));
  const unknown = codes.filter((c) => !knownCodes.has(c));
  if (unknown.length > 0) {
    throw invalidInput(`No such account in this company: ${unknown.join(', ')}.`);
  }

  const entries = journalEntries(
    input.lines.map((l) => ({
      accountCode: l.accountCode,
      debitPaise: parseRupees(l.debitRupees || '0'),
      creditPaise: parseRupees(l.creditRupees || '0'),
    })),
  );

  const fyLabel = fyLabelFor(input.voucherDate, company.fyStartMonth);
  const voucherNo =
    opts.reuseVoucherNo ??
    (await allocateVoucherNumber(tx, { voucherType: 'journal', fyLabel, prefix: 'JV' }));

  const total = entries.reduce((acc, e) => acc + e.debitPaise, 0n);
  const created = await createVoucher(tx, {
    voucherType: 'journal',
    voucherNo,
    correctsVoucherId: opts.correctsVoucherId ?? null,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: null,
    supplierStateCode: null,
    placeOfSupplyStateCode: null,
    supplyType: null,
    reference: null,
    narration: input.narration,
    calculation: null,
    lines: [],
    entries,
    totalPaise: total,
  });
  await postVoucherRow(tx, { voucherId: created.id, userId });

  await audit({
    action: 'voucher.journal.posted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      narration: input.narration,
      lines: entries.map((e) => ({
        account: e.accountCode,
        debitPaise: e.debitPaise.toString(),
        creditPaise: e.creditPaise.toString(),
      })),
    },
  });

  revalidatePath('/process');
  return { id: created.id, voucherNo: created.voucherNo };
}

const createJournalAction = defineAction({
  name: 'voucher.journal.created',
  capability: 'voucher:post',
  input: journalSchema,
  handler: (ctx) => journalHandler(ctx),
});

const contraSchema = z
  .object({
    voucherDate: isoDate,
    fromAccountCode: z.enum(['CASH', 'BANK']),
    toAccountCode: z.enum(['CASH', 'BANK']),
    amountRupees: z.string().trim(),
    narration: optional(z.string().trim().max(500)),
  })
  .refine((v) => v.fromAccountCode !== v.toAccountCode, {
    message: 'A contra moves money between two different accounts.',
    path: ['toAccountCode'],
  });

async function contraHandler(
  { tx, orgId, input, userId, audit }: ActionContext<z.infer<typeof contraSchema>>,
  opts: CorrectionOpts = {},
) {
  const company = await companyContext(tx, orgId);
  const amountPaise = parseRupees(input.amountRupees);
  if (amountPaise <= 0n) throw invalidInput('A contra must move more than zero.');

  const fyLabel = fyLabelFor(input.voucherDate, company.fyStartMonth);
  const voucherNo =
    opts.reuseVoucherNo ??
    (await allocateVoucherNumber(tx, { voucherType: 'contra', fyLabel, prefix: 'CTR' }));

  const created = await createVoucher(tx, {
    voucherType: 'contra',
    voucherNo,
    correctsVoucherId: opts.correctsVoucherId ?? null,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: null,
    supplierStateCode: null,
    placeOfSupplyStateCode: null,
    supplyType: null,
    reference: null,
    narration: input.narration || null,
    calculation: null,
    lines: [],
    entries: contraEntries({
      fromAccountCode: input.fromAccountCode,
      toAccountCode: input.toAccountCode,
      amountPaise,
    }),
    totalPaise: amountPaise,
  });
  await postVoucherRow(tx, { voucherId: created.id, userId });

  await audit({
    action: 'voucher.contra.posted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      from: input.fromAccountCode,
      to: input.toAccountCode,
      amountPaise: amountPaise.toString(),
    },
  });

  revalidatePath('/process');
  return { id: created.id, voucherNo: created.voucherNo };
}

const createContraAction = defineAction({
  name: 'voucher.contra.created',
  capability: 'voucher:post',
  input: contraSchema,
  handler: (ctx) => contraHandler(ctx),
});

// ─── reversal: the only correction ──────────────────────────────────────────

const reverseSchema = z.object({
  id: z.string().uuid(),
  voucherDate: isoDate.optional(),
  reason: z.string().trim().min(3, 'Say why this is being reversed').max(300),
});

/**
 * Reverses a posted voucher.
 *
 * This is the only way to correct one, and the §2 rule in code: a posted
 * voucher cannot be edited, so the fix is a voucher that cancels it plus,
 * separately, a correct one. Both stay in the books, which is what the
 * Companies Act audit-trail requirement expects — the mistake is part of the
 * record, not something that disappears.
 *
 * The reversal is built from the original's own ledger entries rather than
 * recomputed from its amounts, so it cancels what was actually posted, even if
 * the engine would now compute the original differently.
 *
 * It is dated today by default rather than on the original's date, because
 * back-dating a correction into a reported period changes figures that have
 * already been filed.
 */
const reverseVoucherAction = defineAction({
  name: 'voucher.reversed',
  capability: 'voucher:post',
  input: reverseSchema,
  handler: async ({ tx, orgId, input, userId, audit }) => {
    const company = await companyContext(tx, orgId);

    const [original] = await tx.select().from(vouchers).where(eq(vouchers.id, input.id));
    if (!original) throw notFound('That voucher does not exist in this company.');

    const voucherDate = input.voucherDate ?? new Date().toISOString().slice(0, 10);
    const reversal = await reversePostedVoucher(tx, {
      original,
      reason: input.reason,
      voucherDate,
      fyStartMonth: company.fyStartMonth,
      userId,
    });

    await audit({
      action: 'voucher.reversed',
      subjectKind: 'voucher',
      subjectId: original.id,
      before: { voucherNo: original.voucherNo, reversedByVoucherId: null },
      after: {
        reversedByVoucherId: reversal.id,
        reversalVoucherNo: reversal.voucherNo,
        reason: input.reason,
        reversalDate: voucherDate,
        releasedAllocations: reversal.carried.length,
      },
    });

    revalidatePath('/process');
    revalidatePath('/dashboard');
    return {
      id: reversal.id,
      voucherNo: reversal.voucherNo,
      reversedVoucherNo: original.voucherNo,
    };
  },
});

// ─── editing: a draft is rewritten, a posted voucher is corrected ───────────

/**
 * The shape of every edit: which voucher, why it is changing, and the full set
 * of figures it should now carry — the same fields a new one takes.
 */
const editOf = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    id: z.string().uuid(),
    reason: optional(z.string().trim().max(300)),
    data,
  });

function correctionResult<T>(result: {
  created: T;
  mode: 'draft' | 'posted';
  originalVoucherNo: string;
  reversalVoucherNo: string | null;
}) {
  return {
    ...result.created,
    mode: result.mode,
    originalVoucherNo: result.originalVoucherNo,
    reversalVoucherNo: result.reversalVoucherNo,
  };
}

const editPurchaseBillAction = defineAction({
  name: 'voucher.purchase.edited',
  capability: 'voucher:draft',
  input: editOf(purchaseBillSchema),
  rateLimit: { limit: 30, windowSeconds: 60 },
  handler: async (ctx) =>
    correctionResult(
      await runCorrection(ctx, {
        id: ctx.input.id,
        reason: ctx.input.reason,
        types: ['purchase'],
        voucherDate: ctx.input.data.voucherDate,
        create: (opts) => purchaseBillHandler({ ...ctx, input: ctx.input.data }, opts),
      }),
    ),
});

const editPaymentAction = defineAction({
  name: 'voucher.payment.edited',
  capability: 'voucher:post',
  input: editOf(paymentSchema),
  handler: async (ctx) =>
    correctionResult(
      await runCorrection(ctx, {
        id: ctx.input.id,
        reason: ctx.input.reason,
        types: ['payment'],
        voucherDate: ctx.input.data.voucherDate,
        create: (opts) => paymentHandler({ ...ctx, input: ctx.input.data }, opts),
      }),
    ),
});

const editCreditNoteAction = defineAction({
  name: 'voucher.credit_note.edited',
  capability: 'voucher:post',
  input: editOf(noteSchema),
  handler: async (ctx) =>
    correctionResult(
      await runCorrection(ctx, {
        id: ctx.input.id,
        reason: ctx.input.reason,
        types: ['credit_note'],
        voucherDate: ctx.input.data.voucherDate,
        create: (opts) => creditNoteHandler({ ...ctx, input: ctx.input.data }, opts),
      }),
    ),
});

const editDebitNoteAction = defineAction({
  name: 'voucher.debit_note.edited',
  capability: 'voucher:post',
  input: editOf(noteSchema),
  handler: async (ctx) =>
    correctionResult(
      await runCorrection(ctx, {
        id: ctx.input.id,
        reason: ctx.input.reason,
        types: ['debit_note'],
        voucherDate: ctx.input.data.voucherDate,
        create: (opts) => debitNoteHandler({ ...ctx, input: ctx.input.data }, opts),
      }),
    ),
});

const editJournalAction = defineAction({
  name: 'voucher.journal.edited',
  capability: 'voucher:post',
  input: editOf(journalSchema),
  handler: async (ctx) =>
    correctionResult(
      await runCorrection(ctx, {
        id: ctx.input.id,
        reason: ctx.input.reason,
        types: ['journal'],
        voucherDate: ctx.input.data.voucherDate,
        create: (opts) => journalHandler({ ...ctx, input: ctx.input.data }, opts),
      }),
    ),
});

const editContraAction = defineAction({
  name: 'voucher.contra.edited',
  capability: 'voucher:post',
  input: editOf(contraSchema),
  handler: async (ctx) =>
    correctionResult(
      await runCorrection(ctx, {
        id: ctx.input.id,
        reason: ctx.input.reason,
        types: ['contra'],
        voucherDate: ctx.input.data.voucherDate,
        create: (opts) => contraHandler({ ...ctx, input: ctx.input.data }, opts),
      }),
    ),
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function createPurchaseBill(input: unknown) {
  return createPurchaseBillAction(input);
}

export async function createPayment(input: unknown) {
  return createPaymentAction(input);
}

export async function createCreditNote(input: unknown) {
  return createCreditNoteAction(input);
}

export async function createDebitNote(input: unknown) {
  return createDebitNoteAction(input);
}

export async function createJournal(input: unknown) {
  return createJournalAction(input);
}

export async function createContra(input: unknown) {
  return createContraAction(input);
}

export async function reverseVoucher(input: unknown) {
  return reverseVoucherAction(input);
}

export async function editPurchaseBill(input: unknown) {
  return editPurchaseBillAction(input);
}

export async function editPayment(input: unknown) {
  return editPaymentAction(input);
}

export async function editCreditNote(input: unknown) {
  return editCreditNoteAction(input);
}

export async function editDebitNote(input: unknown) {
  return editDebitNoteAction(input);
}

export async function editJournal(input: unknown) {
  return editJournalAction(input);
}

export async function editContra(input: unknown) {
  return editContraAction(input);
}
