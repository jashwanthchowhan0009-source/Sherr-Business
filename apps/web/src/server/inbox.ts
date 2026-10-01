'use server';

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { ProviderUnavailableError, type ExtractionProvider } from '@/lib/ai/contract';
import { currentProvider } from '@/lib/ai/registry';
import { validateExtraction } from '@/lib/ai/validate';
import {
  getExtraction,
  markApproved,
  markRejected,
  saveReview,
  storeExtraction,
} from '@/lib/db/extractions';
import { enterPurchaseBill } from '@/lib/db/purchase-bill';
import { lockedUpto } from '@/lib/db/ledger';
import { storage } from '@/lib/storage';
import { conflict, invalidInput, notFound } from '@/lib/errors';
import { parseQuantity, parseRupees } from '@/lib/accounting/units';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');

/**
 * Reads a stored document with the model.
 *
 * Nothing is posted and no voucher is created. The result is a set of claims about
 * the document, our own recomputation of its arithmetic, and a list of what a
 * person needs to look at. The document moves to `needs_review`, which is the only
 * route from here to a voucher.
 *
 * A failure is stored as a failure. An extraction that errors silently and leaves
 * no row would have the document sitting in the inbox looking unread, with nobody
 * knowing the model had already declined it twice.
 */
const extractDocumentAction = defineAction({
  name: 'document.extracted',
  capability: 'document:extract',
  input: z.object({ documentId: z.string().uuid() }),
  // Each call costs money and sends a file to a third party, so the limit is
  // tighter than for anything that only touches our own database.
  rateLimit: { limit: 20, windowSeconds: 60 },
  handler: async ({ tx, input, audit }) => {
    const { rows } = await tx.execute<{
      storage_key: string;
      mime_type: string;
      declared_type: string | null;
      original_filename: string;
      status: string;
    }>(sql`
      select storage_key, mime_type, declared_type, original_filename, status
        from documents where id = ${input.documentId}::uuid
    `);
    const doc = rows[0];
    if (!doc) throw notFound('That document does not exist.');

    if (doc.status === 'posted' || doc.status === 'approved') {
      throw conflict(
        'That document has already become a voucher. Re-reading it would invite a second ' +
          'entry of the same bill.',
      );
    }

    let provider: ExtractionProvider;
    try {
      provider = currentProvider();
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw invalidInput(err.message);
      throw err;
    }

    const driver = await storage();
    const bytes = await driver.get(doc.storage_key);

    const result = await provider.extract({
      bytes,
      mimeType: doc.mime_type,
      declaredType: doc.declared_type,
    });

    if (!result.ok) {
      const id = await storeExtraction(tx, {
        documentId: input.documentId,
        provider: provider.name,
        model: provider.model,
        promptVersion: provider.promptVersion,
        status: 'failed',
        failureReason: result.reason,
        rawResponse: result.raw,
      });

      await audit({
        action: 'document.extraction.failed',
        subjectKind: 'document_extraction',
        subjectId: id,
        after: { documentId: input.documentId, provider: provider.name, reason: result.reason },
      });

      revalidatePath('/input');
      return { extractionId: id, ok: false as const, reason: result.reason };
    }

    // Our own checks, against our own arithmetic. The model's figures are compared
    // with what the GST engine makes of the same lines; it never supplies a total.
    const company = await companyFacts(tx);
    const validation = validateExtraction(result.document, {
      today: new Date().toISOString().slice(0, 10),
      ownGstin: company.gstin,
      ownStateCode: company.stateCode,
      booksStartDate: company.booksStartDate,
      lockedUpto: await lockedUpto(tx),
    });

    const id = await storeExtraction(tx, {
      documentId: input.documentId,
      provider: provider.name,
      model: provider.model,
      promptVersion: provider.promptVersion,
      status: 'succeeded',
      extracted: result.document,
      rawResponse: result.raw,
      validation,
      usage: result.usage,
    });

    await audit({
      action: 'document.extracted',
      subjectKind: 'document_extraction',
      subjectId: id,
      after: {
        documentId: input.documentId,
        provider: provider.name,
        model: provider.model,
        promptVersion: provider.promptVersion,
        kind: result.document.kind,
        findings: validation.findings.length,
        blockers: validation.findings.filter((f) => f.severity === 'blocker').length,
        readyForReview: validation.readyForReview,
      },
    });

    revalidatePath('/input');
    return {
      extractionId: id,
      ok: true as const,
      kind: result.document.kind,
      findings: validation.findings.length,
      blockers: validation.findings.filter((f) => f.severity === 'blocker').length,
    };
  },
});

