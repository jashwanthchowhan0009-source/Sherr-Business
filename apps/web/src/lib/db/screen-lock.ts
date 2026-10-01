import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withUser } from './tenant';
import {
  ABSOLUTE_TIMEOUT_SECONDS,
  IDLE_TIMEOUT_SECONDS,
  attemptsLeft,
  hashPin,
  isLockedOut,
  newUnlockToken,
  verifyPin,
} from '@/lib/auth/pin';

/** The outer bound on an unlock. Idleness usually ends it long before. */
export const UNLOCK_TTL_SECONDS = ABSOLUTE_TIMEOUT_SECONDS;

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
            failed_attempts = 0, locked_at = null, updated_at = now()
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
  | { ok: false; reason: 'no_pin' }
  | { ok: false; reason: 'locked' }
  | { ok: false; reason: 'wrong'; attemptsLeft: number };

/**
 * Checks a PIN and, on success, opens an unlock.
 *
 * The count is read and written in the same transaction as the check, under a
 * row lock, so two requests racing cannot each see four failures and each get a
 * free guess.
 */
export async function attemptUnlock(userId: string, pin: string): Promise<UnlockOutcome> {
  return withUser(userId, async (tx) => {
    const { rows } = await tx.execute<{
      pin_hash: string; salt: string; failed_attempts: number; locked: boolean;
    }>(sql`
      select pin_hash, salt, failed_attempts, (locked_at is not null) as locked
        from user_pins where user_id = ${userId}::uuid
        for update
    `);

    const row = rows[0];
    if (!row) return { ok: false as const, reason: 'no_pin' as const };
    if (row.locked) return { ok: false as const, reason: 'locked' as const };

    if (!(await verifyPin(pin, { hash: row.pin_hash, salt: row.salt }))) {
      const failures = row.failed_attempts + 1;
      await tx.execute(sql`
        update user_pins
           set failed_attempts = ${failures},
               locked_at = case when ${isLockedOut(failures)} then now() end,
               updated_at = now()
         where user_id = ${userId}::uuid
      `);
      return isLockedOut(failures)
        ? { ok: false as const, reason: 'locked' as const }
        : { ok: false as const, reason: 'wrong' as const, attemptsLeft: attemptsLeft(failures) };
    }

    await tx.execute(sql`
      update user_pins set failed_attempts = 0, updated_at = now()
       where user_id = ${userId}::uuid
    `);

    const token = newUnlockToken();
    const { rows: created } = await tx.execute<{ expires_at: string }>(sql`
      insert into pin_unlocks (user_id, token_hash, expires_at)
      values (${userId}::uuid, ${digest(token)},
              now() + make_interval(secs => ${ABSOLUTE_TIMEOUT_SECONDS}))
      returning expires_at
    `);
    return { ok: true as const, token, expiresAt: new Date(created[0]!.expires_at) };
  });
}

/** Whether the PIN is locked out and needs re-verification to use again. */
export async function isPinLocked(userId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const { rows } = await tx.execute<{ locked: boolean }>(sql`
      select (locked_at is not null) as locked from user_pins where user_id = ${userId}::uuid
    `);
    return rows[0]?.locked === true;
  });
}

/**
 * Replaces the PIN after the second factor has been re-verified.
 *
 * The caller is responsible for that check; this is the only path that clears a
 * lock, which is why it is a separate function from {@link savePin} rather than
 * a flag on it.
 */
export async function resetPinAfterReverification(userId: string, pin: string): Promise<void> {
  await savePin(userId, pin);
}

/** Whether this token still opens the app for this user. */
export async function isUnlocked(userId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return withUser(userId, async (tx) => {
    // Checked and refreshed in one statement. Doing it in two would let a
    // request that arrives exactly on the boundary read a live row and then
    // extend one that had just died.
    const { rows } = await tx.execute<{ id: string }>(sql`
      update pin_unlocks set last_seen_at = now()
       where user_id = ${userId}::uuid and token_hash = ${digest(token)}
         and revoked_at is null
         and expires_at > now()
         and last_seen_at > now() - make_interval(secs => ${IDLE_TIMEOUT_SECONDS})
       returning id
    `);
    return rows.length > 0;
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
