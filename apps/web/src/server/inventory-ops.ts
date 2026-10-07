'use server';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { STOCK_MOVEMENT_TYPES, items, stockLevels, stockMovements, warehouses } from '@/lib/db/schema';
import { parseQuantity } from '@/lib/accounting/units';
import { notFound } from '@/lib/errors';

const createWarehouseAction = defineAction({
  name: 'inventory_ops.warehouse.created',
  capability: 'inventory_ops:write',
  input: z.object({
    code: z.string().trim().min(1, 'Give the warehouse a code').max(32),
    name: z.string().trim().min(1, 'Name the warehouse').max(200),
    address: z.string().trim().max(500).optional().or(z.literal('')),
    isDefault: z.boolean().default(false),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [warehouse] = await tx
      .insert(warehouses)
      .values({ orgId, code: input.code, name: input.name, address: input.address || null, isDefault: input.isDefault })
      .returning();
    await audit({ action: 'inventory_ops.warehouse.created', subjectKind: 'warehouse', subjectId: warehouse?.id, after: input });
    revalidatePath('/inventory');
    return warehouse;
  },
});

/**
 * Records a movement and keeps stock_levels as its running total — both in the
 * same transaction, so the ledger of movements and the on-hand snapshot can
 * never disagree. This writes inventory facts only: it does not post to the
 * chart of accounts or touch a voucher (see the migration's banner comment).
 */
const recordStockMovementAction = defineAction({
  name: 'inventory_ops.movement.recorded',
  capability: 'inventory_ops:write',
  input: z.object({
    itemId: z.string().uuid('Choose an item'),
    warehouseId: z.string().uuid('Choose a warehouse'),
    movementType: z.enum(STOCK_MOVEMENT_TYPES),
    quantity: z.string().trim().min(1, 'Enter a quantity'),
    referenceKind: z.string().trim().max(60).optional().or(z.literal('')),
    referenceId: z.string().trim().max(120).optional().or(z.literal('')),
    note: z.string().trim().max(500).optional().or(z.literal('')),
  }),
  handler: async ({ tx, orgId, input, userId, audit }) => {
    const [item] = await tx.select().from(items).where(eq(items.id, input.itemId));
    if (!item) throw notFound('That item');
    const [warehouse] = await tx.select().from(warehouses).where(eq(warehouses.id, input.warehouseId));
    if (!warehouse) throw notFound('That warehouse');

    const magnitude = parseQuantity(input.quantity);
    const signed = ['issue', 'transfer_out'].includes(input.movementType) ? -magnitude : magnitude;

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        orgId,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        movementType: input.movementType,
        quantity: signed,
        referenceKind: input.referenceKind || null,
        referenceId: input.referenceId || null,
        note: input.note || null,
        createdBy: userId,
      })
      .returning();

    const [existing] = await tx
      .select()
      .from(stockLevels)
      .where(and(eq(stockLevels.itemId, input.itemId), eq(stockLevels.warehouseId, input.warehouseId)));

    if (existing) {
      await tx
        .update(stockLevels)
        .set({ quantityOnHand: existing.quantityOnHand + signed, updatedAt: new Date() })
        .where(eq(stockLevels.id, existing.id));
    } else {
      await tx.insert(stockLevels).values({
        orgId,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        quantityOnHand: signed,
      });
    }

    await audit({
      action: 'inventory_ops.movement.recorded',
      subjectKind: 'stock_movement',
      subjectId: movement?.id,
      after: { ...input, signedQuantity: signed.toString() },
    });
    revalidatePath('/inventory');
    return movement;
  },
});

export async function createWarehouse(input: unknown) {
  return createWarehouseAction(input);
}

export async function recordStockMovement(input: unknown) {
  return recordStockMovementAction(input);
}
