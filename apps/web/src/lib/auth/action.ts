import 'server-only';
import { z } from 'zod';
import { requireAccountContext, requireOrgContext, type AccountContext, type RequestContext } from './context';
import { can, type Capability } from './permissions';
import { withTenant, type Tx } from '@/lib/db/tenant';
import { writeAudit, type AuditEntry } from '@/lib/audit/log';
import { consume, refund } from '@/lib/ratelimit';
import { AppError, forbidden, rateLimited, screenLocked } from '@/lib/errors';
import { describeInfrastructureFailure } from '@/lib/infra-errors';
import { screenUnlocked } from '@/lib/auth/unlock';

export interface ActionContext<TInput> extends RequestContext {
  input: TInput;
  tx: Tx;
  /** Records an audit row in the same transaction as the change. */
  audit: (entry: AuditEntry) => Promise<void>;
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: AppError['code'] | 'unknown'; fieldErrors?: Record<string, string[]> };

export interface ActionConfig<TSchema extends z.ZodTypeAny, TOut> {
  /** Stable identifier, also the default audit action name. e.g. 'company.profile.updated' */
  name: string;
  capability: Capability;
  input: TSchema;
  /** Requests per window per user per action. Defaults to 30 per minute. */
  rateLimit?: { limit: number; windowSeconds: number };
  handler: (ctx: ActionContext<z.infer<TSchema>>) => Promise<TOut>;
}

const DEFAULT_RATE_LIMIT = { limit: 30, windowSeconds: 60 };

/**
 * Hands back the attempt an unexpected failure consumed.
 *
 * Called only where the action died of something that is not the caller's doing
 * — a database that cannot be reached, a credential that is wrong. A rejection
 * the caller caused (bad input, no permission, already over the limit) keeps its
 * charge, because those are exactly what the limit is counting.
 *
 * Refunding is best-effort: it runs after a failure, and whatever broke the
 * action may well break this too. A refund that does not happen leaves the
 * caller where they already were, so it is swallowed rather than replacing the
 * real error with one about bookkeeping.
 */
async function giveBackTheAttempt(key: string | null): Promise<void> {
  if (!key) return;
  try {
    await refund(key);
  } catch {
    // Deliberately quiet. See above.
  }
}

/**
 * Builds a server action.
 *
 * This is the only sanctioned way to write a mutation. It resolves the caller,
 * checks the capability, rate-limits, opens the tenant transaction and exposes an
 * `audit` helper bound to that transaction — so a permission check cannot be
 * forgotten and an audit row cannot be skipped.
 *
 * tests/unit/action-guard.test.ts fails if any exported server action is defined
 * without going through here.
 */
export function defineAction<TSchema extends z.ZodTypeAny, TOut>(
  config: ActionConfig<TSchema, TOut>,
) {
  const run = async (raw: unknown): Promise<ActionResult<TOut>> => {
    let rateLimitKey: string | null = null;
    try {
      const ctx = await requireOrgContext();

      // A page that is not rendered can still be acted on by anyone who knows
      // the action's name, so the lock is enforced here too rather than only in
      // the guard. This is the line that makes it a lock and not a curtain.
      if (!(await screenUnlocked(ctx.userId))) throw screenLocked();

      if (!can(ctx.role, config.capability)) {
        throw forbidden(describe(config.capability));
      }

      const rl = config.rateLimit ?? DEFAULT_RATE_LIMIT;
      rateLimitKey = `action:${config.name}:${ctx.userId}`;
      const gate = await consume(rateLimitKey, rl.limit, rl.windowSeconds);
      if (!gate.ok) {
        // Already over: do not refund this one, or the window never fills.
        rateLimitKey = null;
        throw rateLimited();
      }

      const parsed = config.input.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'invalid_input',
          error: 'Check the highlighted fields.',
          fieldErrors: flattenFieldErrors(parsed.error),
        };
      }

      const data = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
        const actionCtx: ActionContext<z.infer<TSchema>> = {
          ...ctx,
          input: parsed.data,
          tx,
          audit: (entry) =>
            writeAudit(tx, { orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, ip: ctx.ip, userAgent: ctx.userAgent }, entry),
        };
        return config.handler(actionCtx);
      });

      return { ok: true, data };
    } catch (err) {
      if (err instanceof AppError) {
        return { ok: false, code: err.code, error: err.message };
      }
      // A misconfigured deployment is not a bug, and saying "something went
      // wrong" about one leaves the person who can fix it with nothing to go on.
      const infra = describeInfrastructureFailure(err);
      console.error(`[action:${config.name}]${infra ? ` ${infra.reason}` : ''}`, err);
      await giveBackTheAttempt(rateLimitKey);
      return {
        ok: false,
        code: 'unknown',
        error: infra?.message ?? 'Something went wrong. Nothing was changed.',
      };
    }
  };

  // Marker read by tests/unit/action-guard.test.ts.
  Object.defineProperty(run, '__sherrbyteAction', {
    value: { name: config.name, capability: config.capability },
    enumerable: false,
  });

  return run;
}

function describe(capability: Capability): string {
  const [subject = '', verb = ''] = capability.split(':');
  return `${verb.replace(/_/g, ' ')} ${subject}`.trim();
}

function flattenFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

// ─── account-scoped actions ─────────────────────────────────────────────────

export interface AccountActionContext<TInput> extends AccountContext {
  input: TInput;
}

export interface AccountActionConfig<TSchema extends z.ZodTypeAny, TOut> {
  name: string;
  input: TSchema;
  rateLimit?: { limit: number; windowSeconds: number };
  handler: (ctx: AccountActionContext<z.infer<TSchema>>) => Promise<TOut>;
}

/**
 * Builds a server action for the few operations that legitimately run BEFORE an
 * organization exists — today, only company creation.
 *
 * It deliberately offers less than defineAction: there is no capability to
 * check and no tenant transaction to open, because there is no tenant yet. What
 * it keeps is the parts that still apply — an authenticated, MFA-passed user,
 * schema validation, rate limiting and the same result shape.
 *
 * Auditing is the handler's responsibility here, and is done inside
 * app_create_company() where the new org id is in scope, so the company and its
 * audit row still commit together.
 */
export function defineAccountAction<TSchema extends z.ZodTypeAny, TOut>(
  config: AccountActionConfig<TSchema, TOut>,
) {
  const run = async (raw: unknown): Promise<ActionResult<TOut>> => {
    let rateLimitKey: string | null = null;
    try {
      const ctx = await requireAccountContext();

      const rl = config.rateLimit ?? { limit: 10, windowSeconds: 3600 };
      rateLimitKey = `account-action:${config.name}:${ctx.userId}`;
      const gate = await consume(rateLimitKey, rl.limit, rl.windowSeconds);
      if (!gate.ok) {
        rateLimitKey = null;
        throw rateLimited();
      }

      const parsed = config.input.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'invalid_input',
          error: 'Check the highlighted fields.',
          fieldErrors: flattenFieldErrors(parsed.error),
        };
      }

      return { ok: true, data: await config.handler({ ...ctx, input: parsed.data }) };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, code: err.code, error: err.message };
      const infra = describeInfrastructureFailure(err);
      console.error(`[account-action:${config.name}]${infra ? ` ${infra.reason}` : ''}`, err);
      await giveBackTheAttempt(rateLimitKey);
      return {
        ok: false,
        code: 'unknown',
        error: infra?.message ?? 'Something went wrong. Nothing was changed.',
      };
    }
  };

  Object.defineProperty(run, '__sherrbyteAction', {
    value: { name: config.name, capability: null },
    enumerable: false,
  });

  return run;
}
