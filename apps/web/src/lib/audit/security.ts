import 'server-only';
import { optionalOrgContext } from '@/lib/auth/context';
import { withTenant } from '@/lib/db/tenant';
import { writeAudit } from './log';

/**
 * An audit row for something that happened to an account rather than to the books.
 *
 * Setting a PIN, resetting one, failing one. These sit outside the action
 * factory's own auditing because the lock runs on the account-scoped factory,
 * which has no organization and therefore no tenant transaction.
 *
 * `audit_logs.org_id` is not null, and deliberately so — the table is read
 * per-company and a row belonging to nobody would be visible to nobody. In
 * practice this is never a problem: a user reaches the lock only from an app
 * page, and an app page already required a company. The guard below is for the
 * case that ordering ever changes, and it fails quietly rather than losing the
 * action it was asked to record.
 */
export async function auditSecurityEvent(input: {
  action: string;
  subjectId: string;
  after?: Record<string, unknown>;
}): Promise<void> {
  const ctx = await optionalOrgContext();
  if (!ctx) {
    // Nothing to attach it to. Logged to the server so the event is not simply
    // lost, without a PIN or anything derived from one going anywhere near it.
    console.warn(`[security] ${input.action} for ${input.subjectId} outside any organization`);
    return;
  }

  await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    writeAudit(
      tx,
      { orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, ip: ctx.ip, userAgent: ctx.userAgent },
      {
        action: input.action,
        subjectKind: 'screen_lock',
        subjectId: input.subjectId,
        after: input.after,
      },
    ),
  );
}
