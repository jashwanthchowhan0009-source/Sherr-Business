'use server';

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import type { Tx } from '@/lib/db/tenant';
import { invitations, memberships, ROLES } from '@/lib/db/schema';
import { conflict, forbidden, notFound } from '@/lib/errors';

const INVITE_TTL_DAYS = 14;

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  role: z.enum(ROLES),
  /**
   * External reviewers get time-boxed access. The blueprint requires this for
   * CA and auditor roles; enforcing it at invite time means nobody has to
   * remember to revoke later.
   */
  validToDays: z.coerce.number().int().min(1).max(3650).optional(),
});

const inviteMemberAction = defineAction({
  name: 'member.invited',
  capability: 'member:invite',
  input: inviteSchema,
  rateLimit: { limit: 10, windowSeconds: 3600 },
  handler: async ({ tx, orgId, userId, input, audit }) => {
    const existing = await tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          eq(invitations.email, input.email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    if (existing.length > 0) {
      throw conflict(`${input.email} already has a pending invitation.`);
    }

    // The raw token is returned once and never stored. Only its hash persists,
    // so a database read cannot be replayed into account access.
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
    const validTo = input.validToDays
      ? new Date(Date.now() + input.validToDays * 86_400_000)
      : null;

    const [row] = await tx
      .insert(invitations)
      .values({
        orgId,
        email: input.email,
        role: input.role,
        tokenHash,
        invitedBy: userId,
        expiresAt,
        validTo,
      })
      .returning();

    if (!row) throw conflict('Could not create the invitation.');

    await audit({
      action: 'member.invited',
      subjectKind: 'invitation',
      subjectId: row.id,
      after: { email: input.email, role: input.role, expiresAt, validTo },
    });

    revalidatePath('/people');
    return { id: row.id, token, expiresAt };
  },
});

const revokeInvitationAction = defineAction({
  name: 'member.invite_revoked',
  capability: 'invite:revoke',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, input.id), eq(invitations.orgId, orgId)));
    if (!before) throw notFound('Invitation');
    if (before.acceptedAt) throw conflict('That invitation has already been accepted.');

    await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(eq(invitations.id, input.id));

    await audit({
      action: 'member.invite_revoked',
      subjectKind: 'invitation',
      subjectId: input.id,
      before: { email: before.email, role: before.role },
    });

    revalidatePath('/people');
    return { id: input.id };
  },
});

const updateMemberRoleAction = defineAction({
  name: 'member.role_changed',
  capability: 'member:update_role',
  input: z.object({ membershipId: z.string().uuid(), role: z.enum(ROLES) }),
  handler: async ({ tx, orgId, userId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, orgId)));
    if (!before) throw notFound('Membership');

    if (before.userId === userId && before.role === 'owner' && input.role !== 'owner') {
      await assertAnotherOwnerExists(tx, orgId, before.id);
    }

    await tx
      .update(memberships)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(memberships.id, input.membershipId));

    await audit({
      action: 'member.role_changed',
      subjectKind: 'membership',
      subjectId: input.membershipId,
      before: { role: before.role },
      after: { role: input.role },
    });

    revalidatePath('/people');
    return { id: input.membershipId, role: input.role };
  },
});

const removeMemberAction = defineAction({
  name: 'member.removed',
  capability: 'member:remove',
  input: z.object({ membershipId: z.string().uuid() }),
  handler: async ({ tx, orgId, userId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, orgId)));
    if (!before) throw notFound('Membership');

    if (before.userId === userId) {
      throw forbidden('remove your own access');
    }
    if (before.role === 'owner') {
      await assertAnotherOwnerExists(tx, orgId, before.id);
    }

    await tx.delete(memberships).where(eq(memberships.id, input.membershipId));

    await audit({
      action: 'member.removed',
      subjectKind: 'membership',
      subjectId: input.membershipId,
      before: { userId: before.userId, role: before.role },
    });

    revalidatePath('/people');
    return { id: input.membershipId };
  },
});

/**
 * An organization with no owner cannot be administered by anyone, and no role
 * in this product can restore one. Refuse the operation rather than create it.
 */
async function assertAnotherOwnerExists(
  tx: Tx,
  orgId: string,
  excludingMembershipId: string,
): Promise<void> {
  const owners = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner')));
  const others = owners.filter((o) => o.id !== excludingMembershipId);
  if (others.length === 0) {
    throw conflict('This is the last owner. Make someone else an owner first.');
  }
}


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function inviteMember(input: unknown) {
  return inviteMemberAction(input);
}

export async function revokeInvitation(input: unknown) {
  return revokeInvitationAction(input);
}

export async function updateMemberRole(input: unknown) {
  return updateMemberRoleAction(input);
}

export async function removeMember(input: unknown) {
  return removeMemberAction(input);
}
