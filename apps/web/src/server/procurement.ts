'use server';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { organizations, parties, purchaseOrders } from '@/lib/db/schema';
import { allocateVoucherNumber } from '@/lib/db/ledger';
import { fyLabelFor } from '@/lib/accounting/fiscal-year';
import { parseQuantity, parseRupees } from '@/lib/accounting/units';
import { conflict, invalidInput, notFound } from '@/lib/errors';
import { sql } from 'drizzle-orm';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
const optional = (schema: z.ZodString) => schema.optional().or(z.literal(''));

const lineSchema = z.object({
  itemId: z.string().uuid().optional().or(z.literal('')),
  description: z.string().trim().min(1, 'Describe the line').max(300),
  quantity: z.string().trim(),
  unit: optional(z.string().trim().max(12)),
  unitPriceRupees: z.string().trim().default('0'),
  gstRateBps: z.coerce.number().int().min(0).max(100_000).default(0),
});

async function fyFor(
  tx: Parameters<typeof allocateVoucherNumber>[0],
  orgId: string,
  date: string,
): Promise<string> {
  const [company] = await tx
    .select({ fyStartMonth: organizations.fyStartMonth })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return fyLabelFor(date, company?.fyStartMonth ?? 4);
}

/**
 * A purchase order.
 *
 * Not an accounting voucher: ordering goods changes no ledger balance, so nothing
 * is posted and no number series for vouchers is consumed. It exists so a bill can
 * later be checked against what was actually agreed.
 */
const poSchema = z.object({
  partyId: z.string().uuid('Choose a supplier'),
  poDate: isoDate,
  expectedDate: isoDate.optional().or(z.literal('')),
  narration: optional(z.string().trim().max(500)),
  lines: z.array(lineSchema).min(1, 'An order needs at least one line'),
});

/** Parses order lines into integers, refusing a line with no quantity. */
function orderLines(input: z.infer<typeof poSchema>['lines']) {
  const lines = input.map((line, index) => ({
    lineNo: index + 1,
    itemId: line.itemId || null,
    description: line.description,
    quantity: parseQuantity(line.quantity),
    unit: line.unit || null,
    unitPricePaise: parseRupees(line.unitPriceRupees || '0'),
    gstRateBps: line.gstRateBps,
  }));
  if (lines.some((l) => l.quantity <= 0n)) {
    throw invalidInput('Every line needs a quantity greater than zero.');
  }
  const totalPaise = lines.reduce((acc, l) => acc + (l.quantity * l.unitPricePaise) / 10_000n, 0n);
  return { lines, totalPaise };
}

const createPurchaseOrderAction = defineAction({
  name: 'procurement.po.created',
  capability: 'procurement:write',
  input: poSchema,
  handler: async ({ tx, orgId, input, audit }) => {
    const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
    if (!party) throw notFound('That supplier does not exist in this company.');

    const fyLabel = await fyFor(tx, orgId, input.poDate);

    // Orders get their own numbering, separate from vouchers: a PO is not a
    // voucher and must not consume a voucher number.
    const { rows: seqRows } = await tx.execute<{ next: string }>(sql`
      select coalesce(max(substring(po_no from '[0-9]+$')::int), 0) + 1 as next
        from purchase_orders where fy_label = ${fyLabel}
    `);
    const poNo = `PO/${fyLabel}/${String(seqRows[0]?.next ?? 1).padStart(4, '0')}`;

    const { lines, totalPaise } = orderLines(input.lines);

    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into purchase_orders (org_id, po_no, fy_label, po_date, party_id, expected_date,
                                   narration, total_paise)
      values (app_current_org_id(), ${poNo}, ${fyLabel}, ${input.poDate}::date,
              ${party.id}::uuid, ${input.expectedDate || null}::date,
              ${input.narration || null}, ${totalPaise})
      returning id
    `);
    const poId = rows[0]!.id;

    for (const line of lines) {
      await tx.execute(sql`
        insert into purchase_order_lines (org_id, po_id, line_no, item_id, description,
                                          quantity, unit, unit_price_paise, gst_rate_bps)
        values (app_current_org_id(), ${poId}::uuid, ${line.lineNo}, ${line.itemId}::uuid,
                ${line.description}, ${line.quantity}, ${line.unit},
                ${line.unitPricePaise}, ${line.gstRateBps})
      `);
    }

    await audit({
      action: 'procurement.po.created',
      subjectKind: 'purchase_order',
      subjectId: poId,
      after: { poNo, supplier: party.name, totalPaise: totalPaise.toString(), lines: lines.length },
    });

    revalidatePath('/process');
    return { id: poId, poNo };
  },
});

/**
 * A goods receipt, against the supplier's delivery challan.
 *
 * Also not an accounting voucher. Recording what arrived is the second of the
 * three documents the match compares, and the one that stops a supplier being
 * paid for goods nobody received.
 */
const createGoodsReceiptAction = defineAction({
  name: 'procurement.grn.created',
  capability: 'procurement:write',
  input: z.object({
    partyId: z.string().uuid('Choose a supplier'),
    poId: z.string().uuid().optional().or(z.literal('')),
    receiptDate: isoDate,
    challanNo: optional(z.string().trim().max(60)),
    challanDate: isoDate.optional().or(z.literal('')),
    narration: optional(z.string().trim().max(500)),
    lines: z
      .array(
        z.object({
          itemId: z.string().uuid().optional().or(z.literal('')),
          description: z.string().trim().min(1).max(300),
          quantity: z.string().trim(),
          unit: optional(z.string().trim().max(12)),
        }),
      )
      .min(1, 'A receipt needs at least one line'),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
    if (!party) throw notFound('That supplier does not exist in this company.');

    if (input.poId) {
      const [po] = await tx
        .select({ partyId: purchaseOrders.partyId, poNo: purchaseOrders.poNo })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.poId));
      if (!po) throw notFound('That purchase order does not exist in this company.');
      // A receipt against another supplier's order is a data-entry error that
      // would make the three-way match meaningless.
      if (po.partyId !== party.id) {
        throw conflict(`${po.poNo} was placed with a different supplier.`);
      }
    }

    const fyLabel = await fyFor(tx, orgId, input.receiptDate);
    const { rows: seqRows } = await tx.execute<{ next: string }>(sql`
      select coalesce(max(substring(grn_no from '[0-9]+$')::int), 0) + 1 as next
        from goods_receipts where fy_label = ${fyLabel}
    `);
    const grnNo = `GRN/${fyLabel}/${String(seqRows[0]?.next ?? 1).padStart(4, '0')}`;

    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into goods_receipts (org_id, grn_no, fy_label, receipt_date, party_id, po_id,
                                  challan_no, challan_date, narration)
      values (app_current_org_id(), ${grnNo}, ${fyLabel}, ${input.receiptDate}::date,
              ${party.id}::uuid, ${input.poId || null}::uuid,
              ${input.challanNo || null}, ${input.challanDate || null}::date,
              ${input.narration || null})
      returning id
    `);
    const grnId = rows[0]!.id;

    for (const [index, line] of input.lines.entries()) {
      const quantity = parseQuantity(line.quantity);
      if (quantity <= 0n) throw invalidInput('Every line needs a quantity greater than zero.');
      await tx.execute(sql`
        insert into goods_receipt_lines (org_id, grn_id, line_no, item_id, description,
                                         quantity, unit)
        values (app_current_org_id(), ${grnId}::uuid, ${index + 1}, ${line.itemId || null}::uuid,
                ${line.description}, ${quantity}, ${line.unit || null})
      `);
    }

    if (input.poId) {
      await tx.execute(sql`
        update purchase_orders set status = 'part_received', updated_at = now()
         where id = ${input.poId}::uuid and status = 'open'
      `);
    }

    await audit({
      action: 'procurement.grn.created',
      subjectKind: 'goods_receipt',
      subjectId: grnId,
      after: {
        grnNo,
        supplier: party.name,
        challanNo: input.challanNo || null,
        lines: input.lines.length,
      },
    });

    revalidatePath('/process');
    return { id: grnId, grnNo };
  },
});


