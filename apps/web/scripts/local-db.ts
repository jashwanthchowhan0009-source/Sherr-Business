/**
 * Local / CI Postgres lifecycle: creates the database and the OWNER role.
 * The application role is created afterwards by bootstrap-roles.ts.
 *
 * Two ways to reach a superuser, so the same script serves both environments:
 *
 *   SUPERUSER_DATABASE_URL set  → connect over TCP (GitHub Actions service
 *                                 container, or any managed Postgres)
 *   unset                       → shell out to `su postgres -c psql` (a local
 *                                 cluster using peer authentication)
 *
 * Production uses Neon and never runs this; there you create the database in
 * the Neon console and run bootstrap-roles + migrate against it.
 */
import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import { loadEnv } from './_env';

loadEnv();

const DB = process.env.LOCAL_DB_NAME ?? 'sherrbyte';
const OWNER = process.env.LOCAL_DB_OWNER ?? 'sherrbyte_owner';
const OWNER_PW = process.env.LOCAL_DB_OWNER_PASSWORD ?? 'owner_dev_password';
const APP_PW = process.env.APP_DB_PASSWORD ?? process.env.LOCAL_DB_APP_PASSWORD ?? 'app_dev_password';
const SUPERUSER_URL = process.env.SUPERUSER_DATABASE_URL;

/** Runs a statement as a superuser and reports whether it returned any rows. */
type SuperuserExec = (sql: string) => Promise<{ rowCount: number }>;

async function withSuperuser<T>(fn: (exec: SuperuserExec) => Promise<T>): Promise<T> {
  if (SUPERUSER_URL) {
    const pool = new Pool({ connectionString: SUPERUSER_URL, max: 2 });
    try {
      return await fn(async (sql) => {
        const res = await pool.query(sql);
        return { rowCount: res.rowCount ?? 0 };
      });
    } finally {
      await pool.end();
    }
  }

  ensureLocalClusterRunning();
  return fn(async (sql) => {
    const out = execSync(
      `su postgres -c ${JSON.stringify(`psql -tAX -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`)}`,
      { stdio: 'pipe', shell: '/bin/bash' },
    )
      .toString()
      .trim();
    return { rowCount: out === '' ? 0 : out.split('\n').length };
  });
}

function ensureLocalClusterRunning(): void {
  try {
    execSync('pg_isready -q', { shell: '/bin/bash' });
  } catch {
    console.log('[db] starting postgres…');
    execSync('pg_ctlcluster 16 main start || service postgresql start', {
      stdio: 'inherit',
      shell: '/bin/bash',
    });
  }
}

async function up(): Promise<void> {
  await withSuperuser(async (exec) => {
    // CREATEROLE so bootstrap-roles.ts runs identically here and on Neon, whose
    // default role can also create roles. Idempotent: `reset` drops the database
    // but roles are cluster-wide and survive.
    const role = await exec(`select 1 from pg_roles where rolname = '${OWNER}'`);
    const clause = `login createrole password '${OWNER_PW}'`;
    await exec(
      role.rowCount > 0 ? `alter role ${OWNER} ${clause}` : `create role ${OWNER} ${clause}`,
    );

    const db = await exec(`select 1 from pg_database where datname = '${DB}'`);
    if (db.rowCount === 0) {
      await exec(`create database ${DB} owner ${OWNER}`);
      console.log(`[db] created database ${DB} owned by ${OWNER}`);
    } else {
      console.log(`[db] database ${DB} already exists`);
    }
  });

  const host = SUPERUSER_URL ? new URL(SUPERUSER_URL).host : '127.0.0.1:5432';
  console.log('\nAdd to .env.local:');
  console.log(`DATABASE_URL_OWNER="postgresql://${OWNER}:${OWNER_PW}@${host}/${DB}"`);
  console.log(`DATABASE_URL="postgresql://sherrbyte_app:${APP_PW}@${host}/${DB}"`);
}

async function down(): Promise<void> {
  await withSuperuser(async (exec) => {
    await exec(`drop database if exists ${DB} with (force)`);
    console.log(`[db] dropped ${DB}`);
  });
}

const cmd = process.argv[2];
const run =
  cmd === 'up' ? up
  : cmd === 'down' ? down
  : cmd === 'reset' ? async () => { await down(); await up(); }
  : null;

if (!run) {
  console.error('usage: local-db.ts <up|down|reset>');
  process.exit(1);
}

run().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
