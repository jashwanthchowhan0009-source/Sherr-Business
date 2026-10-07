'use server';

import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction, type ActionContext } from '@/lib/auth/action';
import { can } from '@/lib/auth/permissions';
import { ITEM_KINDS, PARTY_KINDS, items, organizations, parties } from '@/lib/db/schema';
import {
  allocateReceipt,
  allocateVoucherNumber,
  createVoucher,
  postVoucher as postVoucherRow,
} from '@/lib/db/ledger';
import { calculateInvoice, determineSupplyType } from '@/lib/accounting/gst';
import { receiptEntries, salesInvoiceEntries } from '@/lib/accounting/posting';
import { fyLabelFor } from '@/lib/accounting/fiscal-year';
import { parseQuantity, parseRupees } from '@/lib/accounting/units';
import { isValidPan, validateGstin } from '@/lib/india/gstin';
import { conflict, forbidden, invalidInput, notFound } from '@/lib/errors';
import { runCorrection, type CorrectionOpts } from '@/lib/db/corrections';

const stateCode = z.string().trim().regex(/^[0-9]{2}$/, 'State code is two digits');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
const optional = (schema: z.ZodString) => schema.optional().or(z.literal(''));

/**
 * A GST rate in basis points, which must actually be chosen.
 *
 * `z.coerce.number()` alone turns an empty field into 0, which would quietly
 * post a taxable line as nil-rated. An empty value is refused instead.
 */
const rateBps = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce
    .number({ error: 'Choose a GST rate' })
    .int()
    .min(0)
    .max(100_000),
);

// ─── parties ────────────────────────────────────────────────────────────────

const partyFields = z.object({
  kind: z.enum(PARTY_KINDS),
  name: z.string().trim().min(2, 'Enter a name').max(200),
  legalName: optional(z.string().trim().max(200)),
  gstin: optional(z.string().trim().toUpperCase()),
  pan: optional(z.string().trim().toUpperCase()),
  stateCode: optional(stateCode),
  placeOfSupplyStateCode: optional(stateCode),
  email: optional(z.string().trim().email('That email does not look right')),
  phone: optional(z.string().trim().max(20)),
  billingAddress: optional(z.string().trim().max(500)),
  creditDays: z.coerce.number().int().min(0).max(365).default(0),
  notes: optional(z.string().trim().max(1000)),
});

function checkParty(value: z.infer<typeof partyFields>, ctx: z.RefinementCtx) {
  if (value.pan && !isValidPan(value.pan)) {
    ctx.addIssue({ code: 'custom', path: ['pan'], message: 'PAN looks like AAAAA9999A.' });
  }
  if (!value.gstin) {
    // A party without a GSTIN is unregistered, which is legitimate, but then
    // the state has to be given directly: it decides CGST/SGST versus IGST.
    if (!value.stateCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['stateCode'],
        message: 'Without a GSTIN, the state is needed to work out the tax.',
      });
    }
    return;
  }

  const result = validateGstin(value.gstin);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: result.message });
    return;
  }
  // The GSTIN carries the state and the PAN. Disagreement means one of the
  // two is wrong, so say so rather than silently preferring either.
  if (value.stateCode && value.stateCode !== result.parts.stateCode) {
    ctx.addIssue({
      code: 'custom',
      path: ['stateCode'],
      message: `This GSTIN is registered in state ${result.parts.stateCode}.`,
    });
  }
  if (value.pan && value.pan !== result.parts.pan) {
    ctx.addIssue({
      code: 'custom',
      path: ['pan'],
      message: `This GSTIN belongs to PAN ${result.parts.pan}.`,
    });
  }
}

const partySchema = partyFields.superRefine(checkParty);
const partyUpdateSchema = partyFields
  .extend({ id: z.string().uuid() })
  .superRefine((value, ctx) => checkParty(value, ctx));

