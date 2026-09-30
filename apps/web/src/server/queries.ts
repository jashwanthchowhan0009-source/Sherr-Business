import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { auditLogs, invitations, memberships, organizations, orgRegistrations, users } from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';

/**
 * Reads are guarded too. RLS already prevents cross-tenant leakage; these checks
 * are about role — a viewer reaching the audit log would be an in-tenant
 * authorisation bug, which RLS says nothing about.
 */

export async function getCompany(ctx: RequestContext) {
  if (!can(ctx.role, 'company:read')) throw forbidden('view company details');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const registrations = await tx
      .select()
      .from(orgRegistrations)
      .where(eq(orgRegistrations.orgId, ctx.orgId))
      .orderBy(orgRegistrations.kind);
    return { org: org ?? null, registrations };
  });
}

export async function getMembers(ctx: RequestContext) {
  if (!can(ctx.role, 'member:read')) throw forbidden('view members');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const rows = await tx
      .select({
        id: memberships.id,
        role: memberships.role,
        status: memberships.status,
        validTo: memberships.validTo,
        createdAt: memberships.createdAt,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        mfaEnabled: users.mfaEnabled,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, ctx.orgId))
      .orderBy(memberships.createdAt);
    return rows;
  });
}

export async function getPendingInvitations(ctx: RequestContext) {
  if (!can(ctx.role, 'invite:read')) throw forbidden('view invitations');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        validTo: invitations.validTo,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, ctx.orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .orderBy(desc(invitations.createdAt)),
  );
}

export async function getAuditLog(ctx: RequestContext, limit = 50) {
  if (!can(ctx.role, 'audit:read')) throw forbidden('read the audit history');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select({
        id: auditLogs.id,
        at: auditLogs.at,
        action: auditLogs.action,
        actorRole: auditLogs.actorRole,
        subjectKind: auditLogs.subjectKind,
        subjectId: auditLogs.subjectId,
        before: auditLogs.before,
        after: auditLogs.after,
        actorEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(eq(auditLogs.orgId, ctx.orgId))
      .orderBy(desc(auditLogs.at))
      .limit(limit),
  );
}
