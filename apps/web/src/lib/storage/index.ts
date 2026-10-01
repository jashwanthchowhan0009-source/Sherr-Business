import 'server-only';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Private document storage.
 *
 * Two drivers behind one interface. Vercel Blob in production, with
 * `access: 'private'` — the URL alone grants nothing, so a leaked link is not
 * a leaked document, and every read goes through our own route which checks
 * membership first. A local filesystem driver covers development and CI, where
 * no blob token exists and tests must still run.
 *
 * Nothing here decides who may read a file. That is the caller's job, and
 * `src/app/api/documents/[id]/route.ts` is the only place a stored object is
 * handed back to a browser.
 */

export interface StoredObject {
  /** Opaque key. Carries the org id as a prefix so a mis-scoped read is visible. */
  key: string;
  byteSize: number;
  /** SHA-256 of the bytes, hex. The duplicate gate, before anything is read. */
  contentHash: string;
}

export interface StorageDriver {
  readonly name: 'vercel-blob' | 'local';
  put(input: { key: string; bytes: Buffer; mimeType: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/** 10 MB. A scanned bill is well under this; a 200-page PDF is somebody's mistake. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * What the document inbox accepts. Deliberately a list rather than a wildcard:
 * the extraction step in step H will hand these to a model, and an unexpected
 * type there is a failure mode worth refusing at the door.
 */
export const ACCEPTED_MIME_TYPES = Object.freeze({
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'text/csv': '.csv',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
} as const);

export type AcceptedMimeType = keyof typeof ACCEPTED_MIME_TYPES;

export function isAcceptedMimeType(value: string): value is AcceptedMimeType {
  return Object.hasOwn(ACCEPTED_MIME_TYPES, value);
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Builds the storage key.
 *
 * The org id leads, so a key that does not match the reader's organization is
 * obvious rather than subtle. The random segment is what makes the key
 * unguessable; it is not relied upon for privacy, because the blob itself is
 * private, but it means two companies uploading `invoice.pdf` never collide.
 * The original filename is never part of the key: it is attacker-controlled
 * text and belongs in a column, not in a path.
 */
export function buildStorageKey(input: { orgId: string; mimeType: AcceptedMimeType }): string {
  return `documents/${input.orgId}/${randomUUID()}${ACCEPTED_MIME_TYPES[input.mimeType]}`;
}

let cached: StorageDriver | null = null;

export async function storage(): Promise<StorageDriver> {
  if (cached) return cached;
  cached = process.env.BLOB_READ_WRITE_TOKEN
    ? (await import('./vercel-blob')).vercelBlobDriver()
    : (await import('./local')).localDriver();
  return cached;
}

/** Test seam. Resets the memoised driver so a suite can switch drivers. */
export function resetStorageDriver(): void {
  cached = null;
}
