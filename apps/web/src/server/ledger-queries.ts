import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import {
  accounts,
  documents,
  items,
  parties,
  taxRules,
  users,
  voucherLines,
  vouchers,
} from '@/lib/db/schema';
import type { TaxRuleKind } from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden, notFound } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';

/**
 * Reads over the voucher core.
 *
 * RLS already makes a cross-tenant read impossible; the capability checks here
 * are about role, which RLS says nothing about. Both layers are needed.
 */

export async function getParties(ctx: RequestContext, kind?: 'customer' | 'supplier') {
  if (!can(ctx.role, 'party:read')) throw forbidden('view parties');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select()
      .from(parties)
      .where(
        kind
          ? and(eq(parties.isActive, true), sql`${parties.kind} in (${kind}, 'both')`)
          : eq(parties.isActive, true),
      )
      .orderBy(parties.name),
  );
}

export async function getItems(ctx: RequestContext) {
  if (!can(ctx.role, 'item:read')) throw forbidden('view items');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx.select().from(items).where(eq(items.isActive, true)).orderBy(items.name),
  );
}

export async function getAccounts(ctx: RequestContext) {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view accounts');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx.select().from(accounts).where(eq(accounts.isActive, true)).orderBy(accounts.name),
  );
}

export async function getVouchers(
  ctx: RequestContext,
  input: { voucherType?: 'sales' | 'receipt'; limit?: number } = {},
) {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view vouchers');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select({
        id: vouchers.id,
        voucherType: vouchers.voucherType,
        voucherNo: vouchers.voucherNo,
        voucherDate: vouchers.voucherDate,
        status: vouchers.status,
        supplyType: vouchers.supplyType,
        taxablePaise: vouchers.taxablePaise,
        totalPaise: vouchers.totalPaise,
        reversedByVoucherId: vouchers.reversedByVoucherId,
        partyName: parties.name,
        partyGstin: parties.gstin,
      })
      .from(vouchers)
      .leftJoin(parties, eq(parties.id, vouchers.partyId))
      .where(input.voucherType ? eq(vouchers.voucherType, input.voucherType) : sql`true`)
      .orderBy(desc(vouchers.voucherDate), desc(vouchers.createdAt))
      .limit(input.limit ?? 50),
  );
}

/**
 * One invoice with everything needed to print it.
 *
 * Every number comes from the stored voucher and its lines rather than being
 * recalculated: a printed invoice is a legal document, and reprinting it must
 * produce the same figures even if a rate, a price or the engine has changed
 * since.
 */
export async function getInvoice(ctx: RequestContext, voucherId: string) {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view vouchers');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(eq(vouchers.id, voucherId));
    if (!voucher) throw notFound('That invoice does not exist in this company.');

    const lines = await tx
      .select()
      .from(voucherLines)
      .where(eq(voucherLines.voucherId, voucherId))
      .orderBy(voucherLines.lineNo);

    const party = voucher.partyId
      ? (await tx.select().from(parties).where(eq(parties.id, voucher.partyId)))[0] ?? null
      : null;

    return { voucher, lines, party };
  });
}

export async function getDocuments(ctx: RequestContext, limit = 50) {
  if (!can(ctx.role, 'document:read')) throw forbidden('view documents');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select({
        id: documents.id,
        originalFilename: documents.originalFilename,
        mimeType: documents.mimeType,
        byteSize: documents.byteSize,
        declaredType: documents.declaredType,
        status: documents.status,
        createdAt: documents.createdAt,
        uploadedByName: users.fullName,
        uploadedByEmail: users.email,
      })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.uploadedBy))
      .orderBy(desc(documents.createdAt))
      .limit(limit),
  );
}

/**
 * The GST slabs available to this company: the product-wide list plus any
 * override it has added. Each row carries whether a professional has signed it
 * off, because the UI must not present an unverified rate as settled.
 */
export async function getTaxRules(ctx: RequestContext, kind: TaxRuleKind = 'gst_rate') {
  if (!can(ctx.role, 'taxrule:read')) throw forbidden('view tax rules');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select()
      .from(taxRules)
      .where(and(eq(taxRules.kind, kind), sql`${taxRules.effectiveTo} is null`))
      .orderBy(taxRules.rateBps),
  );
}

/** Counts for the Data tab, so a section can say what exists before it lists it. */
export async function getDataCounts(ctx: RequestContext) {
  if (!can(ctx.role, 'company:read')) throw forbidden('view company details');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      parties: string; items: string; vouchers: string; posted: string;
      documents: string; accounts: string; audit: string;
    }>(sql`
      select
        (select count(*) from parties)        ::text as parties,
        (select count(*) from items)          ::text as items,
        (select count(*) from vouchers)       ::text as vouchers,
        (select count(*) from vouchers where status = 'posted')::text as posted,
        (select count(*) from documents)      ::text as documents,
        (select count(*) from accounts)       ::text as accounts,
        (select count(*) from audit_logs)     ::text as audit
    `);
    const row = rows[0];
    return {
      parties: Number(row?.parties ?? 0),
      items: Number(row?.items ?? 0),
      vouchers: Number(row?.vouchers ?? 0),
      postedVouchers: Number(row?.posted ?? 0),
      documents: Number(row?.documents ?? 0),
      accounts: Number(row?.accounts ?? 0),
      auditEntries: Number(row?.audit ?? 0),
    };
  });
}

/**
 * The date the books are locked to, or null when nothing is locked.
 *
 * Read by every voucher form so the date field can refuse a closed period
 * before the server does. The database refuses it regardless; this is so the
 * person is told before they fill the rest of the form in.
 */
export async function getPeriodLock(ctx: RequestContext): Promise<string | null> {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view the books');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{ locked_upto: string }>(
      sql`select locked_upto::text from period_locks limit 1`,
    );
    return rows[0]?.locked_upto ?? null;
  });
}