const createPartyAction = defineAction({
  name: 'party.created',
  capability: 'party:write',
  input: partySchema,
  handler: async ({ tx, orgId, input, audit }) => {
    const derived = input.gstin ? validateGstin(input.gstin) : null;
    const resolvedState =
      input.stateCode || (derived?.ok ? derived.parts.stateCode : null) || null;

    const [row] = await tx
      .insert(parties)
      .values({
        orgId,
        kind: input.kind,
        name: input.name,
        legalName: input.legalName || null,
        gstin: input.gstin || null,
        pan: input.pan || (derived?.ok ? derived.parts.pan : null) || null,
        stateCode: resolvedState,
        // Defaults to the party's own state; an invoice may still override it.
        placeOfSupplyStateCode: input.placeOfSupplyStateCode || resolvedState,
        email: input.email || null,
        phone: input.phone || null,
        billingAddress: input.billingAddress || null,
        creditDays: input.creditDays,
        notes: input.notes || null,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      throw conflict(`A party with GSTIN ${input.gstin} already exists in this company.`);
    }

    await audit({
      action: 'party.created',
      subjectKind: 'party',
      subjectId: row.id,
      after: { name: row.name, kind: row.kind, gstin: row.gstin, stateCode: row.stateCode },
    });

    revalidatePath('/process');
    revalidatePath('/data');
    return { id: row.id, name: row.name };
  },
});

const archivePartyAction = defineAction({
  name: 'party.archived',
  capability: 'party:write',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.id, input.id), eq(parties.orgId, orgId)));
    if (!before) throw notFound('That party does not exist in this company.');

    // Archived, never deleted: a party named on a posted invoice must remain
    // resolvable for as long as that invoice exists.
    await tx
      .update(parties)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(parties.id, input.id));

    await audit({
      action: 'party.archived',
      subjectKind: 'party',
      subjectId: input.id,
      before: { name: before.name, isActive: true },
      after: { isActive: false },
    });

    revalidatePath('/process');
    return { id: input.id };
  },
});

/**
 * Editing a customer or supplier.
 *
 * Safe for the books: every voucher froze the party's states and GSTIN onto
 * itself when it was written, so a change here affects what is raised from now
 * on and never rewrites an invoice that already exists.
 */
const updatePartyAction = defineAction({
  name: 'party.updated',
  capability: 'party:write',
  input: partyUpdateSchema,
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.id, input.id), eq(parties.orgId, orgId)));
    if (!before) throw notFound('Party');

    if (input.gstin) {
      const [clash] = await tx
        .select({ name: parties.name })
        .from(parties)
        .where(and(eq(parties.gstin, input.gstin), ne(parties.id, input.id)));
      if (clash) throw conflict(`${clash.name} already has GSTIN ${input.gstin} in this company.`);
    }

    const derived = input.gstin ? validateGstin(input.gstin) : null;
    const resolvedState =
      input.stateCode || (derived?.ok ? derived.parts.stateCode : null) || null;

    const [row] = await tx
      .update(parties)
      .set({
        kind: input.kind,
        name: input.name,
        legalName: input.legalName || null,
        gstin: input.gstin || null,
        pan: input.pan || (derived?.ok ? derived.parts.pan : null) || null,
        stateCode: resolvedState,
        placeOfSupplyStateCode: input.placeOfSupplyStateCode || resolvedState,
        email: input.email || null,
        phone: input.phone || null,
        billingAddress: input.billingAddress || null,
        creditDays: input.creditDays,
        notes: input.notes || null,
        updatedAt: new Date(),
      })
      .where(eq(parties.id, input.id))
      .returning();
    if (!row) throw notFound('Party');

    await audit({
      action: 'party.updated',
      subjectKind: 'party',
      subjectId: row.id,
      before: {
        name: before.name, kind: before.kind, gstin: before.gstin, stateCode: before.stateCode,
        email: before.email, billingAddress: before.billingAddress, creditDays: before.creditDays,
      },
      after: {
        name: row.name, kind: row.kind, gstin: row.gstin, stateCode: row.stateCode,
        email: row.email, billingAddress: row.billingAddress, creditDays: row.creditDays,
      },
    });

    revalidatePath('/process');
    revalidatePath('/data');
    return { id: row.id, name: row.name };
  },
});

const restorePartyAction = defineAction({
  name: 'party.restored',
  capability: 'party:write',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [row] = await tx
      .update(parties)
      .set({ isActive: true, updatedAt: new Date() })
      .where(and(eq(parties.id, input.id), eq(parties.orgId, orgId)))
      .returning({ id: parties.id, name: parties.name });
    if (!row) throw notFound('Party');

    await audit({
      action: 'party.restored',
      subjectKind: 'party',
      subjectId: row.id,
      before: { isActive: false },
      after: { isActive: true },
    });

    revalidatePath('/process');
    return { id: row.id, name: row.name };
  },
});

// ─── items ──────────────────────────────────────────────────────────────────

const itemSchema = z.object({
  code: optional(z.string().trim().max(32)),
  name: z.string().trim().min(2, 'Enter a name').max(200),
  kind: z.enum(ITEM_KINDS).default('goods'),
  hsnSac: optional(z.string().trim().regex(/^[0-9]{4,8}$/, 'HSN/SAC is 4 to 8 digits')),
  unit: z.string().trim().min(1).max(12).default('NOS'),
  gstRateBps: rateBps,
  cessRateBps: z.coerce.number().int().min(0).max(100_000).default(0),
  salePriceRupees: optional(z.string().trim()),
  purchasePriceRupees: optional(z.string().trim()),
});

