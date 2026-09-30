import 'server-only';
import { auditLogs, type Role } from '@/lib/db/schema';
import type { Tx } from '@/lib/db/tenant';

export interface AuditEntry {
  action: string;
  subjectKind: string;
  subjectId?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface AuditActor {
  orgId: string;
  userId: string;
  role: Role;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes an audit row INSIDE the caller's transaction.
 *
 * Taking `tx` rather than opening its own connection is the whole point: an
 * action and its audit record commit or roll back together, so there is no way
 * to change data without leaving a trace, and no way to leave a trace for a
 * change that did not happen.
 */
export async function writeAudit(tx: Tx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    orgId: actor.orgId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: entry.action,
    subjectKind: entry.subjectKind,
    subjectId: entry.subjectId ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
}

const SENSITIVE_KEYS = new Set(['tokenhash', 'token', 'password', 'secret', 'apikey']);

/**
 * The audit log is read by people who are not entitled to every field of every
 * record. Strip anything credential-shaped before it is written.
 */
function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase().replace(/_/g, '')) ? '[redacted]' : redact(v);
  }
  return out;
}
