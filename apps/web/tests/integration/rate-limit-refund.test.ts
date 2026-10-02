import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { consume, refund } from '../../src/lib/ratelimit';
import { ownerPool } from './_db';

/**
 * Giving back an attempt that an outage consumed.
 *
 * The case this exists for is real: onboarding allowed a handful of attempts an
 * hour, a misconfigured database made every one of them fail, and the user was
 * locked out of creating their company for an hour by failures that were not
 * theirs.
 */
describe('rate limit refunds', () => {
  let owner: Pool;
  const key = `test:refund:${Date.now().toString(36)}`;

  beforeAll(() => { owner = ownerPool(); });
  afterAll(async () => {
    await owner.query('delete from rate_limits where key like $1', ['test:refund:%']);
    await owner.end();
  });

  const countOf = async (k: string) =>
    Number((await owner.query<{ count: string }>('select count from rate_limits where key = $1', [k])).rows[0]?.count ?? 0);

  it('puts the attempt back', async () => {
    await consume(key, 3, 3600);
    await consume(key, 3, 3600);
    expect(await countOf(key)).toBe(2);

    await refund(key);
    expect(await countOf(key)).toBe(1);
  });

  it('lets a caller keep going after failures that were not theirs', async () => {
    const k = `${key}:outage`;
    // Three attempts against a limit of three, every one of them refunded.
    for (let i = 0; i < 3; i += 1) {
      await consume(k, 3, 3600);
      await refund(k);
    }
    const next = await consume(k, 3, 3600);
    expect(next.ok).toBe(true);
    expect(next.remaining).toBe(2);
  });

  it('never goes below zero', async () => {
    const k = `${key}:floor`;
    await consume(k, 3, 3600);
    await refund(k);
    await refund(k);
    await refund(k);
    expect(await countOf(k)).toBe(0);

    // And the window still counts up from there, rather than going negative and
    // handing out free attempts.
    await consume(k, 3, 3600);
    expect(await countOf(k)).toBe(1);
  });

  it('does nothing for a key that was never used', async () => {
    await expect(refund(`${key}:absent`)).resolves.toBeUndefined();
    expect(await countOf(`${key}:absent`)).toBe(0);
  });
});
