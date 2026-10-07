import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * Editing entries, end to end through the real server actions.
 *
 * A draft is rewritten under its own number. A posted voucher is never touched:
 * editing it reverses it and posts a replacement in one transaction, and
 * whatever was settled against the original follows it. These run against real
 * Postgres because every guarantee here is enforced there — the immutability
 * trigger, the duplicate-bill index, the deferred balance check.
 */
const context = vi.fn();
vi.mock('../../src/lib/auth/context', () => ({
  requireOrgContext: context,
  requireAccountContext: context,
}));
vi.mock('../../src/lib/auth/unlock', () => ({ screenUnlocked: async () => true }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const ledger = await import('../../src/server/ledger');
const purchases = await import('../../src/server/purchases');
const company = await import('../../src/server/company');
const banking = await import('../../src/server/banking');
const procurement = await import('../../src/server/procurement');

type Ok<T> = { ok: true; data: T };
function ok<T>(result: { ok: boolean; data?: T; error?: string }): T {
  if (!result.ok) throw new Error(`Action failed: ${result.error}`);
  return (result as Ok<T>).data;
}

describe('editing entries', () => {
  let owner: Pool;
  let fx: Fixture;
  let customerId: string;
  let otherCustomerId: string;
  let supplierId: string;
  let run = 0;

  const asRole = (role: string) =>
    context.mockResolvedValue({
      orgId: fx.orgA,
      userId: fx.userA,
      role,
      clerkUserId: 'test',
      clerkOrgId: 'test',
      ip: null,
      userAgent: 'vitest',
    });

  const voucher = async (id: string) =>
    (
      await owner.query<{
        voucher_no: string;
        status: string;
        total_paise: string;
        reversed_by_voucher_id: string | null;
        corrects_voucher_id: string | null;
        party_id: string | null;
        narration: string | null;
      }>(
        `select voucher_no, status, total_paise::text, reversed_by_voucher_id,
                corrects_voucher_id, party_id, narration
           from vouchers where id = $1`,
        [id],
      )
    ).rows[0];

  const allocatedTo = async (id: string) =>
    BigInt(
      (
        await owner.query<{ s: string }>(
          `select coalesce(sum(amount_paise), 0)::text as s
             from voucher_allocations where target_voucher_id = $1`,
          [id],
        )
      ).rows[0]!.s,
    );

  const ledgerDifference = async () =>
    BigInt(
      (
        await owner.query<{ d: string }>(
          `select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as d
             from ledger_entries l join vouchers v on v.id = l.voucher_id
            where v.org_id = $1 and v.status = 'posted'`,
          [fx.orgA],
        )
      ).rows[0]!.d,
    );

  const line = (rupees: string) => ({
    description: 'Consulting',
    hsnSac: '998311',
    unit: 'HRS',
    quantity: '1',
    unitPriceRupees: rupees,
    gstRateBps: 1800,
  });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `edits${Date.now().toString(36)}`);
    const party = async (kind: string, name: string) =>
      (
        await owner.query<{ id: string }>(
          `insert into parties (org_id, kind, name, state_code, place_of_supply_state_code)
           values ($1, $2, $3, '29', '29') returning id`,
          [fx.orgA, kind, name],
        )
      ).rows[0]!.id;
    customerId = await party('customer', 'Kaveri Retail');
    otherCustomerId = await party('customer', 'Tunga Stores');
    supplierId = await party('supplier', 'Hampi Supplies');
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  beforeEach(() => {
    run += 1;
    asRole('owner');
  });

  describe('a draft', () => {
    it('is rewritten under its own number and can then be posted', async () => {
      const draft = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-06-10',
          post: false,
          lines: [line('1000')],
        }),
      );

      const edited = ok(
        await ledger.editSalesInvoice({
          id: draft.id,
          data: {
            partyId: customerId,
            voucherDate: '2026-06-11',
            post: false,
            lines: [line('1000'), line('500')],
          },
        }),
      );
      expect(edited.mode).toBe('draft');
      expect(edited.voucherNo).toBe(draft.voucherNo);
      expect(await voucher(draft.id)).toBeUndefined();
      const rewritten = await voucher(edited.id);
      expect(rewritten?.status).toBe('draft');
      expect(BigInt(rewritten!.total_paise)).toBe(1_770_00n);

      const posted = ok(
        await ledger.editSalesInvoice({
          id: edited.id,
          data: {
            partyId: customerId,
            voucherDate: '2026-06-11',
            post: true,
            lines: [line('1000'), line('500')],
          },
        }),
      );
      expect(posted.voucherNo).toBe(draft.voucherNo);
      expect((await voucher(posted.id))?.status).toBe('posted');
      expect(await ledgerDifference()).toBe(0n);
    });
  });

  describe('a posted voucher', () => {
    it('needs a reason before it can be corrected', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-06-12',
          lines: [line('100')],
        }),
      );
      const result = await ledger.editSalesInvoice({
        id: invoice.id,
        data: { partyId: customerId, voucherDate: '2026-06-12', lines: [line('200')] },
      });
      expect(result.ok).toBe(false);
      expect((await voucher(invoice.id))?.reversed_by_voucher_id).toBeNull();
    });

    it('is reversed and replaced, and the money received follows it', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-06-15',
          lines: [line('10000')],
        }),
      );
      // ₹11,800 invoice; ₹5,000 received against it.
      const receipt = ok(
        await ledger.createReceipt({
          partyId: customerId,
          voucherDate: '2026-06-16',
          amountRupees: '5000',
          allocateToVoucherIds: [invoice.id],
        }),
      );
      expect(await allocatedTo(invoice.id)).toBe(5_000_00n);

      const edited = ok(
        await ledger.editSalesInvoice({
          id: invoice.id,
          reason: 'rate was wrong',
          data: { partyId: customerId, voucherDate: '2026-06-15', lines: [line('8000')] },
        }),
      );

      expect(edited.mode).toBe('posted');
      expect(edited.reversalVoucherNo).toBeTruthy();
      expect(edited.voucherNo).not.toBe(invoice.voucherNo);
      expect(edited.voucherNo).not.toBe(edited.reversalVoucherNo);

      const original = await voucher(invoice.id);
      expect(original?.status).toBe('posted');
      expect(original?.reversed_by_voucher_id).not.toBeNull();

      const replacement = await voucher(edited.id);
      expect(replacement?.status).toBe('posted');
      expect(replacement?.corrects_voucher_id).toBe(invoice.id);
      expect(BigInt(replacement!.total_paise)).toBe(9_440_00n);

      expect(await allocatedTo(invoice.id)).toBe(0n);
      expect(await allocatedTo(edited.id)).toBe(5_000_00n);
      expect(receipt.voucherNo).toMatch(/^RCT/);
      expect(await ledgerDifference()).toBe(0n);

      const audit = await owner.query<{ after: { reason: string } }>(
        `select after from audit_logs where org_id = $1 and action = 'voucher.corrected'
          and subject_id = $2`,
        [fx.orgA, edited.id],
      );
      expect(audit.rows[0]?.after.reason).toBe('rate was wrong');
    });

    it('caps carried settlements at the corrected total', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-06-20',
          lines: [line('1000')],
        }),
      );
      ok(
        await ledger.createReceipt({
          partyId: customerId,
          voucherDate: '2026-06-20',
          amountRupees: '1180',
          allocateToVoucherIds: [invoice.id],
        }),
      );
      const edited = ok(
        await ledger.editSalesInvoice({
          id: invoice.id,
          reason: 'discount agreed',
          data: { partyId: customerId, voucherDate: '2026-06-20', lines: [line('500')] },
        }),
      );
      expect(await allocatedTo(edited.id)).toBe(590_00n);
    });

    it('does not carry a settlement to a different customer', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-06-21',
          lines: [line('1000')],
        }),
      );
      ok(
        await ledger.createReceipt({
          partyId: customerId,
          voucherDate: '2026-06-21',
          amountRupees: '1180',
          allocateToVoucherIds: [invoice.id],
        }),
      );
      const edited = ok(
        await ledger.editSalesInvoice({
          id: invoice.id,
          reason: 'billed to the wrong customer',
          data: { partyId: otherCustomerId, voucherDate: '2026-06-21', lines: [line('1000')] },
        }),
      );
      expect(await allocatedTo(edited.id)).toBe(0n);
    });

    it('cannot be edited twice, and its reversal cannot be edited at all', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-06-22',
          lines: [line('100')],
        }),
      );
      const data = { partyId: customerId, voucherDate: '2026-06-22', lines: [line('120')] };
      ok(await ledger.editSalesInvoice({ id: invoice.id, reason: 'typo', data }));

      const again = await ledger.editSalesInvoice({ id: invoice.id, reason: 'typo', data });
      expect(again.ok).toBe(false);

      const { reversed_by_voucher_id } = (await voucher(invoice.id))!;
      const reversal = await ledger.editSalesInvoice({
        id: reversed_by_voucher_id!,
        reason: 'typo',
        data,
      });
      expect(reversal.ok).toBe(false);
    });

    it('refuses an edit sent to the wrong kind of form', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-06-23',
          lines: [line('100')],
        }),
      );
      const result = await purchases.editJournal({
        id: invoice.id,
        reason: 'wrong form',
        data: {
          voucherDate: '2026-06-23',
          narration: 'not a journal',
          lines: [
            { accountCode: 'CASH', debitRupees: '1' },
            { accountCode: 'BANK', creditRupees: '1' },
          ],
        },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('purchase bills', () => {
    it('re-enters the same supplier invoice number when correcting a posted bill', async () => {
      const ref = `HS/${run}`;
      const bill = ok(
        await purchases.createPurchaseBill({
          partyId: supplierId,
          voucherDate: '2026-06-25',
          supplierInvoiceNo: ref,
          supplierInvoiceDate: '2026-06-24',
          lines: [line('2000')],
        }),
      );
      const edited = ok(
        await purchases.editPurchaseBill({
          id: bill.id,
          reason: 'quantity was 2',
          data: {
            partyId: supplierId,
            voucherDate: '2026-06-25',
            supplierInvoiceNo: ref,
            supplierInvoiceDate: '2026-06-24',
            lines: [{ ...line('2000'), quantity: '2' }],
          },
        }),
      );
      expect(BigInt((await voucher(edited.id))!.total_paise)).toBe(4_720_00n);

      // The guard against paying a bill twice still holds for the live bill.
      const duplicate = await purchases.createPurchaseBill({
        partyId: supplierId,
        voucherDate: '2026-06-26',
        supplierInvoiceNo: ref,
        supplierInvoiceDate: '2026-06-24',
        lines: [line('2000')],
      });
      expect(duplicate.ok).toBe(false);
    });
  });

  describe('other vouchers', () => {
    it('corrects a receipt, releasing what the old one settled', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-07-01',
          lines: [line('1000')],
        }),
      );
      const receipt = ok(
        await ledger.createReceipt({
          partyId: customerId,
          voucherDate: '2026-07-02',
          amountRupees: '1180',
          allocateToVoucherIds: [invoice.id],
        }),
      );
      expect(await allocatedTo(invoice.id)).toBe(1_180_00n);

      ok(
        await ledger.editReceipt({
          id: receipt.id,
          reason: 'only half arrived',
          data: {
            partyId: customerId,
            voucherDate: '2026-07-02',
            amountRupees: '590',
            allocateToVoucherIds: [invoice.id],
          },
        }),
      );
      expect(await allocatedTo(invoice.id)).toBe(590_00n);
      expect(await ledgerDifference()).toBe(0n);
    });

    it('corrects a journal and a contra', async () => {
      const jv = ok(
        await purchases.createJournal({
          voucherDate: '2026-07-03',
          narration: 'Office rent',
          lines: [
            { accountCode: 'RENT', debitRupees: '15000' },
            { accountCode: 'BANK', creditRupees: '15000' },
          ],
        }),
      ).id;
      const editedJv = ok(
        await purchases.editJournal({
          id: jv,
          reason: 'rent is 16,000',
          data: {
            voucherDate: '2026-07-03',
            narration: 'Office rent',
            lines: [
              { accountCode: 'RENT', debitRupees: '16000' },
              { accountCode: 'BANK', creditRupees: '16000' },
            ],
          },
        }),
      );
      expect(BigInt((await voucher(editedJv.id))!.total_paise)).toBe(16_000_00n);

      const ctr = ok(
        await purchases.createContra({
          voucherDate: '2026-07-04',
          fromAccountCode: 'BANK',
          toAccountCode: 'CASH',
          amountRupees: '2000',
        }),
      ).id;
      const editedCtr = ok(
        await purchases.editContra({
          id: ctr,
          reason: 'withdrew 2,500',
          data: {
            voucherDate: '2026-07-04',
            fromAccountCode: 'BANK',
            toAccountCode: 'CASH',
            amountRupees: '2500',
          },
        }),
      );
      expect(BigInt((await voucher(editedCtr.id))!.total_paise)).toBe(2_500_00n);
      expect(await ledgerDifference()).toBe(0n);
    });
  });

  describe('plain reversal', () => {
    it('reopens the invoice a reversed receipt had cleared', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-07-05',
          lines: [line('1000')],
        }),
      );
      const receipt = ok(
        await ledger.createReceipt({
          partyId: customerId,
          voucherDate: '2026-07-05',
          amountRupees: '1180',
          allocateToVoucherIds: [invoice.id],
        }),
      );
      ok(await purchases.reverseVoucher({ id: receipt.id, reason: 'cheque bounced' }));
      expect(await allocatedTo(invoice.id)).toBe(0n);
    });
  });

  describe('roles', () => {
    it('refuses a viewer', async () => {
      const invoice = ok(
        await ledger.createSalesInvoice({
          partyId: customerId,
          voucherDate: '2026-07-06',
          lines: [line('100')],
        }),
      );
      asRole('viewer');
      const result = await ledger.editSalesInvoice({
        id: invoice.id,
        reason: 'not allowed',
        data: { partyId: customerId, voucherDate: '2026-07-06', lines: [line('200')] },
      });
      expect(result.ok).toBe(false);
      expect((await voucher(invoice.id))?.reversed_by_voucher_id).toBeNull();
    });
  });

  describe('master data', () => {
    it('edits a party and an item, and records both', async () => {
      ok(
        await ledger.updateParty({
          id: otherCustomerId,
          kind: 'both',
          name: 'Tunga Stores LLP',
          stateCode: '33',
          creditDays: 30,
        }),
      );
      const party = (
        await owner.query<{ name: string; kind: string; state_code: string; credit_days: number }>(
          'select name, kind, state_code, credit_days from parties where id = $1',
          [otherCustomerId],
        )
      ).rows[0];
      expect(party).toEqual({ name: 'Tunga Stores LLP', kind: 'both', state_code: '33', credit_days: 30 });

      const item = ok(
        await ledger.createItem({ name: `Widget ${run}`, unit: 'PCS', gstRateBps: 1200 }),
      );
      ok(
        await ledger.updateItem({
          id: item.id,
          name: `Widget ${run} v2`,
          unit: 'BOX',
          gstRateBps: 1800,
          salePriceRupees: '250',
        }),
      );
      const row = (
        await owner.query<{ name: string; unit: string; gst_rate_bps: number; sale_price_paise: string }>(
          'select name, unit, gst_rate_bps, sale_price_paise::text from items where id = $1',
          [item.id],
        )
      ).rows[0];
      expect(row).toEqual({
        name: `Widget ${run} v2`,
        unit: 'BOX',
        gst_rate_bps: 1800,
        sale_price_paise: '25000',
      });

      const audit = await owner.query<{ action: string }>(
        `select action from audit_logs where org_id = $1 and action in ('party.updated','item.updated')`,
        [fx.orgA],
      );
      expect(audit.rows.map((r) => r.action).sort()).toEqual(['item.updated', 'party.updated']);
    });
  });
  describe('more master data', () => {
    it('edits a registration, an account name, a bank account and an open order', async () => {
      const gstin = '29AAACK1234A1Z5';
      const reg = ok(await company.addRegistration({ kind: 'tan', number: `BLRK${run}234B`.slice(0, 10) }));
      ok(await company.updateRegistration({ id: reg.id!, kind: 'gstin', number: gstin }));
      const regRow = (
        await owner.query<{ kind: string; number: string; state_code: string }>(
          'select kind, number, state_code from org_registrations where id = $1',
          [reg.id],
        )
      ).rows[0];
      expect(regRow).toEqual({ kind: 'gstin', number: gstin, state_code: '29' });

      const rent = (
        await owner.query<{ id: string }>(
          `select id from accounts where org_id = $1 and code = 'RENT'`,
          [fx.orgA],
        )
      ).rows[0]!.id;
      ok(await company.updateAccount({ id: rent, name: 'Office rent', note: 'Head office lease' }));
      const acc = (
        await owner.query<{ code: string; name: string }>('select code, name from accounts where id = $1', [rent])
      ).rows[0];
      expect(acc).toEqual({ code: 'RENT', name: 'Office rent' });

      const bankLedger = (
        await owner.query<{ id: string }>(
          `select id from accounts where org_id = $1 and code = 'BANK'`,
          [fx.orgA],
        )
      ).rows[0]!.id;
      const bank = ok(
        await banking.addBankAccount({
          ledgerAccountId: bankLedger,
          bankName: 'Canara Bank',
          accountLabel: 'Current',
        }),
      );
      ok(
        await banking.updateBankAccount({
          id: bank.id,
          ledgerAccountId: bankLedger,
          bankName: 'Canara Bank',
          accountLabel: 'Collections',
          accountNumberLast4: '4417',
          ifsc: 'CNRB0001234',
        }),
      );
      const bankRow = (
        await owner.query<{ account_label: string; account_number_last4: string }>(
          'select account_label, account_number_last4 from bank_accounts where id = $1',
          [bank.id],
        )
      ).rows[0];
      expect(bankRow).toEqual({ account_label: 'Collections', account_number_last4: '4417' });

      const po = ok(
        await procurement.createPurchaseOrder({
          partyId: supplierId,
          poDate: '2026-07-10',
          lines: [{ description: 'Cartons', quantity: '100', unitPriceRupees: '12' }],
        }),
      );
      ok(
        await procurement.updatePurchaseOrder({
          id: po.id,
          partyId: supplierId,
          poDate: '2026-07-11',
          lines: [
            { description: 'Cartons', quantity: '150', unitPriceRupees: '12' },
            { description: 'Tape', quantity: '10', unitPriceRupees: '40' },
          ],
        }),
      );
      const order = (
        await owner.query<{ total_paise: string; lines: string }>(
          `select total_paise::text,
                  (select count(*) from purchase_order_lines where po_id = o.id)::text as lines
             from purchase_orders o where id = $1`,
          [po.id],
        )
      ).rows[0];
      expect(order).toEqual({ total_paise: '220000', lines: '2' });
    });
  });

  describe('rates must be chosen', () => {
    it('refuses a line whose GST rate was left empty, rather than reading it as nil', async () => {
      const result = await ledger.createSalesInvoice({
        partyId: customerId,
        voucherDate: '2026-07-12',
        lines: [{ ...line('100'), gstRateBps: '' }],
      });
      expect(result.ok).toBe(false);
    });
  });
});
