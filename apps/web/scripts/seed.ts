/**
 * Seeds two organizations with CLEARLY LABELLED MOCK DATA.
 *
 * Two, not one, and that is the point: a single-tenant seed cannot demonstrate
 * isolation. Every name below is marked so nobody mistakes it for a real
 * company's records.
 *
 * The first org mirrors docs/07-WORKED-EXAMPLE.md so the seed and the
 * specification describe the same company.
 */
import { Pool } from 'pg';
import { loadEnv } from './_env';

loadEnv();

const MOCK = '[MOCK]';

interface SeedOrg {
  clerkOrgId: string;
  legalName: string;
  tradeName: string;
  pan: string;
  stateCode: string;
  gstin: string;
  tan: string;
  members: { clerkUserId: string; email: string; name: string; role: string; validToDays?: number }[];
}

const ORGS: SeedOrg[] = [
  {
    clerkOrgId: 'org_mock_balaji',
    legalName: `${MOCK} Shree Balaji Traders Pvt Ltd`,
    tradeName: `${MOCK} Balaji Traders`,
    pan: 'AABCS1234A',
    stateCode: '29',
    gstin: '29AABCS1234A1Z5',
    tan: 'BLRS12345B',
    members: [
      { clerkUserId: 'user_mock_owner_a', email: 'owner@balaji.mock', name: 'Mock Owner (Balaji)', role: 'owner' },
      { clerkUserId: 'user_mock_acct_a', email: 'priya@balaji.mock', name: 'Mock Accountant (Balaji)', role: 'accountant' },
      { clerkUserId: 'user_mock_ca_a', email: 'ca@kulkarni.mock', name: 'Mock CA Reviewer', role: 'ca_reviewer', validToDays: 120 },
      { clerkUserId: 'user_mock_viewer_a', email: 'viewer@balaji.mock', name: 'Mock Viewer (Balaji)', role: 'viewer' },
    ],
  },
  {
    clerkOrgId: 'org_mock_meridian',
    legalName: `${MOCK} Meridian Exports Pvt Ltd`,
    tradeName: `${MOCK} Meridian`,
    pan: 'AABCM9876B',
    stateCode: '27',
    gstin: '27AABCM9876B1Z3',
    tan: 'MUMM54321C',
    members: [
      { clerkUserId: 'user_mock_owner_b', email: 'owner@meridian.mock', name: 'Mock Owner (Meridian)', role: 'owner' },
    ],
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set (seed runs as owner)');
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_PRODUCTION_SEED) {
    throw new Error('Refusing to seed mock data in production. Set ALLOW_PRODUCTION_SEED to override.');
  }

  const pool = new Pool({
    connectionString,
    ...(connectionString.includes('sslmode=require') ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  try {
    for (const org of ORGS) {
      const memberIds: Record<string, string> = {};
      for (const m of org.members) {
        const { rows } = await pool.query<{ id: string }>(
          'select app_ensure_user($1, $2, $3, true) as id',
          [m.clerkUserId, m.email, m.name],
        );
        memberIds[m.clerkUserId] = rows[0]!.id;
      }

      const first = org.members[0]!;
      const { rows: orgRows } = await pool.query<{ id: string }>(
        'select app_create_organization($1, $2, $3::uuid) as id',
        [org.clerkOrgId, org.legalName, memberIds[first.clerkUserId]],
      );
      const orgId = orgRows[0]!.id;

      await pool.query(
        `update organizations
            set trade_name = $2, pan = $3, state_code = $4, updated_at = now()
          where id = $1`,
        [orgId, org.tradeName, org.pan, org.stateCode],
      );

      for (const m of org.members.slice(1)) {
        await pool.query(
          `insert into memberships (org_id, user_id, role, valid_to)
           values ($1, $2, $3, case when $4::int is null then null
                                    else now() + make_interval(days => $4::int) end)
           on conflict (org_id, user_id) do update set role = excluded.role`,
          [orgId, memberIds[m.clerkUserId], m.role, m.validToDays ?? null],
        );
      }

      for (const [kind, number] of [['gstin', org.gstin], ['tan', org.tan]] as const) {
        await pool.query(
          `insert into org_registrations (org_id, kind, number, state_code)
           values ($1, $2, $3, $4)
           on conflict (org_id, kind, number) do nothing`,
          [orgId, kind, number, kind === 'gstin' ? number.slice(0, 2) : org.stateCode],
        );
      }

      await pool.query(
        `insert into audit_logs (org_id, actor_user_id, actor_role, action, subject_kind, subject_id, after)
         values ($1::uuid, $2::uuid, 'owner', 'seed.mock_data_loaded', 'organization', $3, $4)`,
        [
          orgId,
          memberIds[first.clerkUserId],
          orgId,
          JSON.stringify({ note: 'Mock seed data, not real records' }),
        ],
      );

      console.log(`[seed] ${org.legalName}  (${org.members.length} member(s))  ${orgId}`);
    }

    console.log(
      `\n[seed] Done. All records are prefixed "${MOCK}". Two organizations exist so tenant ` +
        `isolation can be demonstrated rather than asserted.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
