import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * The lock's audit trail, against a real database.
 *
 * Asked for explicitly: setting a PIN, resetting one and failing one must all
 * leave a row. Worth proving here rather than in a unit test, because the thing
 * that can go wrong is at the database boundary — `audit_logs.org_id` is not
 * null, and the lock runs on the account-scoped path that has no organization of
 * its own, so the row only lands if the context is resolved first.
 */
const context = vi.fn();
vi.mock('../../src/lib/auth/context', () => ({ optionalOrgContext: context }));

const { auditSecurityEvent } = await import('../../src/lib/audit/security');

describe('screen lock auditing', () => {
  let owner: Pool;
  let fx: Fixture;

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `lockaudit_${Date.now().toString(36)}`);
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  beforeEach(() => {
    context.mockResolvedValue({
      orgId: fx.orgA,
      userId: fx.userA,
      role: 'owner',
      ip: '203.0.113.7',
      userAgent: 'vitest',
    });
  });

  type Row = {
    action: string;
    subject_kind: string;
    subject_id: string | null;
    actor_user_id: string | null;
    org_id: string;
    after: Record<string, unknown> | null;
  };

  const rowsFor = async (action: string) =>
    (
      await owner.query<Row>(
        `select action, subject_kind, subject_id, actor_user_id, org_id, after
           from audit_logs where org_id = $1 and action = $2 order by at`,
        [fx.orgA, action],
      )
    ).rows;

  it.each([
    'screenlock.pin.created',
    'screenlock.pin.reset',
    'screenlock.failed',
    'screenlock.locked_out',
  ])('records %s against the user and the company', async (action) => {
    await auditSecurityEvent({ action, subjectId: fx.userA });

    const rows = await rowsFor(action);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[rows.length - 1]!;
    expect(row.subject_kind).toBe('screen_lock');
    expect(row.subject_id).toBe(fx.userA);
    expect(row.actor_user_id).toBe(fx.userA);
    expect(row.org_id).toBe(fx.orgA);
  });

  it('keeps the detail it is given, and nothing resembling a PIN', async () => {
    await auditSecurityEvent({
      action: 'screenlock.failed',
      subjectId: fx.userA,
      after: { attemptsLeft: 3 },
    });

    const rows = await rowsFor('screenlock.failed');
    const withDetail = rows.find((r) => r.after !== null);
    expect(withDetail?.after).toEqual({ attemptsLeft: 3 });

    // Nothing the row carries may contain six consecutive digits. An audit
    // trail that records the attempted PIN would hand anybody with read access
    // exactly what the lock exists to withhold.
    //
    // The generated identifiers are excluded, and must be: a random UUID
    // contains six consecutive digits often enough that keeping them in made
    // this test fail on a later run with nothing wrong. They are not somewhere
    // a PIN could arrive — the only input is `after`.
    for (const row of rows) {
      const { action, subject_kind, after } = row;
      expect(JSON.stringify({ action, subject_kind, after })).not.toMatch(/\d{6}/);
    }
  });

  it('drops the row rather than throwing when there is no company yet', async () => {
    // A reset must never fail because its audit row has nowhere to go: the
    // security action is the point, the record is the by-product.
    context.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      auditSecurityEvent({ action: 'screenlock.pin.created', subjectId: fx.userB }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('writes nothing into the other company', async () => {
    await auditSecurityEvent({ action: 'screenlock.pin.created', subjectId: fx.userA });
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from audit_logs where org_id = $1 and action like 'screenlock.%'`,
      [fx.orgB],
    );
    expect(rows[0]!.n).toBe('0');
  });
});
