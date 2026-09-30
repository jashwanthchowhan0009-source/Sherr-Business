import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { appDb, type AppDb } from './pool';
import * as schema from './schema';

export type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

export interface TenantContext {
  orgId: string;
  /** Our users.id, not the Clerk id. Null only during bootstrap paths. */
  userId: string | null;
}

const uuidSchema = z.string().uuid();

/**
 * The only supported way to read or write tenant data.
 *
 * Opens a transaction and sets `app.current_org_id` with `set_config(..., true)`
 * — the `true` makes it *transaction*-local, so it is discarded on commit or
 * rollback and the connection goes back to the pool clean. Using plain `SET`
 * here would leak the tenant to whoever picks up that pooled connection next,
 * which is the single most common way multi-tenant isolation breaks.
 *
 * Nothing in here is a substitute for the RLS policies; it is the input to them.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const orgId = uuidSchema.parse(ctx.orgId);
  const userId = ctx.userId === null ? null : uuidSchema.parse(ctx.userId);

  return appDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    await tx.execute(sql`select set_config('app.current_user_id', ${userId ?? ''}, true)`);
    return fn(tx);
  });
}

/**
 * Calls a SECURITY DEFINER function for the few operations that legitimately
 * happen before a tenant context exists: creating the user row on first sign-in,
 * and creating an organization. The application role cannot insert into those
 * tables directly — only through these vetted functions.
 */
export async function ensureUser(input: {
  clerkUserId: string;
  email: string;
  fullName: string | null;
  mfaEnabled: boolean;
}): Promise<{ id: string }> {
  const rows = await appDb().execute<{ id: string }>(sql`
    select app_ensure_user(
      ${input.clerkUserId}, ${input.email}, ${input.fullName}, ${input.mfaEnabled}
    ) as id
  `);
  const row = rows.rows[0];
  if (!row) throw new Error('app_ensure_user returned no row');
  return { id: row.id };
}

export async function createOrganization(input: {
  clerkOrgId: string;
  legalName: string;
  ownerUserId: string;
}): Promise<{ id: string }> {
  const rows = await appDb().execute<{ id: string }>(sql`
    select app_create_organization(
      ${input.clerkOrgId}, ${input.legalName}, ${input.ownerUserId}::uuid
    ) as id
  `);
  const row = rows.rows[0];
  if (!row) throw new Error('app_create_organization returned no row');
  return { id: row.id };
}

export interface CreateCompanyInput {
  clerkOrgId: string;
  legalName: string;
  ownerUserId: string;
  tradeName: string | null;
  gstin: string | null;
  pan: string | null;
  stateCode: string | null;
  registrationType: string;
  fyStartMonth: number;
  booksStartDate: string;
  accountGroups: unknown;
  accounts: unknown;
}

/**
 * Creates a company and everything it cannot exist without, in one transaction:
 * the organization, the creator's owner membership, its GSTIN registration, the
 * seeded chart of accounts and the audit row.
 *
 * The chart is passed in from src/lib/accounting/chart-of-accounts.ts rather
 * than written into the migration, so TypeScript stays the single source of
 * truth and the tests that assert its structure check the same data the
 * database receives.
 */
export async function createCompany(input: CreateCompanyInput): Promise<{ id: string }> {
  const rows = await appDb().execute<{ id: string }>(sql`
    select app_create_company(
      ${input.clerkOrgId},
      ${input.legalName},
      ${uuidSchema.parse(input.ownerUserId)}::uuid,
      ${input.tradeName},
      ${input.gstin},
      ${input.pan},
      ${input.stateCode},
      ${input.registrationType},
      ${input.fyStartMonth},
      ${input.booksStartDate}::date,
      ${JSON.stringify(input.accountGroups)}::jsonb,
      ${JSON.stringify(input.accounts)}::jsonb
    ) as id
  `);
  const row = rows.rows[0];
  if (!row) throw new Error('app_create_company returned no row');
  return { id: row.id };
}

/**
 * Resolves the caller's active membership. Returns null when the user is not a
 * member, the membership is not active, or it has passed `valid_to` — which is
 * how time-boxed CA and auditor access expires without a scheduled job.
 */
export async function resolveMembership(input: {
  clerkOrgId: string;
  clerkUserId: string;
}): Promise<{ orgId: string; userId: string; role: schema.Role } | null> {
  const rows = await appDb().execute<{
    org_id: string;
    user_id: string;
    role: schema.Role;
  }>(sql`
    select m.org_id, m.user_id, m.role
    from app_resolve_membership(${input.clerkOrgId}, ${input.clerkUserId}) m
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return { orgId: row.org_id, userId: row.user_id, role: row.role };
}
