import 'server-only';
import { sql } from 'drizzle-orm';
// rate_limits is a system table keyed by actor, not by tenant: it has no org_id
// and therefore no RLS policy to satisfy. It is also consulted BEFORE the tenant
// transaction opens, so it cannot go through withTenant().
// tests/unit/db-encapsulation.test.ts lists this file as the sole exception.
// eslint-disable-next-line no-restricted-imports
import { appDb } from '@/lib/db/pool';

/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * In-memory counters are wrong on Vercel: each lambda instance keeps its own,
 * so the effective limit is (limit x instances). Postgres is shared, which is
 * what a limit needs to be. It costs one round trip per guarded call — fine at
 * Phase 1 volumes.
 *
 * Swap point: when this shows up in latency traces, replace the body of
 * `consume` with an Upstash Redis INCR/EXPIRE. The signature stays the same.
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: Date;
}

export async function consume(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const rows = await appDb().execute<{ count: number; window_start: Date }>(sql`
    insert into rate_limits (key, window_start, count)
    values (${key}, date_trunc('second', now()), 1)
    on conflict (key) do update
      set count = case
            when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
            then 1
            else rate_limits.count + 1
          end,
          window_start = case
            when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
            then date_trunc('second', now())
            else rate_limits.window_start
          end
    returning count, window_start
  `);

  const row = rows.rows[0];
  if (!row) return { ok: true, remaining: limit - 1, resetAt: new Date(Date.now() + windowSeconds * 1000) };

  const count = Number(row.count);
  const resetAt = new Date(new Date(row.window_start).getTime() + windowSeconds * 1000);
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt };
}

/** Removes windows that can no longer affect a decision. Call from a cron later. */
export async function pruneRateLimits(olderThanSeconds = 3600): Promise<void> {
  await appDb().execute(
    sql`delete from rate_limits where window_start < now() - make_interval(secs => ${olderThanSeconds})`,
  );
}

/**
 * Gives back one unit of a window that was consumed for nothing.
 *
 * A limit exists to stop somebody hammering an action, not to punish them for
 * an outage. When a handler fails for a reason that is not the caller's doing —
 * a database that is unreachable, a credential that is wrong — charging them for
 * the attempt means three bad minutes can cost an hour of being locked out of
 * onboarding, with nothing they can do about it.
 *
 * Never drops below zero, and never extends the window: a refund in a window
 * that has already rolled over is simply a no-op.
 */
export async function refund(key: string): Promise<void> {
  await appDb().execute(sql`
    update rate_limits set count = greatest(0, count - 1) where key = ${key}
  `);
}
