import 'server-only';
import { asc, eq, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import {
  accounts,
  bankAccounts,
  items,
  ledgerEntries,
  parties,
  purchaseOrderLines,
  purchaseOrders,
  voucherLines,
  vouchers,
} from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden, notFound } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';

/**
 * Reads that load one record back into its form for editing.
 *
 * Archived parties and items are included: editing is how one is restored, so
 * hiding them here would make an archive permanent.
 */

export async function getVoucherForEdit(ctx: RequestContext, id: string) {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view vouchers');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, id));
    if (!voucher) throw notFound('Voucher');

    const lines = await tx
      .select()
      .from(voucherLines)
      .where(eq(voucherLines.voucherId, id))
      .orderBy(asc(voucherLines.lineNo));

    const entries = await tx
      .select({
        code: accounts.code,
        debitPaise: ledgerEntries.debitPaise,
        creditPaise: ledgerEntries.creditPaise,
      })
      .from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(eq(ledgerEntries.voucherId, id))
      .orderBy(asc(ledgerEntries.createdAt));

    const { rows: againstRows } = await tx.execute<{ target: string }>(sql`
      select target_voucher_id as target from voucher_allocations
       where settlement_voucher_id = ${id}::uuid
    `);

    return {
      voucher,
      lines,
      entries,
      allocatedTo: againstRows.map((r) => r.target),
    };
  });
}

export async function getPartyById(ctx: RequestContext, id: string) {
  if (!can(ctx.role, 'party:read')) throw forbidden('view parties');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [row] = await tx.select().from(parties).where(eq(parties.id, id));
    if (!row) throw notFound('Party');
    return row;
  });
}

export async function getArchivedParties(ctx: RequestContext) {
  if (!can(ctx.role, 'party:read')) throw forbidden('view parties');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx.select().from(parties).where(eq(parties.isActive, false)).orderBy(parties.name),
  );
}

export async function getItemById(ctx: RequestContext, id: string) {
  if (!can(ctx.role, 'item:read')) throw forbidden('view items');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [row] = await tx.select().from(items).where(eq(items.id, id));
    if (!row) throw notFound('Item');
    return row;
  });
}

export async function getArchivedItems(ctx: RequestContext) {
  if (!can(ctx.role, 'item:read')) throw forbidden('view items');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx.select().from(items).where(eq(items.isActive, false)).orderBy(items.name),
  );
}

export async function getBankAccountById(ctx: RequestContext, id: string) {
  if (!can(ctx.role, 'bank:read')) throw forbidden('view bank accounts');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [row] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, id));
    if (!row) throw notFound('Bank account');
    return row;
  });
}

export async function getPurchaseOrderById(ctx: RequestContext, id: string) {
  if (!can(ctx.role, 'procurement:read')) throw forbidden('view purchase orders');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!order) throw notFound('Purchase order');
    const lines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, id))
      .orderBy(asc(purchaseOrderLines.lineNo));
    return { order, lines };
  });
}

export async function getPurchaseOrders(ctx: RequestContext, limit = 25) {
  if (!can(ctx.role, 'procurement:read')) throw forbidden('view purchase orders');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select({
        id: purchaseOrders.id,
        poNo: purchaseOrders.poNo,
        poDate: purchaseOrders.poDate,
        status: purchaseOrders.status,
        totalPaise: purchaseOrders.totalPaise,
        partyName: parties.name,
      })
      .from(purchaseOrders)
      .leftJoin(parties, eq(parties.id, purchaseOrders.partyId))
      .orderBy(sql`${purchaseOrders.poDate} desc, ${purchaseOrders.createdAt} desc`)
      .limit(limit),
  );
}