const createItemAction = defineAction({
  name: 'item.created',
  capability: 'item:write',
  input: itemSchema,
  handler: async ({ tx, orgId, input, audit }) => {
    const [row] = await tx
      .insert(items)
      .values({
        orgId,
        code: input.code || null,
        name: input.name,
        kind: input.kind,
        hsnSac: input.hsnSac || null,
        unit: input.unit,
        gstRateBps: input.gstRateBps,
        cessRateBps: input.cessRateBps,
        salePricePaise: input.salePriceRupees ? parseRupees(input.salePriceRupees) : null,
        purchasePricePaise: input.purchasePriceRupees
          ? parseRupees(input.purchasePriceRupees)
          : null,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) throw conflict(`An item with code ${input.code} already exists.`);

    await audit({
      action: 'item.created',
      subjectKind: 'item',
      subjectId: row.id,
      after: { name: row.name, hsnSac: row.hsnSac, gstRateBps: row.gstRateBps },
    });

    revalidatePath('/process');
    return { id: row.id, name: row.name };
  },
});

/**
 * Editing an item.
 *
 * A changed rate or price applies to what is raised next. Posted vouchers keep
 * the line figures they were calculated with, so an old invoice reprints
 * exactly as it was issued.
 */
const updateItemAction = defineAction({
  name: 'item.updated',
  capability: 'item:write',
  input: itemSchema.extend({
    id: z.string().uuid(),
    isActive: z.coerce.boolean().default(true),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(items)
      .where(and(eq(items.id, input.id), eq(items.orgId, orgId)));
    if (!before) throw notFound('Item');

    if (input.code) {
      const [clash] = await tx
        .select({ name: items.name })
        .from(items)
        .where(and(eq(items.code, input.code), ne(items.id, input.id)));
      if (clash) throw conflict(`${clash.name} already uses the code ${input.code}.`);
    }

    const [row] = await tx
      .update(items)
      .set({
        code: input.code || null,
        name: input.name,
        kind: input.kind,
        hsnSac: input.hsnSac || null,
        unit: input.unit,
        gstRateBps: input.gstRateBps,
        cessRateBps: input.cessRateBps,
        salePricePaise: input.salePriceRupees ? parseRupees(input.salePriceRupees) : null,
        purchasePricePaise: input.purchasePriceRupees
          ? parseRupees(input.purchasePriceRupees)
          : null,
        isActive: input.isActive,
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.id))
      .returning();
    if (!row) throw notFound('Item');

    await audit({
      action: 'item.updated',
      subjectKind: 'item',
      subjectId: row.id,
      before: {
        name: before.name, hsnSac: before.hsnSac, unit: before.unit, gstRateBps: before.gstRateBps,
        salePricePaise: before.salePricePaise?.toString() ?? null, isActive: before.isActive,
      },
      after: {
        name: row.name, hsnSac: row.hsnSac, unit: row.unit, gstRateBps: row.gstRateBps,
        salePricePaise: row.salePricePaise?.toString() ?? null, isActive: row.isActive,
      },
    });

    revalidatePath('/process');
    return { id: row.id, name: row.name };
  },
});

// ─── sales invoice ──────────────────────────────────────────────────────────

const invoiceLineSchema = z.object({
  itemId: z.string().uuid().optional().or(z.literal('')),
  description: z.string().trim().min(1, 'Describe the line').max(300),
  hsnSac: optional(z.string().trim()),
  unit: optional(z.string().trim().max(12)),
  /** Decimal string, e.g. "2.5". Parsed to an integer, never a float. */
  quantity: z.string().trim().default('1'),
  unitPriceRupees: z.string().trim(),
  discountRupees: z.string().trim().default('0'),
  gstRateBps: rateBps,
  cessRateBps: z.coerce.number().int().min(0).max(100_000).default(0),
  reverseCharge: z.coerce.boolean().default(false),
});

const invoiceSchema = z.object({
  partyId: z.string().uuid('Choose a customer'),
  voucherDate: isoDate,
  placeOfSupplyStateCode: optional(stateCode),
  reference: optional(z.string().trim().max(100)),
  narration: optional(z.string().trim().max(500)),
  isExport: z.coerce.boolean().default(false),
  isSez: z.coerce.boolean().default(false),
  isExempt: z.coerce.boolean().default(false),
  lines: z.array(invoiceLineSchema).min(1, 'An invoice needs at least one line'),
  /** Posting immediately is the normal case; a draft can be saved instead. */
  post: z.coerce.boolean().default(true),
});

/**
 * Creates a sales invoice.
 *
 * The order is deliberate and is the §2 rule in code: the deterministic engine
 * calculates, the posting engine decides the accounts, and only then is
 * anything written. Nothing in this handler computes an amount itself.
 */
async function salesInvoiceHandler(
  { tx, orgId, input, userId, role, audit }: ActionContext<z.infer<typeof invoiceSchema>>,
  opts: CorrectionOpts = {},
) {
  const [company] = await tx
    .select({ stateCode: organizations.stateCode, fyStartMonth: organizations.fyStartMonth })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!company?.stateCode) {
    throw invalidInput(
      'This company has no state on its profile, so GST cannot be worked out. Set it in Data first.',
    );
  }

  const [party] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.isActive, true)));
  if (!party) throw notFound('That customer does not exist in this company.');

  const placeOfSupply =
    input.placeOfSupplyStateCode ||
    party.placeOfSupplyStateCode ||
    party.stateCode ||
    company.stateCode;

  const supplyType = determineSupplyType({
    supplierStateCode: company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
    isExport: input.isExport,
    isSez: input.isSez,
    isExempt: input.isExempt,
  });

  const lines = input.lines.map((line) => ({
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

  const calculation = calculateInvoice(lines, supplyType);
  const entries = salesInvoiceEntries(calculation);

  const fyLabel = fyLabelFor(input.voucherDate, company.fyStartMonth);
  const voucherNo =
    opts.reuseVoucherNo ??
    (await allocateVoucherNumber(tx, { voucherType: 'sales', fyLabel, prefix: 'INV' }));

  const created = await createVoucher(tx, {
    voucherType: 'sales',
    voucherNo,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: party.id,
    supplierStateCode: company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
    supplyType,
    reference: input.reference || null,
    narration: input.narration || null,
    calculation,
    lines,
    entries,
    sourceDocumentId: opts.sourceDocumentId ?? null,
    correctsVoucherId: opts.correctsVoucherId ?? null,
  });

  // Posting is a second, separately gated act even inside one action: a role
  // that may draft but not post gets the draft and a clear refusal.
  let posted = false;
  if (input.post || opts.mustPost) {
    if (!can(role, 'voucher:post')) throw forbidden('post a voucher');
    await postVoucherRow(tx, { voucherId: created.id, userId });
    posted = true;
  }

  await audit({
    action: posted ? 'voucher.sales.posted' : 'voucher.sales.drafted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      partyName: party.name,
      supplyType,
      placeOfSupply,
      taxablePaise: calculation.taxablePaise.toString(),
      cgstPaise: calculation.cgstPaise.toString(),
      sgstPaise: calculation.sgstPaise.toString(),
      igstPaise: calculation.igstPaise.toString(),
      roundOffPaise: calculation.roundOffPaise.toString(),
      totalPaise: calculation.totalPaise.toString(),
      status: posted ? 'posted' : 'draft',
    },
  });

  revalidatePath('/process');
  revalidatePath('/output');
  revalidatePath('/dashboard');

  return {
    id: created.id,
    voucherNo: created.voucherNo,
    totalPaise: created.totalPaise.toString(),
    supplyType,
    posted,
  };
}

const createSalesInvoiceAction = defineAction({
  name: 'voucher.sales.created',
  capability: 'voucher:draft',
  input: invoiceSchema,
  rateLimit: { limit: 60, windowSeconds: 60 },
  handler: (ctx) => salesInvoiceHandler(ctx),
});

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

const editSalesInvoiceAction = defineAction({
  name: 'voucher.sales.edited',
  capability: 'voucher:draft',
  input: editOf(invoiceSchema),
  rateLimit: { limit: 30, windowSeconds: 60 },
  handler: async (ctx) => {
    const result = await runCorrection(ctx, {
      id: ctx.input.id,
      reason: ctx.input.reason,
      types: ['sales'],
      voucherDate: ctx.input.data.voucherDate,
      create: (opts) => salesInvoiceHandler({ ...ctx, input: ctx.input.data }, opts),
    });
    return {
      ...result.created,
      mode: result.mode,
      originalVoucherNo: result.originalVoucherNo,
      reversalVoucherNo: result.reversalVoucherNo,
    };
  },
});

const postVoucherAction = defineAction({
  name: 'voucher.posted',
  capability: 'voucher:post',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ tx, input, userId, audit }) => {
    const result = await postVoucherRow(tx, { voucherId: input.id, userId });

    await audit({
      action: 'voucher.posted',
      subjectKind: 'voucher',
      subjectId: input.id,
      before: { status: 'draft' },
      after: { status: 'posted', voucherNo: result.voucherNo },
    });

    revalidatePath('/process');
    revalidatePath('/output');
    return { id: input.id, voucherNo: result.voucherNo };
  },
});

