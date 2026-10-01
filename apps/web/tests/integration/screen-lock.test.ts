import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { attemptUnlock, hasPin, isUnlocked, revokeUnlock, savePin } from '../../src/lib/db/screen-lock';
import { FREE_ATTEMPTS } from '../../src/lib/auth/pin';
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

  it('counts failures and eventually makes the caller wait', async () => {
    await savePin(fx.userB, PIN);

    for (let i = 0; i < FREE_ATTEMPTS; i += 1) {
      const result = await attemptUnlock(fx.userB, '111112');
      expect(result.ok, `attempt ${i + 1}`).toBe(false);
      if (!result.ok) expect(result.retryAfterSeconds, `attempt ${i + 1}`).toBe(0);
    }

    // The one after the free attempts costs time.
    const limited = await attemptUnlock(fx.userB, '111112');
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.retryAfterSeconds).toBeGreaterThan(0);

    // And the right PIN is refused too while the wait is running — otherwise
    // the lockout would only delay somebody who keeps guessing wrong.
    const during = await attemptUnlock(fx.userB, PIN);
    expect(during.ok).toBe(false);
  });

  it('clears the count and the wait when the PIN is replaced', async () => {
    await savePin(fx.userB, '305729');
    const { rows } = await owner.query<{ failed_attempts: number; locked_until: Date | null }>(
      'select failed_attempts, locked_until from user_pins where user_id = $1',
      [fx.userB],
    );
    expect(rows[0]!.failed_attempts).toBe(0);
    expect(rows[0]!.locked_until).toBeNull();

    const opened = await attemptUnlock(fx.userB, '305729');
    expect(opened.ok).toBe(true);
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
