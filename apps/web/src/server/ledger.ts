'use server';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
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

const stateCode = z.string().trim().regex(/^[0-9]{2}$/, 'State code is two digits');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
const optional = (schema: z.ZodString) => schema.optional().or(z.literal(''));

// ─── parties ────────────────────────────────────────────────────────────────

const partySchema = z
  .object({
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
  })
  .superRefine((value, ctx) => {
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
  });

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

// ─── items ──────────────────────────────────────────────────────────────────

const itemSchema = z.object({
  code: optional(z.string().trim().max(32)),
  name: z.string().trim().min(2, 'Enter a name').max(200),
  kind: z.enum(ITEM_KINDS).default('goods'),
  hsnSac: optional(z.string().trim().regex(/^[0-9]{4,8}$/, 'HSN/SAC is 4 to 8 digits')),
  unit: z.string().trim().min(1).max(12).default('NOS'),
  gstRateBps: z.coerce.number().int().min(0).max(100_000).default(0),
  cessRateBps: z.coerce.number().int().min(0).max(100_000).default(0),
  salePriceRupees: optional(z.string().trim()),
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
  gstRateBps: z.coerce.number().int().min(0).max(100_000),
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
const createSalesInvoiceAction = defineAction({
  name: 'voucher.sales.created',
  capability: 'voucher:draft',
  input: invoiceSchema,
  rateLimit: { limit: 60, windowSeconds: 60 },
  handler: async ({ tx, orgId, input, userId, role, audit }) => {
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
    const voucherNo = await allocateVoucherNumber(tx, {
      voucherType: 'sales',
      fyLabel,
      prefix: 'INV',
    });

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
    });

    // Posting is a second, separately gated act even inside one action: a role
    // that may draft but not post gets the draft and a clear refusal.
    let posted = false;
    if (input.post) {
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

const createReceiptAction = defineAction({
  name: 'voucher.receipt.created',
  capability: 'voucher:post',
  input: receiptSchema,
  handler: async ({ tx, orgId, input, userId, audit }) => {
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
    const voucherNo = await allocateVoucherNumber(tx, {
      voucherType: 'receipt',
      fyLabel,
      prefix: 'RCT',
    });

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
