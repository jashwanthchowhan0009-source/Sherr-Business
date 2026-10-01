import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import {
  getExtraction,
  listInbox,
  markApproved,
  markRejected,
  saveReview,
  storeExtraction,
  suggestParty,
} from '../../src/lib/db/extractions';
import { enterPurchaseBill } from '../../src/lib/db/purchase-bill';
import { parseExtractedDocument } from '../../src/lib/ai/parse';
import { validateExtraction } from '../../src/lib/ai/validate';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import { getTrialBalance } from '../../src/server/reports';
import { cleanup, expectDbRejection, ownerPool, seedTwoOrgs, type Fixture } from './_db';
import type { RequestContext } from '../../src/lib/auth/context';

/**
 * The AI inbox, end to end against a real database.
 *
 * The provider is not involved: these tests feed the parser a reply and then drive
 * everything after it. What matters here is what the database allows — the model is
 * tested separately, and no test that depends on a network tells you anything about
 * your own constraints.
 *
 * The assertion the whole step rests on is that approving produces a **draft**.
 */
describe('document inbox', () => {
  let owner: Pool;
  let fx: Fixture;
  let ctx: RequestContext;
  let partyId: string;

  /** A supplier in Karnataka, the same state the fixture company is in. */
  const SUPPLIER_GSTIN = '29AABCS1234A1ZX';

  const reply = (over: Record<string, unknown> = {}) => ({
    kind: 'purchase_invoice',
    supplierName: { value: 'Sunrise Traders', confidence: 0.96 },
    supplierGstin: { value: SUPPLIER_GSTIN, confidence: 0.94 },
    supplierStateCode: { value: '29', confidence: 0.94 },
    buyerName: { value: 'Test Org A', confidence: 0.9 },
    placeOfSupplyStateCode: { value: '29', confidence: 0.9 },
    invoiceNumber: { value: 'ST/2025-26/0101', confidence: 0.95 },
    invoiceDate: { value: '12/06/2025', confidence: 0.93 },
    lines: [
      {
        description: { value: 'Steel fittings', confidence: 0.95 },
        hsnSac: { value: '7307', confidence: 0.9 },
        quantity: { value: '20', confidence: 0.9 },
        unit: { value: 'NOS', confidence: 0.9 },
        rate: { value: '5000', confidence: 0.9 },
        taxableAmount: { value: '100000', confidence: 0.95 },
        gstRatePercent: { value: '18', confidence: 0.95 },
      },
    ],
    statedTaxableTotal: { value: '100000', confidence: 0.95 },
    statedCgst: { value: '9000', confidence: 0.95 },
    statedSgst: { value: '9000', confidence: 0.95 },
    statedGrandTotal: { value: '118000', confidence: 0.96 },
    ...over,
  });

  /** A stored document, since an extraction must hang off one. */
  const storeDocument = async (orgId: string, filename: string) =>
    withTenant({ orgId, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into documents (org_id, storage_key, original_filename, mime_type,
                                byte_size, content_hash, declared_type)
        values (app_current_org_id(), ${`${orgId}/${filename}`}, ${filename},
                'application/pdf', 1024, ${filename}, 'purchase bill')
        returning id
      `);
      return rows[0]!.id;
    });

  const storeFor = async (documentId: string, over: Record<string, unknown> = {}) => {
    const extracted = parseExtractedDocument(reply(over));
    const validation = validateExtraction(extracted, { today: '2025-07-15' });
    return withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
      storeExtraction(tx, {
        documentId,
        provider: 'test-provider',
        model: 'test-model',
        promptVersion: 'v1',
        status: 'succeeded',
        extracted,
        rawResponse: { candidates: [] },
        validation,
      }),
    );
  };

  const reviewed = (over: Record<string, unknown> = {}) => ({
    partyId,
    voucherDate: '2025-06-12',
    supplierInvoiceNo: 'ST/2025-26/0101',
    supplierInvoiceDate: '2025-06-12',
    placeOfSupplyStateCode: '29',
    narration: null,
    lines: [
      {
        description: 'Steel fittings',
        hsnSac: '7307',
        unit: 'NOS',
        quantity: '20',
        unitPriceRupees: '5000',
        discountRupees: '0',
        gstRateBps: 1800,
        cessRateBps: 0,
        reverseCharge: false,
      },
    ],
    ...over,
  });

  const approve = async (extractionId: string, invoiceNo = 'ST/2025-26/0101') =>
    withTenant({ orgId: fx.orgA, userId: fx.userA }, async (tx) => {
      const created = await enterPurchaseBill(tx, {
        partyId,
        voucherDate: '2025-06-12',
        supplierInvoiceNo: invoiceNo,
        supplierInvoiceDate: '2025-06-12',
        placeOfSupplyStateCode: '29',
        lines: [
          {
            itemId: null,
            description: 'Steel fittings',
            hsnSac: '7307',
            unit: 'NOS',
            quantity: 20n * QTY_SCALE,
            unitPricePaise: 5_000_00n,
            discountPaise: 0n,
            gstRateBps: 1800,
            cessRateBps: 0,
            reverseCharge: false,
          },
        ],
        post: false,
        userId: fx.userA,
      });
      await markApproved(tx, {
        extractionId,
        voucherId: created.id,
        reviewed: reviewed(),
        userId: fx.userA,
      });
      return created;
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `inbox_${Date.now().toString(36)}`);
    ctx = { orgId: fx.orgA, userId: fx.userA, role: 'owner' } as RequestContext;

    partyId = await withTenant({ orgId: fx.orgA, userId: fx.userA }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, name, gstin, state_code, place_of_supply_state_code)
        values (app_current_org_id(), 'supplier', 'Sunrise Traders', ${SUPPLIER_GSTIN}, '29', '29')
        returning id
      `);
      return rows[0]!.id;
    });
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  describe('storing a reading', () => {
    it('keeps what the model said, our checks, and the raw reply', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-one.pdf');
      const id = await storeFor(documentId);

      const row = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        getExtraction(tx, id),
      );

      expect(row.status).toBe('succeeded');
      expect(row.provider).toBe('test-provider');
      expect(row.promptVersion).toBe('v1');
      expect((row.extracted as { kind: string }).kind).toBe('purchase_invoice');
      expect(row.validation).not.toBeNull();
      expect(row.reviewed).toBeNull();
      expect(row.voucherId).toBeNull();
    });

    it('stores our computed totals as exact integers, not as floats', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-exact.pdf');
      const id = await storeFor(documentId);
      const row = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        getExtraction(tx, id),
      );

      const computed = (row.validation as { computed: Record<string, string> }).computed;
      // ₹9,000 of CGST on ₹1,00,000 at 18%, as a string of paise.
      expect(computed.cgstPaise).toBe('900000');
      expect(computed.totalPaise).toBe('11800000');
      expect(computed.cgstPaise).not.toContain('.');
    });

    it('moves the document to needs_review, which is the only route to a voucher', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-status.pdf');
      await storeFor(documentId);

      const { rows } = await owner.query<{ status: string }>(
        'select status from documents where id = $1',
        [documentId],
      );
      expect(rows[0]!.status).toBe('needs_review');
    });

    it('supersedes the previous reading rather than leaving two live', async () => {
      // Two live rows would mean two reviewers each seeing one, and the bill
      // approved twice.
      const documentId = await storeDocument(fx.orgA, 'bill-twice.pdf');
      const first = await storeFor(documentId);
      const second = await storeFor(documentId);

      expect(second).not.toBe(first);
      const { rows } = await owner.query<{ id: string; status: string }>(
        'select id, status from document_extractions where document_id = $1 order by created_at',
        [documentId],
      );
      expect(rows.map((r) => r.status)).toEqual(['rejected', 'succeeded']);
      expect(rows[0]!.id).toBe(first);
    });

    it('records a failure as a failure, with its reason', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-failed.pdf');
      const id = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        storeExtraction(tx, {
          documentId,
          provider: 'test-provider',
          model: 'test-model',
          promptVersion: 'v1',
          status: 'failed',
          failureReason: 'The model did not return JSON.',
        }),
      );

      const row = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        getExtraction(tx, id),
      );
      expect(row.status).toBe('failed');
      expect(row.failureReason).toContain('did not return JSON');
      // The document goes back to 'stored', not to needs_review: there is nothing
      // to review, and leaving it as unread is what shows it needs another go.
      expect(row.document.status).toBe('stored');
    });
  });

  describe('what the database refuses', () => {
    it('refuses a failed row with no reason', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-noreason.pdf');
      await expectDbRejection(
        owner.query(
          `insert into document_extractions (org_id, document_id, provider, model,
             prompt_version, status) values ($1, $2, 'p', 'm', 'v1', 'failed')`,
          [fx.orgA, documentId],
        ),
        /document_extractions_failure_check/,
      );
    });

    it('refuses a succeeded row with nothing in it', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-empty.pdf');
      await expectDbRejection(
        owner.query(
          `insert into document_extractions (org_id, document_id, provider, model,
             prompt_version, status) values ($1, $2, 'p', 'm', 'v1', 'succeeded')`,
          [fx.orgA, documentId],
        ),
        /document_extractions_extracted_check/,
      );
    });

    it('refuses an approval with nobody’s name on it', async () => {
      // An approval the audit trail cannot attribute is not an approval.
      const documentId = await storeDocument(fx.orgA, 'bill-anon.pdf');
      await expectDbRejection(
        owner.query(
          `insert into document_extractions (org_id, document_id, provider, model,
             prompt_version, status, extracted)
           values ($1, $2, 'p', 'm', 'v1', 'approved', '{}'::jsonb)`,
          [fx.orgA, documentId],
        ),
        /document_extractions_reviewer_check/,
      );
    });

    it('refuses a voucher hanging off a row nobody approved', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-voucherless.pdf');
      const id = await storeFor(documentId);
      await expectDbRejection(
        owner.query(
          `update document_extractions set voucher_id = gen_random_uuid() where id = $1`,
          [id],
        ),
        /document_extractions_voucher_check/,
      );
    });

    it('refuses two live readings of one document', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-concurrent.pdf');
      await storeFor(documentId);
      await expectDbRejection(
        owner.query(
          `insert into document_extractions (org_id, document_id, provider, model,
             prompt_version, status, extracted)
           values ($1, $2, 'p', 'm', 'v1', 'succeeded', '{}'::jsonb)`,
          [fx.orgA, documentId],
        ),
        /document_extractions_one_pending/,
      );
    });
  });

  describe('reviewing', () => {
    it('records who reviewed it and what they settled on', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-review.pdf');
      const id = await storeFor(documentId);

      await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        saveReview(tx, { extractionId: id, reviewed: reviewed(), userId: fx.userA }),
      );

      const row = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        getExtraction(tx, id),
      );
      expect(row.status).toBe('reviewed');
      expect(row.reviewedBy).toBe(fx.userA);
      expect(row.reviewedAt).not.toBeNull();
      expect((row.reviewed as { supplierInvoiceNo: string }).supplierInvoiceNo).toBe(
        'ST/2025-26/0101',
      );
    });

    it('refuses to review a reading that already failed', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-failed-review.pdf');
      const id = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        storeExtraction(tx, {
          documentId,
          provider: 'p',
          model: 'm',
          promptVersion: 'v1',
          status: 'failed',
          failureReason: 'no JSON',
        }),
      );

      await expect(
        withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
          saveReview(tx, { extractionId: id, reviewed: reviewed(), userId: fx.userA }),
        ),
      ).rejects.toThrow(/cannot be reviewed/);
    });
  });

  describe('approving', () => {
    it('produces a DRAFT voucher, never a posting', async () => {
      // The guarantee the whole step rests on.
      const documentId = await storeDocument(fx.orgA, 'bill-approve.pdf');
      const id = await storeFor(documentId);
      const created = await approve(id, 'ST/2025-26/0201');

      const { rows } = await owner.query<{ status: string; total_paise: string }>(
        'select status, total_paise from vouchers where id = $1',
        [created.id],
      );
      expect(rows[0]!.status).toBe('draft');
      expect(rows[0]!.total_paise).toBe('11800000');
    });

    it('leaves the books untouched until somebody posts it', async () => {
      const before = await getTrialBalance(ctx, '2025-12-31');

      const documentId = await storeDocument(fx.orgA, 'bill-untouched.pdf');
      const id = await storeFor(documentId);
      await approve(id, 'ST/2025-26/0202');

      const after = await getTrialBalance(ctx, '2025-12-31');
      // Not one figure moves: a draft is not in the ledger.
      expect(after.totalDebitPaise).toBe(before.totalDebitPaise);
      expect(after.totalCreditPaise).toBe(before.totalCreditPaise);
    });

    it('ties the voucher back to the document it came from', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-linked.pdf');
      const id = await storeFor(documentId);
      const created = await withTenant({ orgId: fx.orgA, userId: fx.userA }, async (tx) => {
        const v = await enterPurchaseBill(tx, {
          partyId,
          voucherDate: '2025-06-12',
          supplierInvoiceNo: 'ST/2025-26/0203',
          supplierInvoiceDate: '2025-06-12',
          placeOfSupplyStateCode: '29',
          lines: [
            {
              itemId: null,
              description: 'Steel fittings',
              hsnSac: '7307',
              unit: 'NOS',
              quantity: 20n * QTY_SCALE,
              unitPricePaise: 5_000_00n,
              discountPaise: 0n,
              gstRateBps: 1800,
              cessRateBps: 0,
              reverseCharge: false,
            },
          ],
          post: false,
          sourceDocumentId: documentId,
          userId: fx.userA,
        });
        await markApproved(tx, {
          extractionId: id,
          voucherId: v.id,
          reviewed: reviewed(),
          userId: fx.userA,
        });
        return v;
      });

      const { rows } = await owner.query<{ source_document_id: string }>(
        'select source_document_id from vouchers where id = $1',
        [created.id],
      );
      expect(rows[0]!.source_document_id).toBe(documentId);
    });

    it('refuses to approve the same reading twice', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-twice-approve.pdf');
      const id = await storeFor(documentId);
      await approve(id, 'ST/2025-26/0204');

      await expect(
        withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
          markApproved(tx, {
            extractionId: id,
            voucherId: crypto.randomUUID(),
            reviewed: reviewed(),
            userId: fx.userA,
          }),
        ),
      ).rejects.toThrow(/already been approved or rejected/);
    });

    it('refuses a bill whose supplier invoice number is already posted', async () => {
      // The duplicate check is the same code the manual form uses, so the AI path
      // cannot get a second copy of a bill past it.
      const documentId = await storeDocument(fx.orgA, 'bill-dupe-a.pdf');
      const first = await storeFor(documentId);
      const created = await approve(first, 'ST/2025-26/0300');

      await owner.query(
        `update vouchers set status = 'posted' where id = $1`,
        [created.id],
      );

      const secondDoc = await storeDocument(fx.orgA, 'bill-dupe-b.pdf');
      const second = await storeFor(secondDoc);
      await expect(approve(second, 'ST/2025-26/0300')).rejects.toThrow(/paying it twice/);
    });
  });

  describe('rejecting', () => {
    it('records the reason and puts the document back as rejected', async () => {
      const documentId = await storeDocument(fx.orgA, 'bill-reject.pdf');
      const id = await storeFor(documentId);

      await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        markRejected(tx, { extractionId: id, reason: 'This is a delivery note, not a bill.', userId: fx.userA }),
      );

      const row = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        getExtraction(tx, id),
      );
      expect(row.status).toBe('rejected');
      expect(row.failureReason).toContain('delivery note');
      expect(row.document.status).toBe('rejected');
    });
  });

  describe('matching the supplier', () => {
    it('matches on GSTIN, which identifies a business exactly', async () => {
      const match = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        suggestParty(tx, { gstin: SUPPLIER_GSTIN, name: 'something else entirely' }),
      );
      expect(match?.id).toBe(partyId);
      expect(match?.matchedOn).toBe('gstin');
    });

    it('matches on an exact single name when there is no GSTIN', async () => {
      const match = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        suggestParty(tx, { gstin: null, name: 'sunrise traders' }),
      );
      expect(match?.id).toBe(partyId);
      expect(match?.matchedOn).toBe('name');
    });

    it('offers nothing when two suppliers share a name', async () => {
      // Picking one would put the bill on the wrong account.
      await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        tx.execute(sql`
          insert into parties (org_id, kind, name, state_code)
          values (app_current_org_id(), 'supplier', 'Sunrise Traders', '27')
        `),
      );

      const match = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        suggestParty(tx, { gstin: null, name: 'Sunrise Traders' }),
      );
      expect(match).toBeNull();
    });

    it('offers nothing rather than guessing from a partial name', async () => {
      const match = await withTenant({ orgId: fx.orgA, userId: fx.userA }, (tx) =>
        suggestParty(tx, { gstin: null, name: 'Sunrise' }),
      );
      expect(match).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it('shows another company nothing in the inbox', async () => {
      await storeFor(await storeDocument(fx.orgA, 'bill-private.pdf'));

      const theirs = await withTenant({ orgId: fx.orgB, userId: fx.userB }, (tx) =>
        listInbox(tx),
      );
      expect(theirs.every((r) => !r.originalFilename.includes('bill-private'))).toBe(true);
    });

    it('answers a cross-tenant extraction id as not found, not as forbidden', async () => {
      // A 403 would confirm that another company holds it.
      const id = await storeFor(await storeDocument(fx.orgA, 'bill-crosstenant.pdf'));
      await expect(
        withTenant({ orgId: fx.orgB, userId: fx.userB }, (tx) => getExtraction(tx, id)),
      ).rejects.toThrow(/does not exist/);
    });

    it('cannot match a supplier belonging to another company', async () => {
      const match = await withTenant({ orgId: fx.orgB, userId: fx.userB }, (tx) =>
        suggestParty(tx, { gstin: SUPPLIER_GSTIN, name: 'Sunrise Traders' }),
      );
      expect(match).toBeNull();
    });
  });
});
