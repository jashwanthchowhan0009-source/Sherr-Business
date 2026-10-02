'use server';

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { DECLARED_DOCUMENT_TYPES, documents } from '@/lib/db/schema';
import {
  MAX_UPLOAD_BYTES,
  buildStorageKey,
  hashBytes,
  isAcceptedMimeType,
  storage,
} from '@/lib/storage';
import { conflict, invalidInput, notFound } from '@/lib/errors';

const uploadSchema = z.object({
  declaredType: z.enum(DECLARED_DOCUMENT_TYPES).optional(),
  /** What the person typed when none of the chips fit. A label, never a type. */
  declaredLabel: z.string().trim().min(1).max(60).optional(),
  originalFilename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(128),
  /** Base64 of the file. Bounded by MAX_UPLOAD_BYTES once decoded. */
  contentBase64: z.string().min(1),
});

/**
 * Stores an uploaded document.
 *
 * It stores and lists, and does nothing else: no extraction, no classification,
 * no voucher. Step H adds the AI inbox on top of exactly this row.
 */
const uploadDocumentAction = defineAction({
  name: 'document.uploaded',
  capability: 'document:upload',
  input: uploadSchema,
  rateLimit: { limit: 40, windowSeconds: 60 },
  handler: async ({ tx, orgId, input, userId, audit }) => {
    if (!isAcceptedMimeType(input.mimeType)) {
      throw invalidInput(
        `${input.mimeType} is not a type this inbox accepts. Use a PDF, an image, a CSV or an Excel file.`,
      );
    }

    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.byteLength === 0) throw invalidInput('That file is empty.');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw invalidInput(
        `That file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${
          MAX_UPLOAD_BYTES / 1024 / 1024
        } MB.`,
      );
    }

    // The hash is the duplicate gate, and it is checked before the bytes are
    // written: re-uploading the same bill should cost nothing and change
    // nothing, which is how a forwarded email ends up here twice.
    const contentHash = hashBytes(bytes);
    const [existing] = await tx
      .select({ id: documents.id, originalFilename: documents.originalFilename })
      .from(documents)
      .where(eq(documents.contentHash, contentHash));
    if (existing) {
      throw conflict(
        `This is byte-for-byte the same file as ${existing.originalFilename}, already uploaded.`,
      );
    }

    const key = buildStorageKey({ orgId, mimeType: input.mimeType });
    const driver = await storage();
    await driver.put({ key, bytes, mimeType: input.mimeType });

    let row;
    try {
      [row] = await tx
        .insert(documents)
        .values({
          orgId,
          storageKey: key,
          originalFilename: input.originalFilename,
          mimeType: input.mimeType,
          byteSize: BigInt(bytes.byteLength),
          contentHash,
          declaredType: input.declaredType ?? null,
          declaredLabel: input.declaredLabel ?? null,
          uploadedBy: userId,
        })
        .returning();
    } catch (err) {
      // The object is written before the row, so a failed insert would leave an
      // orphan in the store that nothing references and nothing can reach.
      await driver.remove(key).catch(() => undefined);
      throw err;
    }

    if (!row) throw new Error('Document insert returned no row');

    await audit({
      action: 'document.uploaded',
      subjectKind: 'document',
      subjectId: row.id,
      after: {
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        byteSize: row.byteSize.toString(),
        declaredType: row.declaredType,
        declaredLabel: row.declaredLabel,
        contentHash,
        driver: driver.name,
      },
    });

    revalidatePath('/input');
    revalidatePath('/data');
    return {
      id: row.id,
      originalFilename: row.originalFilename,
      byteSize: row.byteSize.toString(),
    };
  },
});

const deleteDocumentAction = defineAction({
  name: 'document.deleted',
  capability: 'document:upload',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ tx, input, audit }) => {
    const [row] = await tx.select().from(documents).where(eq(documents.id, input.id));
    if (!row) throw notFound('That document does not exist in this company.');
    if (row.linkedVoucherId) {
      throw conflict(
        'This document is the source of a posted voucher and cannot be deleted. ' +
          'It is the evidence behind a number in the books.',
      );
    }

    await tx.delete(documents).where(eq(documents.id, input.id));
    const driver = await storage();
    await driver.remove(row.storageKey).catch(() => undefined);

    await audit({
      action: 'document.deleted',
      subjectKind: 'document',
      subjectId: input.id,
      before: { originalFilename: row.originalFilename, contentHash: row.contentHash },
    });

    revalidatePath('/input');
    return { id: input.id };
  },
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function uploadDocument(input: unknown) {
  return uploadDocumentAction(input);
}

export async function deleteDocument(input: unknown) {
  return deleteDocumentAction(input);
}