/** The company's own facts, for deciding which side of a document we are on. */
async function companyFacts(tx: Parameters<typeof storeExtraction>[0]) {
  const { rows } = await tx.execute<{
    state_code: string | null;
    books_start_date: string | null;
    gstin: string | null;
  }>(sql`
    select o.state_code, o.books_start_date::text as books_start_date,
           (select upper(number) from org_registrations r
             where r.kind = 'gstin' and r.state_code = o.state_code limit 1) as gstin
      from organizations o
     limit 1
  `);
  const row = rows[0];
  return {
    stateCode: row?.state_code ?? null,
    booksStartDate: row?.books_start_date ?? null,
    gstin: row?.gstin ?? null,
  };
}

// ─── review ──────────────────────────────────────────────────────────────────

/**
 * What a reviewer settled on.
 *
 * Amounts arrive as the strings a person typed or accepted, and are parsed here by
 * the same parser the manual forms use. A number that reaches the ledger has passed
 * through a person and through `parseRupees`, never out of a model.
 */
const reviewedLineSchema = z.object({
  description: z.string().trim().min(1, 'Describe the line').max(300),
  hsnSac: z.string().trim().max(20).optional().or(z.literal('')),
  unit: z.string().trim().max(20).optional().or(z.literal('')),
  quantity: z.string().trim().min(1, 'Enter a quantity'),
  unitPriceRupees: z.string().trim().min(1, 'Enter a rate'),
  discountRupees: z.string().trim().optional().or(z.literal('')),
  gstRateBps: z.coerce.number().int().min(0).max(10_000),
  cessRateBps: z.coerce.number().int().min(0).max(10_000).default(0),
  reverseCharge: z.coerce.boolean().default(false),
});

const reviewedSchema = z.object({
  extractionId: z.string().uuid(),
  partyId: z.string().uuid('Choose the supplier this bill is from'),
  voucherDate: isoDate,
  supplierInvoiceNo: z.string().trim().min(1, "Enter the supplier's invoice number").max(60),
  supplierInvoiceDate: isoDate,
  placeOfSupplyStateCode: z
    .string()
    .trim()
    .regex(/^[0-9]{2}$/, 'State code is two digits')
    .optional()
    .or(z.literal('')),
  narration: z.string().trim().max(500).optional().or(z.literal('')),
  lines: z.array(reviewedLineSchema).min(1, 'A bill needs at least one line'),
});

/** Saves the reviewer's corrections without creating anything. */
const saveReviewAction = defineAction({
  name: 'document.review.saved',
  capability: 'voucher:draft',
  input: reviewedSchema,
  handler: async ({ tx, input, userId, audit }) => {
    const { extractionId, ...reviewed } = input;
    await saveReview(tx, { extractionId, reviewed, userId });

    await audit({
      action: 'document.review.saved',
      subjectKind: 'document_extraction',
      subjectId: extractionId,
      after: { lines: reviewed.lines.length, partyId: reviewed.partyId },
    });

    revalidatePath('/input');
    return { extractionId };
  },
});

