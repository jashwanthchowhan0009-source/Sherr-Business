import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { appPool, ownerPool } from './_db';

/**
 * RLS is only as good as the role the application connects as. A role that owns
 * the tables, or holds BYPASSRLS, silently ignores every policy — and the
 * failure is invisible, because queries keep working and simply return too much.
 */
describe('application role privileges', () => {
  let app: Pool;
  let owner: Pool;

  beforeAll(() => {
    app = appPool();
    owner = ownerPool();
  });

  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  it('is not the same role the migrations run as', async () => {
    const appUser = (await app.query<{ u: string }>('select current_user as u')).rows[0]!.u;
    const ownerUser = (await owner.query<{ u: string }>('select current_user as u')).rows[0]!.u;
    expect(appUser).not.toBe(ownerUser);
  });

  it('has neither SUPERUSER nor BYPASSRLS', async () => {
    const { rows } = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(rows[0]!.rolsuper).toBe(false);
    expect(rows[0]!.rolbypassrls).toBe(false);
  });

  it('owns no tables', async () => {
    const { rows } = await app.query<{ n: string }>(
      `select count(*)::text as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r     on r.oid = c.relowner
        where n.nspname = 'public' and c.relkind = 'r' and r.rolname = current_user`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('cannot create tables in the public schema', async () => {
    await expect(app.query('create table rls_probe (id int)')).rejects.toThrow(/permission denied/i);
  });

  it('cannot create an organization directly, only through the vetted function', async () => {
    await expect(
      app.query(`insert into organizations (clerk_org_id, legal_name) values ('x','y')`),
    ).rejects.toThrow(/permission denied/i);
  });
});
