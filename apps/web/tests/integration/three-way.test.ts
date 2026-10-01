import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import { allocateVoucherNumber, createVoucher, postVoucher } from '../../src/lib/db/ledger';
import { calculateInvoice } from '../../src/lib/accounting/gst';
import { purchaseBillEntries } from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import { getThreeWayMatches } from '../../src/server/procurement-queries';
import { cleanup, expectDbRejection, ownerPool, seedTwoOrgs, type Fixture } from './_db';
import type { RequestContext } from '../../src/lib/auth/context';

/**
 * The three-way match against real data.
 *
 * The control: do not pay for goods nobody ordered, and do not pay for goods
 * nobody received. Each document is produced by a different party, so agreement
 * between all three is evidence and disagreement is a question to ask before
 * money leaves.
 */
describe('three-way match', () => {
  let owner: Pool;
  let fx: Fixture;
  let ctx: RequestContext;
  let supplier: string;
  let rice: string;

  const asContext = (orgId: string, userId: string): RequestContext =>
    ({ orgId, userId, role: 'owner', clerkUserId: 'test', ip: null, userAgent: null }) as unknown as RequestContext;

  const order = (input: { qty: bigint; pricePaise: bigint; itemId?: string | null }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string; po_no: string }>(sql`
        insert into purchase_orders (org_id, po_no, fy_label, po_date, party_id, total_paise)
        values (app_current_org_id(),
                'PO/25-26/' || lpad((
                  select coalesce(max(substring(po_no from '[0-9]+$')::int), 0) + 1
                    from purchase_orders)::text, 4, '0'),
                '25-26', '2025-06-01', ${supplier}::uuid, 0)
        returning id, po_no
      `);
      const poId = rows[0]!.id;
      await tx.execute(sql`
        insert into purchase_order_lines (org_id, po_id, line_no, item_id, description,
                                          quantity, unit, unit_price_paise)
        values (app_current_org_id(), ${poId}::uuid, 1,
                ${input.itemId === undefined ? rice : input.itemId}::uuid,
                'Basmati rice', ${input.qty * QTY_SCALE}, 'KGS', ${input.pricePaise})
      `);
      return { poId, poNo: rows[0]!.po_no };
    });

  const receipt = (poId: string, input: { qty: bigint; itemId?: string | null }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into goods_receipts (org_id, grn_no, fy_label, receipt_date, party_id, po_id, challan_no)
        values (app_current_org_id(),
                'GRN/25-26/' || lpad((
                  select coalesce(max(substring(grn_no from '[0-9]+$')::int), 0) + 1
                    from goods_receipts)::text, 4, '0'),
                '25-26', '2025-06-05', ${supplier}::uuid, ${poId}::uuid, 'DC-91')
        returning id
      `);
      const grnId = rows[0]!.id;
      await tx.execute(sql`
        insert into goods_receipt_lines (org_id, grn_id, line_no, item_id, description, quantity, unit)
        values (app_current_org_id(), ${grnId}::uuid, 1,
                ${input.itemId === undefined ? rice : input.itemId}::uuid,
                'Basmati rice', ${input.qty * QTY_SCALE}, 'KGS')
      `);
      return grnId;
    });

  const bill = (
    poId: string,
    grnId: string,
    input: { qty: bigint; pricePaise: bigint; ref: string; itemId?: string | null },
  ) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const lines = [
        {
          itemId: input.itemId === undefined ? rice : input.itemId,
          description: 'Basmati rice',
          hsnSac: '1006',
          unit: 'KGS',
          quantity: input.qty * QTY_SCALE,
          unitPricePaise: input.pricePaise,
          discountPaise: 0n,
          gstRateBps: 500,
          cessRateBps: 0,
          reverseCharge: false,
        },
      ];
      const calculation = calculateInvoice(lines, 'intra_state');
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'purchase',
        fyLabel: '25-26',
        prefix: 'BILL',
      });
      const created = await createVoucher(tx, {
        voucherType: 'purchase',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: '2025-06-10',
        partyId: supplier,
        supplierStateCode: '29',
        placeOfSupplyStateCode: '29',
        supplyType: 'intra_state',
        reference: input.ref,
        supplierInvoiceNo: input.ref,
        supplierInvoiceDate: '2025-06-10',
        narration: null,
        calculation,
        lines,
        entries: purchaseBillEntries(calculation),
      });
      await tx.execute(sql`
        update vouchers set po_id = ${poId}::uuid, grn_id = ${grnId}::uuid
         where id = ${created.id}::uuid
      `);
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return created;
    });

  const matchFor = async (poNo: string) => {
    const all = await getThreeWayMatches(ctx, 50);
    return all.find((m) => m.poNo === poNo)!;
  };

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `twm${Date.now()}`);
    ctx = asContext(fx.orgA, fx.userA);

    ({ supplier, rice } = await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const party = await tx.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, name, state_code) 
        values (app_current_org_id(), 'supplier', 'Kaveri Agro', '29') returning id
      `);
      const item = await tx.execute<{ id: string }>(sql`
        insert into items (org_id, name, hsn_sac, unit, gst_rate_bps)
        values (app_current_org_id(), 'Basmati rice', '1006', 'KGS', 500) returning id
      `);
      return { supplier: party.rows[0]!.id, rice: item.rows[0]!.id };
    }));
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  it('reports a clean match when all three agree', async () => {
    const { poId, poNo } = await order({ qty: 100n, pricePaise: 5_000_00n });
    const grnId = await receipt(poId, { qty: 100n });
    await bill(poId, grnId, { qty: 100n, pricePaise: 5_000_00n, ref: 'KAV/CLEAN' });

    const match = await matchFor(poNo);
    expect(match.result.matched).toBe(true);
    expect(match.overchargePaise).toBe(0n);
    expect(match.grnNumbers).toHaveLength(1);
    expect(match.billNumbers).toHaveLength(1);
  });

  it('catches being billed for more than arrived, and prices it', async () => {
    const { poId, poNo } = await order({ qty: 100n, pricePaise: 5_000_00n });
    const grnId = await receipt(poId, { qty: 90n });
    await bill(poId, grnId, { qty: 100n, pricePaise: 5_000_00n, ref: 'KAV/OVERBILL' });

    const match = await matchFor(poNo);
    expect(match.result.matched).toBe(false);
    expect(match.result.exceptions.map((e) => e.kind)).toContain('over_billed_quantity');
    // 10 kg billed but not received, at ₹5,000 = ₹50,000 we would overpay.
    expect(match.overchargePaise).toBe(50_000_00n);
  });

  it('catches a price above the one agreed', async () => {
    const { poId, poNo } = await order({ qty: 50n, pricePaise: 4_000_00n });
    const grnId = await receipt(poId, { qty: 50n });
    await bill(poId, grnId, { qty: 50n, pricePaise: 4_400_00n, ref: 'KAV/PRICE' });

    const match = await matchFor(poNo);
    expect(match.result.exceptions.map((e) => e.kind)).toContain('price_above_order');
    // ₹400 more on each of 50 = ₹20,000.
    expect(match.overchargePaise).toBe(20_000_00n);
  });

  it('catches a short delivery without calling it a cost', async () => {
    const { poId, poNo } = await order({ qty: 100n, pricePaise: 5_000_00n });
    const grnId = await receipt(poId, { qty: 80n });
    await bill(poId, grnId, { qty: 80n, pricePaise: 5_000_00n, ref: 'KAV/SHORT' });

    const match = await matchFor(poNo);
    expect(match.result.exceptions.map((e) => e.kind)).toContain('short_delivered');
    expect(match.overchargePaise).toBe(0n);
  });

  it('shows an order with nothing received yet as having no exceptions', async () => {
    const { poNo } = await order({ qty: 10n, pricePaise: 1_000_00n });
    const match = await matchFor(poNo);
    // Nothing is wrong; the goods simply have not arrived.
    expect(match.result.matched).toBe(true);
    expect(match.grnNumbers).toEqual([]);
    expect(match.billNumbers).toEqual([]);
  });

  it('excludes a reversed bill from the match', async () => {
    const { poId, poNo } = await order({ qty: 20n, pricePaise: 2_000_00n });
    const grnId = await receipt(poId, { qty: 20n });
    const billed = await bill(poId, grnId, { qty: 20n, pricePaise: 2_000_00n, ref: 'KAV/REV' });

    // Reverse it the way the application does.
    await withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: 'purchase',
        fyLabel: '25-26',
        prefix: 'REV',
      });
      const reversal = await createVoucher(tx, {
        voucherType: 'purchase',
        voucherNo,
        fyLabel: '25-26',
        voucherDate: '2025-06-20',
        partyId: supplier,
        supplierStateCode: null,
        placeOfSupplyStateCode: null,
        supplyType: null,
        reference: billed.voucherNo,
        narration: 'Reversal',
        calculation: null,
        lines: [],
        entries: [
          { accountCode: 'SUNDRY_CREDITORS', debitPaise: billed.totalPaise, creditPaise: 0n },
          { accountCode: 'PURCHASES', debitPaise: 0n, creditPaise: billed.totalPaise },
        ],
        totalPaise: billed.totalPaise,
        reversesVoucherId: billed.id,
      });
      await postVoucher(tx, { voucherId: reversal.id, userId: null });
      await tx.execute(sql`
        update vouchers set reversed_by_voucher_id = ${reversal.id}::uuid
         where id = ${billed.id}::uuid
      `);
    });

    const match = await matchFor(poNo);
    // The reversed bill no longer counts, so the order reads as unbilled.
    expect(match.billNumbers).toEqual([]);
  });

  it('refuses a goods receipt against another company’s order', async () => {
    const { poId } = await order({ qty: 5n, pricePaise: 100_00n });

    // Org B needs a supplier of its own, or the insert below would affect zero
    // rows and pass without ever testing the foreign key.
    const theirSupplier = await withTenant({ orgId: fx.orgB, userId: null }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, name, state_code)
        values (app_current_org_id(), 'supplier', 'Their Supplier', '27')
        returning id
      `);
      return rows[0]!.id;
    });

    await expectDbRejection(
      withTenant({ orgId: fx.orgB, userId: null }, (tx) =>
        tx.execute(sql`
          insert into goods_receipts (org_id, grn_no, fy_label, receipt_date, party_id, po_id)
          values (app_current_org_id(), 'GRN/X', '25-26', current_date,
                  ${theirSupplier}::uuid, ${poId}::uuid)
        `),
      ),
      /violates foreign key constraint/i,
    );
  });

  it('shows another company nothing', async () => {
    const other = asContext(fx.orgB, fx.userB);
    expect(await getThreeWayMatches(other, 50)).toEqual([]);
  });
});
