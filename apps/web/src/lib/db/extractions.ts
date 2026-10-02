import { sql } from 'drizzle-orm';
import type { Tx } from './tenant';
import type { ExtractedDocument } from '@/lib/ai/contract';
import type { ValidationResult } from '@/lib/ai/validate';
import { notFound } from '@/lib/errors';

/**
 * Storing what a model said, and what happened next.
 *
 * Every read and write here runs inside a tenant transaction, so row-level
 * security confines it to one company without this code naming an organization.
 */

/** Statuses a live extraction can hold — one per document at a time. */
const LIVE_STATUSES = ['pending', 'succeeded', 'reviewed'] as const;

export interface StoreExtractionInput {
  documentId: string;
  provider: string;
  model: string;
  promptVersion: string;
  status: 'succeeded' | 'failed';
  extracted?: ExtractedDocument | null;
  rawResponse?: unknown;
  validation?: ValidationResult | null;
  failureReason?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * A new extraction for a document, superseding whatever was there.
 *
 * Re-reading a document after a prompt change must not leave two live rows: two
 * reviewers would each see one and the bill would be approved twice. The old row
 * is marked superseded rather than deleted, because what the previous model said is
 * part of how the figure that reached the ledger came about.
 */
export async function storeExtraction(tx: Tx, input: StoreExtractionInput): Promise<string> {
  await tx.execute(sql`
    update document_extractions
       set status = 'rejected',
           failure_reason = coalesce(failure_reason, 'Superseded by a later reading'),
           reviewed_at = coalesce(reviewed_at, now())
     where document_id = ${input.documentId}::uuid
       and status = any(${sql.param([...LIVE_STATUSES])}::text[])
  `);

  const { rows } = await tx.execute<{ id: string }>(sql`
    insert into document_extractions (
      org_id, document_id, provider, model, prompt_version, status,
      failure_reason, extracted, raw_response, validation, input_tokens, output_tokens
    ) values (
      app_current_org_id(), ${input.documentId}::uuid, ${input.provider}, ${input.model},
      ${input.promptVersion}, ${input.status}, ${input.failureReason ?? null},
      ${input.extracted ? JSON.stringify(input.extracted) : null}::jsonb,
      ${input.rawResponse === undefined ? null : JSON.stringify(input.rawResponse)}::jsonb,
      ${input.validation ? JSON.stringify(input.validation, bigintToString) : null}::jsonb,
      ${input.usage?.inputTokens ?? null}, ${input.usage?.outputTokens ?? null}
    ) returning id
  `);

  const row = rows[0];
  if (!row) throw new Error('Extraction insert returned no row');

  await tx.execute(sql`
    update documents
       set status = ${input.status === 'succeeded' ? 'needs_review' : 'stored'}
     where id = ${input.documentId}::uuid
  `);

  return row.id;
}

/**
 * A validation result holds bigints, which `JSON.stringify` refuses.
 *
 * They go out as their exact integer of paise, as a string, which is how every
 * other amount leaves this codebase: a float would defeat having computed them
 * exactly, and dividing by 100 here would make the stored shape differ from the
 * in-memory one for no gain.
 */
function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export interface ExtractionRow {
  id: string;
  documentId: string;
  provider: string;
  model: string;
  promptVersion: string;
  status: string;
  failureReason: string | null;
  extracted: unknown;
  validation: unknown;
  reviewed: unknown;
  reviewedBy: string | null;
  reviewedAt: string | null;
  voucherId: string | null;
  createdAt: string;
  /** The document it belongs to, for the review screen. */
  document: {
    originalFilename: string;
    mimeType: string;
    byteSize: string;
    declaredType: string | null;
    declaredLabel: string | null;
    status: string;
  };
}

export async function getExtraction(tx: Tx, id: string): Promise<ExtractionRow> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    select e.id, e.document_id, e.provider, e.model, e.prompt_version, e.status,
           e.failure_reason, e.extracted, e.validation, e.reviewed,
           e.reviewed_by::text as reviewed_by, e.reviewed_at::text as reviewed_at,
           e.voucher_id::text as voucher_id, e.created_at::text as created_at,
           d.original_filename, d.mime_type, d.byte_size::text as byte_size,
           d.declared_type, d.declared_label, d.status as document_status
      from document_extractions e
      join documents d on d.id = e.document_id
     where e.id = ${id}::uuid
  `);

  const row = rows[0];
  // The same answer as an id that does not exist: a 403 would confirm that some
  // other company holds it.
  if (!row) throw notFound('That extraction does not exist.');
  return mapRow(row);
}

function mapRow(row: Record<string, unknown>): ExtractionRow {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    provider: String(row.provider),
    model: String(row.model),
    promptVersion: String(row.prompt_version),
    status: String(row.status),
    failureReason: (row.failure_reason as string | null) ?? null,
    extracted: row.extracted ?? null,
    validation: row.validation ?? null,
    reviewed: row.reviewed ?? null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    voucherId: (row.voucher_id as string | null) ?? null,
    createdAt: String(row.created_at),
    document: {
      originalFilename: String(row.original_filename),
      mimeType: String(row.mime_type),
      byteSize: String(row.byte_size),
      declaredType: (row.declared_type as string | null) ?? null,
      declaredLabel: (row.declared_label as string | null) ?? null,
      status: String(row.document_status),
    },
  };
}

/** The inbox: every document, with its most recent reading if it has one. */
export async function listInbox(tx: Tx, limit = 50): Promise<InboxRow[]> {
  const { rows } = await tx.execute<Record<string, unknown>>(sql`
    select d.id as document_id, d.original_filename, d.mime_type,
           d.byte_size::text as byte_size, d.declared_type, d.declared_label,
           d.status as document_status,
           d.created_at::text as uploaded_at, d.linked_voucher_id::text as linked_voucher_id,
           e.id as extraction_id, e.status as extraction_status, e.failure_reason,
           e.extracted, e.validation, e.voucher_id::text as voucher_id,
           e.created_at::text as extracted_at,
           v.voucher_no, v.status as voucher_status
      from documents d
      left join lateral (
        select * from document_extractions x
         where x.document_id = d.id
         order by x.created_at desc
         limit 1
      ) e on true
      left join vouchers v on v.id = e.voucher_id
     order by d.created_at desc
     limit ${limit}
  `);

  return rows.map((row) => ({
    documentId: String(row.document_id),
    originalFilename: String(row.original_filename),
    mimeType: String(row.mime_type),
    byteSize: String(row.byte_size),
    declaredType: (row.declared_type as string | null) ?? null,
    declaredLabel: (row.declared_label as string | null) ?? null,
    documentStatus: String(row.document_status),
    uploadedAt: String(row.uploaded_at),
    extractionId: (row.extraction_id as string | null) ?? null,
    extractionStatus: (row.extraction_status as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    extracted: row.extracted ?? null,
    validation: row.validation ?? null,
    voucherId: (row.voucher_id as string | null) ?? null,
    voucherNo: (row.voucher_no as string | null) ?? null,
    voucherStatus: (row.voucher_status as string | null) ?? null,
    extractedAt: (row.extracted_at as string | null) ?? null,
  }));
}

export interface InboxRow {
  documentId: string;
  originalFilename: string;
  mimeType: string;
  byteSize: string;
  declaredType: string | null;
  declaredLabel: string | null;
  documentStatus: string;
  uploadedAt: string;
  extractionId: string | null;
  extractionStatus: string | null;
  failureReason: string | null;
  extracted: unknown;
  validation: unknown;
  voucherId: string | null;
  voucherNo: string | null;
  voucherStatus: string | null;
  extractedAt: string | null;
}

/** What the reviewer settled on, recorded against their name. */
export async function saveReview(
  tx: Tx,
  input: { extractionId: string; reviewed: unknown; userId: string },
): Promise<void> {
  const { rowCount } = await tx.execute(sql`
    update document_extractions
       set reviewed = ${JSON.stringify(input.reviewed)}::jsonb,
           reviewed_by = ${input.userId}::uuid,
           reviewed_at = now(),
           status = 'reviewed'
     where id = ${input.extractionId}::uuid
       and status in ('succeeded', 'reviewed')
  `);
  if (!rowCount) {
    throw notFound(
      'That extraction cannot be reviewed — it has already been approved, rejected, or it failed.',
    );
  }
}

/**
 * The approval, with the draft voucher it produced.
 *
 * The status moves to `approved` and the voucher is recorded, which the table's own
 * check constraint requires in that order: a `voucher_id` on a row nobody approved
 * is refused by the database, not merely avoided here.
 */
export async function markApproved(
  tx: Tx,
  input: { extractionId: string; voucherId: string; reviewed: unknown; userId: string },
): Promise<void> {
  const { rowCount } = await tx.execute(sql`
    update document_extractions
       set status = 'approved',
           voucher_id = ${input.voucherId}::uuid,
           reviewed = ${JSON.stringify(input.reviewed)}::jsonb,
           reviewed_by = ${input.userId}::uuid,
           reviewed_at = now()
     where id = ${input.extractionId}::uuid
       and status in ('succeeded', 'reviewed')
  `);
  if (!rowCount) {
    throw notFound('That extraction has already been approved or rejected.');
  }
}

export async function markRejected(
  tx: Tx,
  input: { extractionId: string; reason: string; userId: string },
): Promise<string> {
  const { rows } = await tx.execute<{ document_id: string }>(sql`
    update document_extractions
       set status = 'rejected',
           failure_reason = ${input.reason},
           reviewed_by = ${input.userId}::uuid,
           reviewed_at = now()
     where id = ${input.extractionId}::uuid
       and status in ('succeeded', 'reviewed', 'failed')
     returning document_id
  `);

  const row = rows[0];
  if (!row) throw notFound('That extraction has already been approved or rejected.');

  await tx.execute(sql`
    update documents set status = 'rejected' where id = ${row.document_id}::uuid
  `);
  return row.document_id;
}

/**
 * Which party a document's supplier is, if we can tell.
 *
 * GSTIN first, because it identifies a business exactly. The name is only ever a
 * suggestion: two suppliers called "Sri Lakshmi Traders" are common, and picking
 * one by name would put a bill on the wrong account. An exact, single name match is
 * offered; anything less is left to the reviewer.
 */
export async function suggestParty(
  tx: Tx,
  input: { gstin?: string | null; name?: string | null },
): Promise<{ id: string; name: string; gstin: string | null; matchedOn: 'gstin' | 'name' } | null> {
  if (input.gstin) {
    const { rows } = await tx.execute<{ id: string; name: string; gstin: string | null }>(sql`
      select id, name, gstin from parties
       where upper(gstin) = ${input.gstin.toUpperCase()} and is_active
       limit 1
    `);
    const row = rows[0];
    if (row) return { ...row, matchedOn: 'gstin' };
  }

  if (input.name) {
    const { rows } = await tx.execute<{ id: string; name: string; gstin: string | null }>(sql`
      select id, name, gstin from parties
       where lower(name) = lower(${input.name}) and is_active
       limit 2
    `);
    // Two parties of the same name means the name does not identify one.
    if (rows.length === 1 && rows[0]) return { ...rows[0], matchedOn: 'name' };
  }

  return null;
}
