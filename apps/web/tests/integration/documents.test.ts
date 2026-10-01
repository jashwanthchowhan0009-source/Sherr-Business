import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  buildStorageKey,
  hashBytes,
  isAcceptedMimeType,
  storage,
} from '../../src/lib/storage';
import { cleanup, expectDbRejection, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * Document storage: the key shape, the duplicate gate and tenant isolation.
 *
 * Runs against the local filesystem driver, which is what CI and development
 * use. The Vercel Blob driver shares the same interface and the same key, so
 * what is asserted here about scoping and duplicates holds for both.
 */
describe('document storage', () => {
  let owner: Pool;
  let fx: Fixture;

  const store = async (
    orgId: string,
    input: { filename: string; mime: string; bytes: Buffer; declaredType?: string },
  ) =>
    withTenant({ orgId, userId: null }, async (tx) => {
      const contentHash = hashBytes(input.bytes);
      const key = buildStorageKey({
        orgId,
        mimeType: input.mime as keyof typeof ACCEPTED_MIME_TYPES,
      });
      await (await storage()).put({ key, bytes: input.bytes, mimeType: input.mime });
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into documents (
          org_id, storage_key, original_filename, mime_type, byte_size, content_hash, declared_type
        ) values (
          app_current_org_id(), ${key}, ${input.filename}, ${input.mime},
          ${input.bytes.byteLength}, ${contentHash}, ${input.declaredType ?? null}
        ) returning id
      `);
      return { id: rows[0]!.id, key, contentHash };
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `doc${Date.now()}`);
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  describe('accepted types', () => {
    it('accepts the formats a bill actually arrives as', () => {
      for (const mime of ['application/pdf', 'image/jpeg', 'image/png', 'text/csv']) {
        expect(isAcceptedMimeType(mime), mime).toBe(true);
      }
    });

    it('refuses anything else, including an empty type', () => {
      for (const mime of ['', 'text/html', 'image/svg+xml', 'application/zip', 'application/x-msdownload']) {
        expect(isAcceptedMimeType(mime), mime).toBe(false);
      }
    });

    // An SVG renders as a document but executes as HTML. It is refused at the
    // door rather than relied on being served with the right headers.
    it('refuses SVG specifically', () => {
      expect(isAcceptedMimeType('image/svg+xml')).toBe(false);
    });
  });

  describe('storage keys', () => {
    it('scopes the key to the organization', () => {
      const key = buildStorageKey({ orgId: fx.orgA, mimeType: 'application/pdf' });
      expect(key.startsWith(`documents/${fx.orgA}/`)).toBe(true);
      expect(key.endsWith('.pdf')).toBe(true);
    });

    it('never puts the uploaded filename in the path', () => {
      // The filename is attacker-controlled; a path built from it is a
      // traversal waiting to happen.
      const key = buildStorageKey({ orgId: fx.orgA, mimeType: 'application/pdf' });
      expect(key).not.toContain('..');
      expect(key.split('/')).toHaveLength(3);
    });

    it('gives two uploads of the same name different keys', () => {
      const a = buildStorageKey({ orgId: fx.orgA, mimeType: 'application/pdf' });
      const b = buildStorageKey({ orgId: fx.orgA, mimeType: 'application/pdf' });
      expect(a).not.toBe(b);
    });

    it('refuses a key that would escape the local store', async () => {
      const driver = await storage();
      if (driver.name !== 'local') return;
      await expect(
        driver.put({ key: '../../escaped.pdf', bytes: Buffer.from('x'), mimeType: 'application/pdf' }),
      ).rejects.toThrow(/escapes the store/);
    });
  });

  describe('round trip', () => {
    it('stores bytes and reads back exactly what went in', async () => {
      const bytes = Buffer.from('%PDF-1.7\nmock invoice bytes\n%%EOF');
      const { key } = await store(fx.orgA, {
        filename: 'invoice.pdf',
        mime: 'application/pdf',
        bytes,
      });
      const read = await (await storage()).get(key);
      expect(read.equals(bytes)).toBe(true);
    });

    it('records the SHA-256 of the bytes', async () => {
      const bytes = Buffer.from('deterministic content');
      const { contentHash } = await store(fx.orgA, {
        filename: 'a.pdf',
        mime: 'application/pdf',
        bytes,
      });
      // Recomputed independently, not read back from the same helper.
      expect(contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    });
  });

  describe('the duplicate gate', () => {
    it('refuses the same bytes twice in one company', async () => {
      const bytes = Buffer.from('a forwarded bill that arrives twice');
      await store(fx.orgA, { filename: 'bill.pdf', mime: 'application/pdf', bytes });

      await expectDbRejection(
        store(fx.orgA, { filename: 'bill-again.pdf', mime: 'application/pdf', bytes }),
        /documents_org_hash_key|duplicate key/i,
      );
    });

    it('lets two companies hold the same bytes independently', async () => {
      // Two customers of the same supplier legitimately hold the same PDF.
      const bytes = Buffer.from('a bill from a shared supplier');
      const a = await store(fx.orgA, { filename: 'shared.pdf', mime: 'application/pdf', bytes });
      const b = await store(fx.orgB, { filename: 'shared.pdf', mime: 'application/pdf', bytes });
      expect(a.contentHash).toBe(b.contentHash);
      expect(a.id).not.toBe(b.id);
      expect(a.key).not.toBe(b.key);
    });
  });

  describe('isolation', () => {
    it('hides one company’s documents from another', async () => {
      const { id } = await store(fx.orgA, {
        filename: 'private.pdf',
        mime: 'application/pdf',
        bytes: Buffer.from('org A only'),
      });

      const seen = await withTenant({ orgId: fx.orgB, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ n: string }>(sql`
          select count(*)::text as n from documents where id = ${id}::uuid
        `);
        return Number(rows[0]!.n);
      });
      expect(seen).toBe(0);
    });

    it('refuses to link a document to another company’s voucher', async () => {
      const foreignVoucher = await withTenant({ orgId: fx.orgB, userId: null }, async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into vouchers (org_id, voucher_type, voucher_no, fy_label, voucher_date)
          values (app_current_org_id(), 'journal', 'DOCX/1', '25-26', current_date)
          returning id
        `);
        return rows[0]!.id;
      });

      const { id } = await store(fx.orgA, {
        filename: 'link.pdf',
        mime: 'application/pdf',
        bytes: Buffer.from('cross tenant link attempt'),
      });

      await expectDbRejection(
        withTenant({ orgId: fx.orgA, userId: null }, (tx) =>
          tx.execute(sql`
            update documents set linked_voucher_id = ${foreignVoucher}::uuid
             where id = ${id}::uuid
          `),
        ),
        /violates foreign key constraint/i,
      );
    });
  });

  describe('limits', () => {
    it('caps uploads at 10 MB', () => {
      expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    });

    it('refuses a zero-byte file at the database', async () => {
      await expectDbRejection(
        store(fx.orgA, { filename: 'empty.pdf', mime: 'application/pdf', bytes: Buffer.alloc(0) }),
        /documents_size_check/i,
      );
    });
  });
});
