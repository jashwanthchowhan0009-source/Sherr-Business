import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { appPool, asTenant, cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';

/**
 * A record that can be edited is not evidence. Append-only is enforced by
 * withholding the UPDATE and DELETE privileges, not by a policy or a convention
 * in application code — so it holds even for code paths nobody reviewed.
 */
describe('audit_logs is append-only', () => {
  let app: Pool;
  let owner: Pool;
  let fx: Fixture;

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `audit${Date.now()}`);
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await app.end();
    await owner.end();
  });

  it('grants the application role INSERT and SELECT only', async () => {
    const { rows } = await app.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
        where table_name = 'audit_logs' and grantee = current_user`,
    );
    const granted = rows.map((r) => r.privilege_type).sort();
    expect(granted).toEqual(['INSERT', 'SELECT']);
  });

  it('can append a row within its own tenant', async () => {
    const inserted = await asTenant(app, fx.orgA, async (c) => {
      const { rowCount } = await c.query(
        `insert into audit_logs (org_id, action, subject_kind) values ($1, 'test.append', 'test')`,
        [fx.orgA],
      );
      return rowCount;
    });
    expect(inserted).toBe(1);
  });

  it('cannot append a row attributed to another tenant', async () => {
    await expect(
      asTenant(app, fx.orgA, (c) =>
        c.query(`insert into audit_logs (org_id, action, subject_kind) values ($1, 'forged', 'test')`, [
          fx.orgB,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot rewrite history', async () => {
    await expect(
      asTenant(app, fx.orgA, (c) => c.query(`update audit_logs set action = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot delete history', async () => {
    await expect(
      asTenant(app, fx.orgA, (c) => c.query('delete from audit_logs')),
    ).rejects.toThrow(/permission denied/i);
  });
});