/**
 * Editing a purchase order.
 *
 * Only while nothing has been measured against it. Once goods have been
 * received or a bill linked, the order is evidence in a three-way match, and
 * changing it afterwards would let a bill be made to agree with an order that
 * was rewritten to fit.
 */
const updatePurchaseOrderAction = defineAction({
  name: 'procurement.po.updated',
  capability: 'procurement:write',
  input: poSchema.extend({ id: z.string().uuid() }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, input.id), eq(purchaseOrders.orgId, orgId)));
    if (!before) throw notFound('Purchase order');
    if (before.status !== 'open') {
      throw conflict(`${before.poNo} is ${before.status.replace('_', ' ')} and can no longer be edited.`);
    }

    const { rows: used } = await tx.execute<{ n: string }>(sql`
      select ((select count(*) from goods_receipts where po_id = ${input.id}::uuid)
            + (select count(*) from vouchers where po_id = ${input.id}::uuid))::text as n
    `);
    if (Number(used[0]?.n ?? 0) > 0) {
      throw conflict(
        `Goods or a bill have already been recorded against ${before.poNo}, so it can no longer be edited.`,
      );
    }

    const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
    if (!party) throw notFound('Supplier');

    const { lines, totalPaise } = orderLines(input.lines);

    await tx
      .update(purchaseOrders)
      .set({
        partyId: party.id,
        poDate: input.poDate,
        expectedDate: input.expectedDate || null,
        narration: input.narration || null,
        totalPaise,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, input.id));

    await tx.execute(sql`delete from purchase_order_lines where po_id = ${input.id}::uuid`);
    for (const line of lines) {
      await tx.execute(sql`
        insert into purchase_order_lines (org_id, po_id, line_no, item_id, description,
                                          quantity, unit, unit_price_paise, gst_rate_bps)
        values (app_current_org_id(), ${input.id}::uuid, ${line.lineNo}, ${line.itemId}::uuid,
                ${line.description}, ${line.quantity}, ${line.unit},
                ${line.unitPricePaise}, ${line.gstRateBps})
      `);
    }

    await audit({
      action: 'procurement.po.updated',
      subjectKind: 'purchase_order',
      subjectId: input.id,
      before: { supplierId: before.partyId, poDate: before.poDate, totalPaise: before.totalPaise.toString() },
      after: { supplier: party.name, poDate: input.poDate, totalPaise: totalPaise.toString(), lines: lines.length },
    });

    revalidatePath('/process');
    return { id: input.id, poNo: before.poNo };
  },
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function createPurchaseOrder(input: unknown) {
  return createPurchaseOrderAction(input);
}

export async function createGoodsReceipt(input: unknown) {
  return createGoodsReceiptAction(input);
}

export async function updatePurchaseOrder(input: unknown) {
  return updatePurchaseOrderAction(input);
}