// ─── receipts ───────────────────────────────────────────────────────────────

const receiptSchema = z.object({
  partyId: z.string().uuid('Choose a customer'),
  voucherDate: isoDate,
  amountRupees: z.string().trim(),
  intoAccountCode: z.enum(['CASH', 'BANK']).default('BANK'),
  reference: optional(z.string().trim().max(100)),
  narration: optional(z.string().trim().max(500)),
  /** Invoices this receipt settles, oldest first when left empty. */
  allocateToVoucherIds: z.array(z.string().uuid()).default([]),
});

async function receiptHandler(
  { tx, orgId, input, userId, audit }: ActionContext<z.infer<typeof receiptSchema>>,
  opts: CorrectionOpts = {},
) {
  const [company] = await tx
    .select({ fyStartMonth: organizations.fyStartMonth })
    .from(organizations)
    .where(eq(organizations.id, orgId));

  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw notFound('That customer does not exist in this company.');

  const amountPaise = parseRupees(input.amountRupees);
  if (amountPaise <= 0n) throw invalidInput('A receipt must be for more than zero.');

  const entries = receiptEntries({ amountPaise, intoAccountCode: input.intoAccountCode });

  const fyLabel = fyLabelFor(input.voucherDate, company?.fyStartMonth ?? 4);
  const voucherNo =
    opts.reuseVoucherNo ??
    (await allocateVoucherNumber(tx, { voucherType: 'receipt', fyLabel, prefix: 'RCT' }));

  const created = await createVoucher(tx, {
    voucherType: 'receipt',
    voucherNo,
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
    entries,
    totalPaise: amountPaise,
    correctsVoucherId: opts.correctsVoucherId ?? null,
  });

  await allocateReceipt(tx, {
    settlementVoucherId: created.id,
    partyId: party.id,
    amountPaise,
    explicitTargets: input.allocateToVoucherIds,
  });

  await postVoucherRow(tx, { voucherId: created.id, userId });

  await audit({
    action: 'voucher.receipt.posted',
    subjectKind: 'voucher',
    subjectId: created.id,
    after: {
      voucherNo: created.voucherNo,
      partyName: party.name,
      amountPaise: amountPaise.toString(),
      into: input.intoAccountCode,
    },
  });

  revalidatePath('/process');
  revalidatePath('/dashboard');
  return { id: created.id, voucherNo: created.voucherNo };
}

