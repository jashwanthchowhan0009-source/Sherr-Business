import 'server-only';
import { z } from 'zod';
import { requireOrgContext, type RequestContext } from './context';
import { can, type Capability } from './permissions';
import { withTenant, type Tx } from '@/lib/db/tenant';
import { writeAudit, type AuditEntry } from '@/lib/audit/log';
import { consume } from '@/lib/ratelimit';
import { AppError, forbidden, rateLimited } from '@/lib/errors';

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
    try {
      const ctx = await requireOrgContext();

      if (!can(ctx.role, config.capability)) {
        throw forbidden(describe(config.capability));
      }

      const rl = config.rateLimit ?? DEFAULT_RATE_LIMIT;
      const gate = await consume(
        `action:${config.name}:${ctx.userId}`,
        rl.limit,
        rl.windowSeconds,
      );
      if (!gate.ok) throw rateLimited();

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
      console.error(`[action:${config.name}]`, err);
      return { ok: false, code: 'unknown', error: 'Something went wrong. Nothing was changed.' };
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
