import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  SHARED_REFERENCE_TABLES, SPECIAL_RLS_TABLES, SYSTEM_TABLES, TENANT_TABLES,
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
      // Every tenant table needs a row in both organizations, or the
      // "sees exactly its own rows" case below proves nothing for it.
      await owner.query(
        `insert into account_groups (org_id, code, name, nature, bucket)
         values ($1, 'TEST_GROUP', 'Test Group', 'asset', 'current_assets')`,
        [orgId],
      );
      await owner.query(
        `insert into accounts (org_id, group_id, code, name, nature)
         select $1, g.id, 'TEST_ACCOUNT', 'Test Account', g.nature
           from account_groups g where g.org_id = $1 and g.code = 'TEST_GROUP'`,
        [orgId],
      );

      // The step B voucher core. The invoice stays a draft so the fixture is
      // not asserting anything about the balance trigger — that has its own
      // suite — but its two ledger entries balance anyway, so the rows here are
      // representative of real data rather than a shape that could never post.
      await owner.query(
        `with party as (
           insert into parties (org_id, kind, name, gstin, state_code)
           values ($1, 'customer', 'Test Party', $2, substring($2 from 1 for 2))
           returning id
         ), item as (
           insert into items (org_id, code, name, hsn_sac, gst_rate_bps, unit)
           values ($1, 'TEST_ITEM', 'Test Item', '1006', 1800, 'KGS')
           returning id
         ), series as (
           insert into number_series (org_id, voucher_type, fy_label, prefix)
           values ($1, 'sales', '25-26', 'TEST')
           returning id
         ), invoice as (
           insert into vouchers (
             org_id, voucher_type, voucher_no, fy_label, voucher_date, party_id,
             supplier_state_code, place_of_supply_state_code, supply_type,
             taxable_paise, cgst_paise, sgst_paise, total_paise
           )
           select $1, 'sales', 'TEST/1', '25-26', current_date, party.id,
                  '29', '29', 'intra_state', 100000, 9000, 9000, 118000
             from party
           returning id
         ), receipt as (
           insert into vouchers (org_id, voucher_type, voucher_no, fy_label, voucher_date, total_paise)
           values ($1, 'receipt', 'TEST/R1', '25-26', current_date, 118000)
           returning id
         ), line as (
           insert into voucher_lines (
             org_id, voucher_id, line_no, item_id, description, hsn_sac,
             quantity, unit_price_paise, gst_rate_bps, taxable_paise,
             cgst_paise, sgst_paise, line_total_paise
           )
           select $1, invoice.id, 1, item.id, 'Test line', '1006',
                  10000, 100000, 1800, 100000, 9000, 9000, 118000
             from invoice, item
           returning id
         ), tax as (
           insert into tax_lines (org_id, voucher_id, head, rate_bps, taxable_paise, amount_paise)
           select $1, invoice.id, 'cgst', 900, 100000, 9000 from invoice
           returning id
         ), debit as (
           insert into ledger_entries (org_id, voucher_id, account_id, party_id, entry_date, debit_paise)
           select $1, invoice.id, a.id, party.id, current_date, 118000
             from invoice, party, accounts a
            where a.org_id = $1 and a.code = 'SUNDRY_DEBTORS'
           returning id
         ), credit as (
           insert into ledger_entries (org_id, voucher_id, account_id, entry_date, credit_paise)
           select $1, invoice.id, a.id, current_date, 118000
             from invoice, accounts a
            where a.org_id = $1 and a.code = 'SALES'
           returning id
         ), alloc as (
           insert into voucher_allocations (org_id, settlement_voucher_id, target_voucher_id, amount_paise)
           select $1, receipt.id, invoice.id, 118000 from receipt, invoice
           returning id
         ), doc as (
           insert into documents (org_id, storage_key, original_filename, mime_type, byte_size, content_hash)
           values ($1, 'test/' || $1 || '/doc.pdf', 'doc.pdf', 'application/pdf', 1024,
                   encode(digest($1::text, 'sha256'), 'hex'))
           returning id
         )
         -- Dated well before anything the suites post, so the lock exists for
         -- the isolation assertions without closing the books under them.
         insert into period_locks (org_id, locked_upto, reason)
         values ($1, date '2000-03-31', 'Fixture row')`,
        [orgId, orgId === fx.orgA ? '29AAACP1234A1Z8' : '27AAACQ5678B1Z4'],
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
    const classified = [
      ...TENANT_TABLES, ...SPECIAL_RLS_TABLES, ...SYSTEM_TABLES, ...SHARED_REFERENCE_TABLES,
    ].sort();

    // Fails when a table is added without deciding how it is isolated.
    expect(actual).toEqual(classified);
  });

  it('enables AND forces RLS on every non-system table', async () => {
    const guarded = [...TENANT_TABLES, ...SPECIAL_RLS_TABLES, ...SHARED_REFERENCE_TABLES];
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

  // tax_rules is the deliberate exception: product-wide rules (org_id null) are
  // readable by every tenant, because a company must be able to see the slab
  // list before it has overridden anything. What must NOT leak is another
  // company's override.
  describe('tax_rules (shared reference data)', () => {
    it('org A reads the product-wide rules', async () => {
      const n = await asTenant(app, fx.orgA, async (c) =>
        Number(
          (
            await c.query<{ n: string }>(
              `select count(*)::text as n from tax_rules where org_id is null`,
            )
          ).rows[0]!.n,
        ),
      );
      expect(n).toBeGreaterThan(0);
    });

    it("org A cannot read org B's override", async () => {
      await owner.query(
        `insert into tax_rules (org_id, kind, code, label, rate_bps, effective_from)
         values ($1, 'gst_rate', 'ORG_B_ONLY', 'Org B override', 500, date '2024-04-01')`,
        [fx.orgB],
      );
      const n = await asTenant(app, fx.orgA, async (c) =>
        Number(
          (
            await c.query<{ n: string }>(
              `select count(*)::text as n from tax_rules where code = 'ORG_B_ONLY'`,
            )
          ).rows[0]!.n,
        ),
      );
      expect(n).toBe(0);
    });

    it("org A cannot write a rule into org B", async () => {
      await expect(
        asTenant(app, fx.orgA, (c) =>
          c.query(
            `insert into tax_rules (org_id, kind, code, label, rate_bps, effective_from)
             values ($1, 'gst_rate', 'FORGED', 'Forged', 500, date '2024-04-01')`,
            [fx.orgB],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('every seeded rule is flagged as needing CA verification', async () => {
      const { rows } = await owner.query<{ n: string }>(
        `select count(*)::text as n from tax_rules
          where org_id is null and needs_ca_verification = false`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  /**
   * Postgres resolves a foreign key with an internal check that does NOT apply
   * row level security. A single-column `references parties (id)` therefore
   * lets one company's row point at another company's row: the insert passes
   * its own WITH CHECK, and the key resolves a row the caller cannot see.
   *
   * Every reference between tenant tables must carry org_id on both sides, so
   * that a cross-tenant reference has no matching key to find. This was a real
   * hole, found by tests/integration/sales-invoice.test.ts; the assertion below
   * is what stops the next table reintroducing it.
   */
  it('makes every foreign key between tenant tables carry org_id', async () => {
    const { rows } = await owner.query<{
      table_name: string;
      constraint_name: string;
      referenced_table: string;
      columns: string[];
      referenced_columns: string[];
    }>(
      `select c.conrelid::regclass::text as table_name,
              c.conname                  as constraint_name,
              c.confrelid::regclass::text as referenced_table,
              array(select attname from pg_attribute
                     where attrelid = c.conrelid and attnum = any(c.conkey)) as columns,
              array(select attname from pg_attribute
                     where attrelid = c.confrelid and attnum = any(c.confkey)) as referenced_columns
         from pg_constraint c
        where c.contype = 'f'
          and c.conrelid::regclass::text = any($1::text[])
          and c.confrelid::regclass::text = any($1::text[])`,
      [[...TENANT_TABLES]],
    );

    expect(rows.length, 'no foreign keys found between tenant tables').toBeGreaterThan(0);

    const singleColumn = rows.filter(
      (r) => !r.columns.includes('org_id') || !r.referenced_columns.includes('org_id'),
    );
    expect(
      singleColumn.map((r) => `${r.table_name}.${r.constraint_name} -> ${r.referenced_table}`),
      'these foreign keys can point across tenants',
    ).toEqual([]);
  });

  it('lets the application role delete nothing that is posted', async () => {
    // The immutability trigger exempts the table OWNER from DELETE so that a
    // company can be deleted. That exemption must be unreachable from the
    // application role, which is what every request runs as.
    const voucherId = await asTenant(app, fx.orgA, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select id from vouchers where voucher_no = 'TEST/1'`,
      );
      return rows[0]!.id;
    });

    await owner.query(`update vouchers set status = 'posted' where id = $1`, [voucherId]);

    await expect(
      asTenant(app, fx.orgA, (c) => c.query('delete from vouchers where id = $1', [voucherId])),
    ).rejects.toThrow(/posted and cannot be deleted/i);

    await expect(
      asTenant(app, fx.orgA, (c) =>
        c.query('delete from ledger_entries where voucher_id = $1', [voucherId]),
      ),
    ).rejects.toThrow(/cannot be changed/i);
  });

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