const createReceiptAction = defineAction({
  name: 'voucher.receipt.created',
  capability: 'voucher:post',
  input: receiptSchema,
  handler: (ctx) => receiptHandler(ctx),
});

const editReceiptAction = defineAction({
  name: 'voucher.receipt.edited',
  capability: 'voucher:post',
  input: editOf(receiptSchema),
  handler: async (ctx) => {
    const result = await runCorrection(ctx, {
      id: ctx.input.id,
      reason: ctx.input.reason,
      types: ['receipt'],
      voucherDate: ctx.input.data.voucherDate,
      create: (opts) => receiptHandler({ ...ctx, input: ctx.input.data }, opts),
    });
    return {
      ...result.created,
      mode: result.mode,
      originalVoucherNo: result.originalVoucherNo,
      reversalVoucherNo: result.reversalVoucherNo,
    };
  },
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function createParty(input: unknown) {
  return createPartyAction(input);
}

export async function archiveParty(input: unknown) {
  return archivePartyAction(input);
}

export async function createItem(input: unknown) {
  return createItemAction(input);
}

export async function createSalesInvoice(input: unknown) {
  return createSalesInvoiceAction(input);
}

export async function postVoucher(input: unknown) {
  return postVoucherAction(input);
}

export async function createReceipt(input: unknown) {
  return createReceiptAction(input);
}

export async function updateParty(input: unknown) {
  return updatePartyAction(input);
}

export async function restoreParty(input: unknown) {
  return restorePartyAction(input);
}

export async function updateItem(input: unknown) {
  return updateItemAction(input);
}

export async function editSalesInvoice(input: unknown) {
  return editSalesInvoiceAction(input);
}

export async function editReceipt(input: unknown) {
  return editReceiptAction(input);
}
