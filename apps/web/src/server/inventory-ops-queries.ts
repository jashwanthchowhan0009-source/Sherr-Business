import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { stockLevels, stockMovements, warehouses } from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'inventory_ops:read')) throw forbidden('view inventory');
};

export async function listWarehouses(ctx: RequestContext) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.select().from(warehouses).where(eq(warehouses.orgId, ctx.orgId)).orderBy(warehouses.name),
  );
}

/** On-hand quantity per item per warehouse. Quantities are scaled ×10,000 — see schema.ts. */
export async function listStockLevels(ctx: RequestContext, warehouseId?: string) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx
      .select()
      .from(stockLevels)
      .where(
        warehouseId
          ? and(eq(stockLevels.orgId, ctx.orgId), eq(stockLevels.warehouseId, warehouseId))
          : eq(stockLevels.orgId, ctx.orgId),
      ),
  );
}

export async function listStockMovements(ctx: RequestContext, itemId?: string, limit = 50) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx
      .select()
      .from(stockMovements)
      .where(
        itemId
          ? and(eq(stockMovements.orgId, ctx.orgId), eq(stockMovements.itemId, itemId))
          : eq(stockMovements.orgId, ctx.orgId),
      )
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit),
  );
}
