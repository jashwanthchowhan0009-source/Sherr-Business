import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';
import { getExtraction, listInbox, suggestParty, type InboxRow } from '@/lib/db/extractions';
import { lockedUpto } from '@/lib/db/ledger';
import type { ExtractedDocument } from '@/lib/ai/contract';
import type { Finding, ValidationResult } from '@/lib/ai/validate';

/** The inbox, newest first. */
export async function getInbox(ctx: RequestContext, limit = 50): Promise<InboxRow[]> {
  if (!can(ctx.role, 'document:read')) throw forbidden('see the document inbox');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => listInbox(tx, limit));
}

/**
 * The stored validation, with its amounts back as bigints.
 *
 * They were written as strings so no figure passed through a float on the way to
 * the database. Reading them back is where they become amounts again, and it is
 * done explicitly here rather than by a reviver that would have to guess which
 * string is money.
 */
export interface StoredValidation {
  findings: Finding[];
  computed: {
    taxablePaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    cessPaise: bigint;
    roundOffPaise: bigint;
    totalPaise: bigint;
    supplyType: string | null;
  } | null;
  stated: Record<string, bigint | null>;
  readyForReview: boolean;
}

export function reviveValidation(raw: unknown): StoredValidation | null {
  if (raw === null || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;

  const toPaise = (x: unknown): bigint => BigInt(String(x ?? '0'));
  const computedRaw = v.computed as Record<string, unknown> | null | undefined;

  return {
    findings: Array.isArray(v.findings) ? (v.findings as Finding[]) : [],
    computed: computedRaw
      ? {
          taxablePaise: toPaise(computedRaw.taxablePaise),
          cgstPaise: toPaise(computedRaw.cgstPaise),
          sgstPaise: toPaise(computedRaw.sgstPaise),
          igstPaise: toPaise(computedRaw.igstPaise),
          cessPaise: toPaise(computedRaw.cessPaise),
          roundOffPaise: toPaise(computedRaw.roundOffPaise),
          totalPaise: toPaise(computedRaw.totalPaise),
          supplyType: (computedRaw.supplyType as string | null) ?? null,
        }
      : null,
    stated: Object.fromEntries(
      Object.entries((v.stated ?? {}) as Record<string, unknown>).map(([k, value]) => [
        k,
        value === null || value === undefined ? null : BigInt(String(value)),
      ]),
    ),
    readyForReview: v.readyForReview === true,
  };
}

export interface ReviewView {
  extractionId: string;
  documentId: string;
  status: string;
  failureReason: string | null;
  provider: string;
  model: string;
  promptVersion: string;
  createdAt: string;
  document: {
    originalFilename: string;
    mimeType: string;
    byteSize: string;
    status: string;
  };
  extracted: ExtractedDocument | null;
  validation: StoredValidation | null;
  /** What a previous save settled on, so a part-finished review resumes. */
  reviewed: unknown;
  voucherId: string | null;
  /** The supplier this looks like, if we can tell from the GSTIN. */
  suggestedParty: { id: string; name: string; gstin: string | null; matchedOn: string } | null;
  parties: { id: string; name: string; gstin: string | null; stateCode: string | null }[];
  company: { stateCode: string | null };
  lockedUpto: string | null;
  /** Whether a duplicate of this bill is already entered. */
  duplicate: { voucherNo: string; voucherDate: string } | null;
}

/**
 * Everything the review screen needs, in one round trip.
 *
 * The duplicate check runs here as well as at approval. At approval it is a refusal
 * backed by a unique index; here it is a warning shown before the reviewer spends
 * two minutes checking a bill that is already in the books.
 */
export async function getExtractionForReview(
  ctx: RequestContext,
  extractionId: string,
): Promise<ReviewView> {
  if (!can(ctx.role, 'document:read')) throw forbidden('review a document');

  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const row = await getExtraction(tx, extractionId);
    const extracted = (row.extracted ?? null) as ExtractedDocument | null;

    const { rows: partyRows } = await tx.execute<{
      id: string;
      name: string;
      gstin: string | null;
      state_code: string | null;
    }>(sql`
      select id, name, gstin, state_code from parties
       where is_active and kind in ('supplier', 'both')
       order by name
       limit 500
    `);

    const { rows: companyRows } = await tx.execute<{ state_code: string | null }>(sql`
      select state_code from organizations limit 1
    `);

    const suggested = extracted
      ? await suggestParty(tx, {
          gstin: extracted.supplierGstin.value,
          name: extracted.supplierName.value,
        })
      : null;

    // The same bill already entered. Shown before the review rather than after it.
    let duplicate: { voucherNo: string; voucherDate: string } | null = null;
    const invoiceNo = extracted?.invoiceNumber.value ?? null;
    if (suggested && invoiceNo) {
      const { rows } = await tx.execute<{ voucher_no: string; voucher_date: string }>(sql`
        select voucher_no, voucher_date::text as voucher_date
          from vouchers
         where party_id = ${suggested.id}::uuid
           and upper(supplier_invoice_no) = upper(${invoiceNo})
           and voucher_type in ('purchase', 'debit_note')
           and status = 'posted'
         limit 1
      `);
      const found = rows[0];
      if (found) duplicate = { voucherNo: found.voucher_no, voucherDate: found.voucher_date };
    }

    return {
      extractionId: row.id,
      documentId: row.documentId,
      status: row.status,
      failureReason: row.failureReason,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      createdAt: row.createdAt,
      document: {
        originalFilename: row.document.originalFilename,
        mimeType: row.document.mimeType,
        byteSize: row.document.byteSize,
        status: row.document.status,
      },
      extracted,
      validation: reviveValidation(row.validation),
      reviewed: row.reviewed,
      voucherId: row.voucherId,
      suggestedParty: suggested,
      parties: partyRows.map((p) => ({
        id: p.id,
        name: p.name,
        gstin: p.gstin,
        stateCode: p.state_code,
      })),
      company: { stateCode: companyRows[0]?.state_code ?? null },
      lockedUpto: await lockedUpto(tx),
      duplicate,
    };
  });
}

/** Whether the AI reader is configured at all, for the page to say so once. */
export function extractionConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export type { ValidationResult };
