import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  attemptUnlock, hasPin, isPinLocked, isUnlocked, revokeUnlock, savePin,
} from '../../src/lib/db/screen-lock';
import { MAX_ATTEMPTS } from '../../src/lib/auth/pin';
import { cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * The screen lock against a real database.
 *
 * The parts worth proving here are the ones a unit test cannot: that the
 * lockout counter survives, that revoking an unlock takes effect at once, and
 * that one user's PIN is invisible to another.
 */
describe('screen lock', () => {
  let owner: Pool;
  let fx: Fixture;
  const PIN = '481902';

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `lock_${Date.now().toString(36)}`);
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  it('starts with no PIN', async () => {
    expect(await hasPin(fx.userB)).toBe(false);
  });

  it('stores a PIN without storing the PIN', async () => {
    await savePin(fx.userA, PIN);
    expect(await hasPin(fx.userA)).toBe(true);

    const { rows } = await owner.query<{ pin_hash: string; salt: string }>(
      'select pin_hash, salt from user_pins where user_id = $1',
      [fx.userA],
    );
    expect(rows[0]!.pin_hash).not.toContain(PIN);
    expect(rows[0]!.salt).not.toContain(PIN);
  });

  it('opens on the right PIN and not on a wrong one', async () => {
    const good = await attemptUnlock(fx.userA, PIN);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(await isUnlocked(fx.userA, good.token)).toBe(true);

    const bad = await attemptUnlock(fx.userA, '000001');
    expect(bad.ok).toBe(false);
  });

  it('makes a token from one user useless to another', async () => {
    const opened = await attemptUnlock(fx.userA, PIN);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // Their own token, somebody else's account.
    expect(await isUnlocked(fx.userB, opened.token)).toBe(false);
  });

  it('refuses a token that was never issued', async () => {
    expect(await isUnlocked(fx.userA, 'f'.repeat(64))).toBe(false);
    expect(await isUnlocked(fx.userA, undefined)).toBe(false);
  });

  it('revokes immediately, which is why the token is a row and not a signature', async () => {
    const opened = await attemptUnlock(fx.userA, PIN);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await revokeUnlock(fx.userA, opened.token);
    expect(await isUnlocked(fx.userA, opened.token)).toBe(false);
  });

  it('locks the PIN after five wrong guesses and stops accepting the right one', async () => {
    await savePin(fx.userB, PIN);

    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      const result = await attemptUnlock(fx.userB, '111112');
      expect(result.ok, `attempt ${i + 1}`).toBe(false);
      if (!result.ok && result.reason === 'wrong') {
        expect(result.attemptsLeft, `attempt ${i + 1}`).toBe(MAX_ATTEMPTS - i - 1);
      }
    }

    const last = await attemptUnlock(fx.userB, '111112');
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.reason).toBe('locked');
    expect(await isPinLocked(fx.userB)).toBe(true);

    // The right PIN is refused too. A lock that the correct PIN opens is not a
    // lock — it would only delay somebody who keeps guessing wrong.
    const correct = await attemptUnlock(fx.userB, PIN);
    expect(correct.ok).toBe(false);
    if (!correct.ok) expect(correct.reason).toBe('locked');
  });

  it('clears the lock when a new PIN is set, which only re-verification allows', async () => {
    await savePin(fx.userB, '305729');
    const { rows } = await owner.query<{ failed_attempts: number; locked_at: Date | null }>(
      'select failed_attempts, locked_at from user_pins where user_id = $1',
      [fx.userB],
    );
    expect(rows[0]!.failed_attempts).toBe(0);
    expect(rows[0]!.locked_at).toBeNull();
    expect(await isPinLocked(fx.userB)).toBe(false);

    const opened = await attemptUnlock(fx.userB, '305729');
    expect(opened.ok).toBe(true);
  });

  it('expires an unlock that has gone five minutes untouched', async () => {
    await savePin(fx.userA, PIN);
    const opened = await attemptUnlock(fx.userA, PIN);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await isUnlocked(fx.userA, opened.token)).toBe(true);

    // Age it past the idle window.
    await owner.query(
      `update pin_unlocks set last_seen_at = now() - interval '6 minutes'
        where user_id = $1 and revoked_at is null`,
      [fx.userA],
    );
    expect(await isUnlocked(fx.userA, opened.token)).toBe(false);
  });

  it('refreshes the idle clock on every check, so working keeps it open', async () => {
    await savePin(fx.userA, PIN);
    const opened = await attemptUnlock(fx.userA, PIN);
    if (!opened.ok) return;

    await owner.query(
      `update pin_unlocks set last_seen_at = now() - interval '4 minutes'
        where user_id = $1 and revoked_at is null`,
      [fx.userA],
    );
    expect(await isUnlocked(fx.userA, opened.token)).toBe(true);

    // That check moved it back to now, so four more minutes is still fine.
    await owner.query(
      `update pin_unlocks set last_seen_at = now() - interval '4 minutes'
        where user_id = $1 and revoked_at is null`,
      [fx.userA],
    );
    expect(await isUnlocked(fx.userA, opened.token)).toBe(true);
  });

  it('kills every live unlock when the PIN changes', async () => {
    await savePin(fx.userA, PIN);
    const opened = await attemptUnlock(fx.userA, PIN);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await savePin(fx.userA, '860413');
    expect(await isUnlocked(fx.userA, opened.token)).toBe(false);
  });

  it('reports no PIN rather than a wrong one when none is set', async () => {
    const result = await attemptUnlock(fx.userB, PIN);
    if (!result.ok && result.reason === 'no_pin') {
      expect(result.reason).toBe('no_pin');
    }
    // userB has a PIN by now; assert the shape on a user that does not.
    const { rows } = await owner.query<{ id: string }>(
      'select app_ensure_user($1, $2, $3, true) as id',
      [`lock_nopin_${Date.now()}`, `nopin_${Date.now()}@test.invalid`, 'No PIN'],
    );
    const fresh = await attemptUnlock(rows[0]!.id, PIN);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.reason).toBe('no_pin');
  });
});