/**
 * Approving an extraction into a **draft** voucher.
 *
 * Never a posting. `createVoucher` writes `status = 'draft'` and nothing here calls
 * `postVoucher`, so the AI path cannot put a figure into the books however
 * confident the model was: a person opens the draft on the Process page and posts
 * it, which is the same deliberate act as entering the bill by hand.
 *
 * The voucher is built by `enterPurchaseBill`, the same function the manual form
 * uses, so the duplicate check and the tax computation are not merely equivalent —
 * they are the same code.
 */
const approveExtractionAction = defineAction({
  name: 'document.approved',
  capability: 'voucher:draft',
  input: reviewedSchema,
  handler: async ({ tx, input, userId, audit }) => {
    const { extractionId, ...reviewed } = input;

    const extraction = await getExtraction(tx, extractionId);
    if (extraction.status === 'approved') {
      throw conflict('That document has already been approved.');
    }
    if (extraction.status === 'failed') {
      throw conflict('That reading failed, so there is nothing to approve. Read it again.');
    }

    const created = await enterPurchaseBill(tx, {
      partyId: reviewed.partyId,
      voucherDate: reviewed.voucherDate,
      supplierInvoiceNo: reviewed.supplierInvoiceNo,
      supplierInvoiceDate: reviewed.supplierInvoiceDate,
      placeOfSupplyStateCode: reviewed.placeOfSupplyStateCode || null,
      narration: reviewed.narration || null,
      lines: reviewed.lines.map((line) => ({
        itemId: null,
        description: line.description,
        hsnSac: line.hsnSac || null,
        unit: line.unit || null,
        quantity: parseQuantity(line.quantity),
        unitPricePaise: parseRupees(line.unitPriceRupees),
        discountPaise: parseRupees(line.discountRupees || '0'),
        gstRateBps: line.gstRateBps,
        cessRateBps: line.cessRateBps,
        reverseCharge: line.reverseCharge,
      })),
      // The one thing this path never does.
      post: false,
      sourceDocumentId: extraction.documentId,
      userId,
    });

    await markApproved(tx, { extractionId, voucherId: created.id, reviewed, userId });

    await tx.execute(sql`
      update documents
         set status = 'approved', linked_voucher_id = ${created.id}::uuid
       where id = ${extraction.documentId}::uuid
    `);

    await audit({
      action: 'document.approved',
      subjectKind: 'document_extraction',
      subjectId: extractionId,
      after: {
        documentId: extraction.documentId,
        voucherId: created.id,
        voucherNo: created.voucherNo,
        // Recorded explicitly, because this is the guarantee the step rests on.
        status: 'draft',
        totalPaise: created.totalPaise.toString(),
        supplierName: created.partyName,
      },
    });

    revalidatePath('/input');
    revalidatePath('/process');
    return {
      extractionId,
      voucherId: created.id,
      voucherNo: created.voucherNo,
      totalPaise: created.totalPaise.toString(),
      posted: false as const,
    };
  },
});

/** Rejecting a reading, with a reason, leaving the document in the inbox. */
const rejectExtractionAction = defineAction({
  name: 'document.rejected',
  capability: 'voucher:draft',
  input: z.object({
    extractionId: z.string().uuid(),
    reason: z.string().trim().min(3, 'Say briefly why this is being rejected').max(500),
  }),
  handler: async ({ tx, input, userId, audit }) => {
    const documentId = await markRejected(tx, {
      extractionId: input.extractionId,
      reason: input.reason,
      userId,
    });

    await audit({
      action: 'document.rejected',
      subjectKind: 'document_extraction',
      subjectId: input.extractionId,
      after: { documentId, reason: input.reason },
    });

    revalidatePath('/input');
    return { extractionId: input.extractionId };
  },
});

// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function extractDocument(input: unknown) {
  return extractDocumentAction(input);
}

export async function saveExtractionReview(input: unknown) {
  return saveReviewAction(input);
}

export async function approveExtraction(input: unknown) {
  return approveExtractionAction(input);
}

export async function rejectExtraction(input: unknown) {
  return rejectExtractionAction(input);
}
