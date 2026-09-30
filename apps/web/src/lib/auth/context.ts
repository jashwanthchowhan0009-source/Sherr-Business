import 'server-only';
import { auth, currentUser } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { clerkConfigured } from '@/lib/env';
import { ensureUser, resolveMembership } from '@/lib/db/tenant';
import type { Role } from '@/lib/db/schema';
import { mfaRequired, noOrganization, unauthenticated } from '@/lib/errors';

export interface RequestContext {
  orgId: string;
  userId: string;
  role: Role;
  clerkUserId: string;
  clerkOrgId: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Resolves the caller into a tenant context, or throws.
 *
 * MFA is checked here as well as in middleware. Middleware can be bypassed by a
 * route matcher mistake; this cannot, because every mutation goes through it.
 * The check fails closed: if the MFA signal is unreadable we treat it as absent.
 */
export async function requireOrgContext(): Promise<RequestContext> {
  if (!clerkConfigured()) {
    throw unauthenticated();
  }

  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId) throw unauthenticated();
  if (!clerkOrgId) throw noOrganization();

  const user = await currentUser();
  if (!user) throw unauthenticated();

  if (!hasMfa(user)) throw mfaRequired();

  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
  if (!email) throw unauthenticated();

  await ensureUser({
    clerkUserId,
    email,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
    mfaEnabled: true,
  });

  const membership = await resolveMembership({ clerkOrgId, clerkUserId });
  if (!membership) throw noOrganization();

  const h = await headers();
  return {
    orgId: membership.orgId,
    userId: membership.userId,
    role: membership.role,
    clerkUserId,
    clerkOrgId,
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: h.get('user-agent'),
  };
}

/** Null instead of throwing, for pages that render a sign-in prompt. */
export async function optionalOrgContext(): Promise<RequestContext | null> {
  try {
    return await requireOrgContext();
  } catch {
    return null;
  }
}

type MfaShapedUser = {
  twoFactorEnabled?: boolean | null;
  totpEnabled?: boolean | null;
  backupCodeEnabled?: boolean | null;
};

/**
 * Clerk exposes second-factor state under more than one field depending on the
 * factor. Any of them being true means the user has a second factor enrolled;
 * all absent means they do not, and we refuse.
 */
function hasMfa(user: unknown): boolean {
  const u = user as MfaShapedUser;
  return Boolean(u.twoFactorEnabled || u.totpEnabled || u.backupCodeEnabled);
}
