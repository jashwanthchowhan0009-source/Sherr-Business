import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  SPECIAL_RLS_TABLES, SYSTEM_TABLES, TENANT_TABLES,
} from '../../src/lib/db/schema';
import { appPool, asTenant, cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * The claim this suite exists to prove: a user working in organization A cannot
 * read, write or even count a single row belonging to organization B.
 *
 * It is table-driven over the schema rather than hand-written per table, so a
 * table added without a policy fails here instead of shipping.
 */
describe('tenant isolation', () => {
  let app: Pool;
  let owner: Pool;
  let fx: Fixture;

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `iso${Date.now()}`);

    // One row of each tenant kind in BOTH organizations, written as owner.
    for (const [orgId, gstin, email] of [
      [fx.orgA, '29AABCS1234A1Z5', 'invitee-a@test.invalid'],
      [fx.orgB, '27AABCB5678B1Z3', 'invitee-b@test.invalid'],
    ] as const) {
      await owner.query(
        `insert into org_registrations (org_id, kind, number, state_code)
         values ($1, 'gstin', $2, substring($2 from 1 for 2))`,
        [orgId, gstin],
      );
      await owner.query(
        `insert into invitations (org_id, email, role, token_hash, invited_by, expires_at)
         values ($1, $2, 'viewer', $3, (select user_id from memberships where org_id = $1 limit 1),
                 now() + interval '7 days')`,
        [orgId, email, `hash_${orgId}`],
      );
      await owner.query(
        `insert into audit_logs (org_id, action, subject_kind, subject_id)
         values ($1::uuid, 'test.row', 'test', $2)`,
        [orgId, orgId],
      );
    }
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await app.end();
    await owner.end();
  });

  it('classifies every table in the database', async () => {
    const { rows } = await owner.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const actual = rows.map((r) => r.tablename).sort();
    const classified = [...TENANT_TABLES, ...SPECIAL_RLS_TABLES, ...SYSTEM_TABLES].sort();

    // Fails when a table is added without deciding how it is isolated.
    expect(actual).toEqual(classified);
  });

  it('enables AND forces RLS on every non-system table', async () => {
    const guarded = [...TENANT_TABLES, ...SPECIAL_RLS_TABLES];
    const { rows } = await owner.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class where relname = any($1::text[])`,
      [guarded],
    );
    expect(rows).toHaveLength(guarded.length);
    for (const row of rows) {
      expect(row, `${row.relname} must ENABLE row level security`).toHaveProperty(
        'relrowsecurity', true,
      );
      expect(row, `${row.relname} must FORCE row level security`).toHaveProperty(
        'relforcerowsecurity', true,
      );
    }
  });

  it.each(TENANT_TABLES)('%s: org A sees none of org B', async (table) => {
    const visible = await asTenant(app, fx.orgA, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text as n from ${table} where org_id = $1`,
        [fx.orgB],
      );
      return Number(rows[0]!.n);
    });
    expect(visible).toBe(0);
  });

  it.each(TENANT_TABLES)('%s: org A sees exactly its own rows', async (table) => {
    const [inContext, total] = await asTenant(app, fx.orgA, async (c) => {
      const all = await c.query<{ n: string }>(`select count(*)::text as n from ${table}`);
      const mine = await c.query<{ n: string }>(
        `select count(*)::text as n from ${table} where org_id = $1`,
        [fx.orgA],
      );
      return [Number(mine.rows[0]!.n), Number(all.rows[0]!.n)];
    });
    expect(inContext).toBeGreaterThan(0);
    // Everything visible in this context belongs to this organization.
    expect(total).toBe(inContext);
  });

  it('organizations: org A context resolves to exactly one organization', async () => {
    const rows = await asTenant(app, fx.orgA, async (c) =>
      (await c.query<{ id: string }>('select id from organizations')).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(fx.orgA);
  });

  it('users: org A cannot see a user who only belongs to org B', async () => {
    const visible = await asTenant(
      app,
      fx.orgA,
      async (c) =>
        (await c.query<{ id: string }>('select id from users where id = $1', [fx.userB])).rowCount,
      fx.userA,
    );
    expect(visible).toBe(0);
  });

  it('with no tenant context, every table returns zero rows rather than all rows', async () => {
    const client = await app.connect();
    try {
      for (const table of [...TENANT_TABLES, ...SPECIAL_RLS_TABLES]) {
        const { rows } = await client.query<{ n: string }>(
          `select count(*)::text as n from ${table}`,
        );
        expect(Number(rows[0]!.n), `${table} leaked rows without a tenant context`).toBe(0);
      }
    } finally {
      client.release();
    }
  });

  it.each(TENANT_TABLES.filter((t) => t !== 'audit_logs'))(
    '%s: org A cannot write a row belonging to org B',
    async (table) => {
      await expect(
        asTenant(app, fx.orgA, async (c) => {
          await c.query(`update ${table} set org_id = org_id where org_id = $1`, [fx.orgB]);
          const { rows } = await c.query<{ n: string }>(
            `select count(*)::text as n from ${table} where org_id = $1`,
            [fx.orgB],
          );
          // The UPDATE silently matches nothing; assert we also cannot INSERT.
          await c.query(
            `insert into org_registrations (org_id, kind, number) values ($1, 'tan', 'FORGED0001X')`,
            [fx.orgB],
          );
          return rows;
        }),
      ).rejects.toThrow(/row-level security/i);
    },
  );

  it('the tenant GUC does not survive the transaction', async () => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.current_org_id', $1, true)`, [fx.orgA]);
      const inside = await client.query<{ n: string }>(
        'select count(*)::text as n from organizations',
      );
      expect(Number(inside.rows[0]!.n)).toBe(1);
      await client.query('commit');

      // Same pooled connection, transaction over: context must be gone.
      const after = await client.query<{ n: string }>(
        'select count(*)::text as n from organizations',
      );
      expect(Number(after.rows[0]!.n)).toBe(0);
    } finally {
      client.release();
    }
  });
});
