import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withUser } from './tenant';
import { hashPin, lockoutFor, newUnlockToken, verifyPin } from '@/lib/auth/pin';

/** How long an unlock lasts if nothing revokes it sooner. */
export const UNLOCK_TTL_SECONDS = 8 * 60 * 60;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export async function hasPin(userId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from user_pins where user_id = ${userId}::uuid`,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  });
}

/** Sets or replaces the PIN, and revokes every live unlock for that user. */
export async function savePin(userId: string, pin: string): Promise<void> {
  const { hash, salt } = await hashPin(pin);
  await withUser(userId, async (tx) => {
    await tx.execute(sql`
      insert into user_pins (user_id, pin_hash, salt)
      values (${userId}::uuid, ${hash}, ${salt})
      on conflict (user_id) do update
        set pin_hash = excluded.pin_hash, salt = excluded.salt,
            failed_attempts = 0, locked_until = null, updated_at = now()
    `);
    // A new PIN means the old one no longer opens anything.
    await tx.execute(sql`
      update pin_unlocks set revoked_at = now()
       where user_id = ${userId}::uuid and revoked_at is null
    `);
  });
}

export type UnlockOutcome =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'no_pin' | 'wrong'; retryAfterSeconds: number; attemptsLeft: number };

/**
 * Checks a PIN and, on success, opens an unlock.
 *
 * The lockout is read and written in the same transaction as the check, so two
 * requests racing cannot each see four failures and each get a free guess.
 */
export async function attemptUnlock(userId: string, pin: string): Promise<UnlockOutcome> {
  return withUser(userId, async (tx) => {
    const { rows } = await tx.execute<{
      pin_hash: string; salt: string; failed_attempts: number; locked_for: number | null;
    }>(sql`
      select pin_hash, salt, failed_attempts,
             greatest(0, ceil(extract(epoch from (locked_until - now()))))::int as locked_for
        from user_pins where user_id = ${userId}::uuid
        for update
    `);

    const row = rows[0];
    if (!row) return { ok: false as const, reason: 'no_pin' as const, retryAfterSeconds: 0, attemptsLeft: 0 };

    if ((row.locked_for ?? 0) > 0) {
      return {
        ok: false as const,
        reason: 'wrong' as const,
        retryAfterSeconds: row.locked_for ?? 0,
        attemptsLeft: 0,
      };
    }

    if (!(await verifyPin(pin, { hash: row.pin_hash, salt: row.salt }))) {
      const failures = row.failed_attempts + 1;
      const wait = lockoutFor(failures);
      await tx.execute(sql`
        update user_pins
           set failed_attempts = ${failures},
               locked_until = case when ${wait} > 0
                                   then now() + make_interval(secs => ${wait}) end,
               updated_at = now()
         where user_id = ${userId}::uuid
      `);
      return {
        ok: false as const,
        reason: 'wrong' as const,
        retryAfterSeconds: wait,
        attemptsLeft: Math.max(0, 4 - failures),
      };
    }

    await tx.execute(sql`
      update user_pins set failed_attempts = 0, locked_until = null, updated_at = now()
       where user_id = ${userId}::uuid
    `);

    const token = newUnlockToken();
    const { rows: created } = await tx.execute<{ expires_at: string }>(sql`
      insert into pin_unlocks (user_id, token_hash, expires_at)
      values (${userId}::uuid, ${digest(token)},
              now() + make_interval(secs => ${UNLOCK_TTL_SECONDS}))
      returning expires_at
    `);
    return { ok: true as const, token, expiresAt: new Date(created[0]!.expires_at) };
  });
}

/** Whether this token still opens the app for this user. */
export async function isUnlocked(userId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return withUser(userId, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from pin_unlocks
       where user_id = ${userId}::uuid and token_hash = ${digest(token)}
         and revoked_at is null and expires_at > now()
    `);
    return Number(rows[0]?.n ?? 0) > 0;
  });
}

/** Ends an unlock. Called when the tab is hidden and when the user locks. */
export async function revokeUnlock(userId: string, token: string | undefined): Promise<void> {
  if (!token) return;
  await withUser(userId, (tx) =>
    tx.execute(sql`
      update pin_unlocks set revoked_at = now()
       where user_id = ${userId}::uuid and token_hash = ${digest(token)} and revoked_at is null
    `),
  );
}
