import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ACCOUNTS, ACCOUNT_GROUPS, rootGroupOf } from '../../src/lib/accounting/chart-of-accounts';
import { appPool, asTenant, ownerPool } from './_db';

/**
 * Company creation has to be atomic: the organization, its owner, its GSTIN and
 * its chart of accounts either all exist or none do. A company with no accounts
 * cannot record anything, and one with no owner cannot be administered by
 * anybody — neither is a state the application can recover from.
 */
describe('company onboarding', () => {
  let app: Pool;
  let owner: Pool;
  const tag = `onb${Date.now()}`;
  let userId = '';
  let orgA = '';
  let orgB = '';

  const createCompany = async (slug: string, legalName: string, gstin: string | null) => {
    const { rows } = await owner.query<{ id: string }>(
      `select app_create_company(
         $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::date, $11::jsonb, $12::jsonb
       ) as id`,
      [
        `org_${tag}_${slug}`,
        legalName,
        userId,
        `${legalName} Trading`,
        gstin,
        gstin ? gstin.slice(2, 12) : null,
        gstin ? gstin.slice(0, 2) : null,
        'regular',
        4,
        '2026-04-01',
        JSON.stringify(ACCOUNT_GROUPS),
        JSON.stringify(ACCOUNTS),
      ],
    );
    return rows[0]!.id;
  };

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    const { rows } = await owner.query<{ id: string }>(
      'select app_ensure_user($1, $2, $3, true) as id',
      [`user_${tag}`, `${tag}@test.invalid`, 'Onboarding Tester'],
    );
    userId = rows[0]!.id;

    orgA = await createCompany('a', 'Alpha Traders Pvt Ltd', '27AAPFU0939F1ZV');
    orgB = await createCompany('b', 'Beta Exports Pvt Ltd', '24AAACC1206D1ZM');
  });

  afterAll(async () => {
    await owner.query('delete from organizations where id = any($1::uuid[])', [[orgA, orgB]]);
    await owner.query('delete from users where id = $1', [userId]);
    await app.end();
    await owner.end();
  });

  it('makes the creator an owner', async () => {
    const { rows } = await owner.query<{ role: string }>(
      'select role from memberships where org_id = $1 and user_id = $2',
      [orgA, userId],
    );
    expect(rows[0]?.role).toBe('owner');
  });

  it('records the GSTIN and derives state and PAN from it', async () => {
    const org = (
      await owner.query('select pan, state_code, registration_type, books_start_date from organizations where id = $1', [orgA])
    ).rows[0];
    expect(org.pan).toBe('AAPFU0939F');
    expect(org.state_code).toBe('27');
    expect(org.registration_type).toBe('regular');
    expect(org.books_start_date).toBeTruthy();

    const reg = (
      await owner.query('select number from org_registrations where org_id = $1 and kind = $2', [orgA, 'gstin'])
    ).rows[0];
    expect(reg.number).toBe('27AAPFU0939F1ZV');
  });

  it('seeds the whole chart of accounts', async () => {
    const groups = await owner.query<{ n: string }>(
      'select count(*)::text as n from account_groups where org_id = $1', [orgA],
    );
    const accounts = await owner.query<{ n: string }>(
      'select count(*)::text as n from accounts where org_id = $1', [orgA],
    );
    expect(Number(groups.rows[0]!.n)).toBe(ACCOUNT_GROUPS.length);
    expect(Number(accounts.rows[0]!.n)).toBe(ACCOUNTS.length);
  });

  it('gives every account the nature of its group', async () => {
    const { rows } = await owner.query<{ code: string; nature: string; group_code: string }>(
      `select a.code, a.nature, g.code as group_code
         from accounts a join account_groups g on g.id = a.group_id
        where a.org_id = $1`,
      [orgA],
    );
    expect(rows).toHaveLength(ACCOUNTS.length);
    for (const row of rows) {
      // The seed never supplies an account nature; it is taken from the group,
      // so a mismatch here means the join went wrong.
      expect(row.nature, row.code).toBe(rootGroupOf(row.group_code).nature);
    }
  });

  it('links child groups to their parents within the same company', async () => {
    const { rows } = await owner.query<{ code: string; parent_code: string | null }>(
      `select g.code, p.code as parent_code
         from account_groups g left join account_groups p on p.id = g.parent_id
        where g.org_id = $1`,
      [orgA],
    );
    const bySeed = new Map(ACCOUNT_GROUPS.map((g) => [g.code, g.parent]));
    for (const row of rows) {
      expect(row.parent_code ?? null, row.code).toBe(bySeed.get(row.code) ?? null);
    }
  });

  it('seeds the accounts the engines reference by code', async () => {
    const { rows } = await owner.query<{ code: string }>(
      'select code from accounts where org_id = $1 and is_system', [orgA],
    );
    const codes = rows.map((r) => r.code);
    for (const required of ['ROUND_OFF', 'OUTPUT_CGST', 'INPUT_IGST', 'SUNDRY_DEBTORS', 'SALES']) {
      expect(codes, required).toContain(required);
    }
  });

  it('writes one audit row naming how many accounts were seeded', async () => {
    const { rows } = await owner.query<{ action: string; after: { accounts_seeded: number } }>(
      `select action, after from audit_logs where org_id = $1 and action = 'company.created'`,
      [orgA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after.accounts_seeded).toBe(ACCOUNTS.length);
  });

  it('keeps one company\'s chart invisible to another', async () => {
    const visible = await asTenant(app, orgA, async (c) => {
      const groups = await c.query<{ n: string }>(
        'select count(*)::text as n from account_groups where org_id = $1', [orgB],
      );
      const accounts = await c.query<{ n: string }>(
        'select count(*)::text as n from accounts where org_id = $1', [orgB],
      );
      return [Number(groups.rows[0]!.n), Number(accounts.rows[0]!.n)];
    });
    expect(visible).toEqual([0, 0]);
  });

  it('shows a company exactly its own accounts and no more', async () => {
    const [mine, all] = await asTenant(app, orgA, async (c) => {
      const scoped = await c.query<{ n: string }>(
        'select count(*)::text as n from accounts where org_id = $1', [orgA],
      );
      const everything = await c.query<{ n: string }>('select count(*)::text as n from accounts');
      return [Number(scoped.rows[0]!.n), Number(everything.rows[0]!.n)];
    });
    expect(mine).toBe(ACCOUNTS.length);
    expect(all).toBe(mine);
  });

  it('refuses a second company on the same Clerk organization', async () => {
    // on conflict (clerk_org_id) do update — the same org id must not spawn a
    // second company, it updates the existing one.
    const again = await createCompany('a', 'Alpha Traders Pvt Ltd', '27AAPFU0939F1ZV');
    expect(again).toBe(orgA);
    const { rows } = await owner.query<{ n: string }>(
      'select count(*)::text as n from accounts where org_id = $1', [orgA],
    );
    expect(Number(rows[0]!.n), 'accounts must not be duplicated').toBe(ACCOUNTS.length);
  });
});
