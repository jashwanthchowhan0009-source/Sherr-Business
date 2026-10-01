import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';
import {
  overchargePaise,
  threeWayMatch,
  type MatchLine,
  type ThreeWayResult,
} from '@/lib/banking/three-way-match';

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'procurement:read')) throw forbidden('view purchase orders');
};

export interface ThreeWayRow {
  poId: string;
  poNo: string;
  poDate: string;
  supplierName: string;
  grnNumbers: string[];
  billNumbers: string[];
  result: ThreeWayResult;
  overchargePaise: bigint;
}

/**
 * The three-way match for every purchase order with activity against it.
 *
 * Lines are paired on the item id where both documents carry one, and on the
 * normalised description otherwise. Pairing on description is weaker, so an
 * order whose lines have no items will throw more exceptions than one whose lines
 * do — which is the honest outcome: without an item, there is no reliable way to
 * know that "25kg bags" and "Rice 25 kg" are the same thing.
 */
export async function getThreeWayMatches(
  ctx: RequestContext,
  limit = 20,
): Promise<ThreeWayRow[]> {
  guard(ctx);

  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows: orders } = await tx.execute<{
      po_id: string;
      po_no: string;
      po_date: string;
      supplier_name: string;
    }>(sql`
      select po.id as po_id, po.po_no, po.po_date::text as po_date, p.name as supplier_name
        from purchase_orders po
        join parties p on p.id = po.party_id
       where po.status <> 'cancelled'
       order by po.po_date desc
       limit ${limit}
    `);

    const result: ThreeWayRow[] = [];

    for (const order of orders) {
      const ordered = await tx.execute<{
        key: string;
        description: string;
        quantity: string;
        price: string;
      }>(sql`
        select coalesce(item_id::text, lower(description)) as key, description,
               quantity::text as quantity, unit_price_paise::text as price
          from purchase_order_lines where po_id = ${order.po_id}::uuid
      `);

      const received = await tx.execute<{
        key: string;
        description: string;
        quantity: string;
        grn_no: string;
      }>(sql`
        select coalesce(l.item_id::text, lower(l.description)) as key, l.description,
               l.quantity::text as quantity, g.grn_no
          from goods_receipt_lines l
          join goods_receipts g on g.id = l.grn_id
         where g.po_id = ${order.po_id}::uuid
      `);

      const billed = await tx.execute<{
        key: string;
        description: string;
        quantity: string;
        price: string;
        voucher_no: string;
      }>(sql`
        select coalesce(l.item_id::text, lower(l.description)) as key, l.description,
               l.quantity::text as quantity, l.unit_price_paise::text as price,
               v.voucher_no
          from voucher_lines l
          join vouchers v on v.id = l.voucher_id
         where v.po_id = ${order.po_id}::uuid
           and v.status = 'posted'
           and v.reversed_by_voucher_id is null
      `);

      const toLines = (
        rows: readonly { key: string; description: string; quantity: string; price?: string }[],
      ): MatchLine[] =>
        rows.map((r) => ({
          key: r.key,
          description: r.description,
          quantity: BigInt(r.quantity),
          unitPricePaise: BigInt(r.price ?? '0'),
        }));

      const matched = threeWayMatch({
        ordered: toLines(ordered.rows),
        received: toLines(received.rows),
        billed: toLines(billed.rows),
      });

      result.push({
        poId: order.po_id,
        poNo: order.po_no,
        poDate: order.po_date,
        supplierName: order.supplier_name,
        grnNumbers: [...new Set(received.rows.map((r) => r.grn_no))],
        billNumbers: [...new Set(billed.rows.map((r) => r.voucher_no))],
        result: matched,
        overchargePaise: overchargePaise(matched),
      });
    }

    return result;
  });
}

/** Open purchase orders, for the receipt form and the bill form to reference. */
export async function getOpenPurchaseOrders(ctx: RequestContext) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      po_no: string;
      party_id: string;
      po_date: string;
      total_paise: string;
    }>(sql`
      select id, po_no, party_id, po_date::text as po_date, total_paise::text as total_paise
        from purchase_orders
       where status in ('open', 'part_received')
       order by po_date desc
       limit 100
    `);
    return rows.map((r) => ({
      id: r.id,
      poNo: r.po_no,
      partyId: r.party_id,
      poDate: r.po_date,
      totalPaise: BigInt(r.total_paise),
    }));
  });
}
