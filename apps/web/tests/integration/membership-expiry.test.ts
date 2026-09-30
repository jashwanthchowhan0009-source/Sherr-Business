import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { appPool, cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * Time-boxed access for external CAs and auditors. Expiry is applied by
 * app_resolve_membership at request time rather than by a scheduled job, so a
 * lapsed membership is refused on the next request — not on the next cron run.
 */
describe('membership expiry', () => {
  let app: Pool;
  let owner: Pool;
  let fx: Fixture;

  const resolve = (clerkOrgId: string, clerkUserId: string) =>
    app
      .query('select * from app_resolve_membership($1, $2)', [clerkOrgId, clerkUserId])
      .then((r) => r.rows);

  let clerkOrgA = '';
  let clerkUserA = '';

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `exp${Date.now()}`);
    clerkOrgA = (
      await owner.query<{ c: string }>('select clerk_org_id as c from organizations where id = $1', [
        fx.orgA,
      ])
    ).rows[0]!.c;
    clerkUserA = (
      await owner.query<{ c: string }>('select clerk_user_id as c from users where id = $1', [
        fx.userA,
      ])
    ).rows[0]!.c;
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await app.end();
    await owner.end();
  });

  it('resolves an active membership', async () => {
    const rows = await resolve(clerkOrgA, clerkUserA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('owner');
  });

  it('refuses a membership past valid_to', async () => {
    await owner.query(
      `update memberships set valid_from = now() - interval '2 days',
                              valid_to   = now() - interval '1 day'
        where org_id = $1 and user_id = $2`,
      [fx.orgA, fx.userA],
    );
    expect(await resolve(clerkOrgA, clerkUserA)).toHaveLength(0);
  });

  it('refuses a membership that has not started', async () => {
    await owner.query(
      `update memberships set valid_from = now() + interval '1 day', valid_to = null
        where org_id = $1 and user_id = $2`,
      [fx.orgA, fx.userA],
    );
    expect(await resolve(clerkOrgA, clerkUserA)).toHaveLength(0);
  });

  it('refuses a suspended membership', async () => {
    await owner.query(
      `update memberships set valid_from = now() - interval '1 day', valid_to = null,
                              status = 'suspended'
        where org_id = $1 and user_id = $2`,
      [fx.orgA, fx.userA],
    );
    expect(await resolve(clerkOrgA, clerkUserA)).toHaveLength(0);
  });

  it('refuses access to an organization the user does not belong to', async () => {
    const clerkOrgB = (
      await owner.query<{ c: string }>('select clerk_org_id as c from organizations where id = $1', [
        fx.orgB,
      ])
    ).rows[0]!.c;
    expect(await resolve(clerkOrgB, clerkUserA)).toHaveLength(0);
  });
});
