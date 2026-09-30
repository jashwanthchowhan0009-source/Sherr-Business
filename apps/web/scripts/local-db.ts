/**
 * Local Postgres lifecycle for development and tests.
 *
 * Uses the Postgres already present on the machine (pg_ctlcluster / pg_ctl).
 * Production uses Neon; this exists so `pnpm test` needs no network and the
 * RLS tests run against a real server rather than a mock.
 */
import { execSync } from 'node:child_process';

const DB = process.env.LOCAL_DB_NAME ?? 'sherrbyte';
const OWNER = process.env.LOCAL_DB_OWNER ?? 'sherrbyte_owner';
const OWNER_PW = process.env.LOCAL_DB_OWNER_PASSWORD ?? 'owner_dev_password';
const APP_PW = process.env.LOCAL_DB_APP_PASSWORD ?? 'app_dev_password';

const sudo = (cmd: string) => execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
const psqlSuper = (sql: string) =>
  execSync(`su postgres -c ${JSON.stringify(`psql -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`)}`, {
    stdio: 'pipe',
    shell: '/bin/bash',
  }).toString();

function ensureRunning(): void {
  try {
    execSync('pg_isready -q', { shell: '/bin/bash' });
  } catch {
    console.log('[db] starting postgres…');
    sudo('pg_ctlcluster 16 main start || service postgresql start');
  }
}

function up(): void {
  ensureRunning();
  // CREATEROLE so bootstrap-roles.ts runs identically here and on Neon,
  // whose default role can also create roles. Idempotent: `reset` drops the
  // database but roles are cluster-wide and survive.
  const roleExists = psqlSuper(`select 1 from pg_roles where rolname = '${OWNER}'`).includes('1 row');
  if (!roleExists) {
    psqlSuper(`create role ${OWNER} login createrole password '${OWNER_PW}'`);
  } else {
    psqlSuper(`alter role ${OWNER} login createrole password '${OWNER_PW}'`);
  }

  const dbExists = psqlSuper(`select 1 from pg_database where datname = '${DB}'`).includes('1 row');
  if (!dbExists) {
    psqlSuper(`create database ${DB} owner ${OWNER}`);
    console.log(`[db] created database ${DB} owned by ${OWNER}`);
  } else {
    console.log(`[db] database ${DB} already exists`);
  }
  console.log('\nAdd to .env.local:');
  console.log(`DATABASE_URL_OWNER="postgresql://${OWNER}:${OWNER_PW}@127.0.0.1:5432/${DB}"`);
  console.log(`DATABASE_URL="postgresql://sherrbyte_app:${APP_PW}@127.0.0.1:5432/${DB}"`);
}

function down(): void {
  ensureRunning();
  psqlSuper(`drop database if exists ${DB} with (force)`);
  console.log(`[db] dropped ${DB}`);
}

const cmd = process.argv[2];
if (cmd === 'up') up();
else if (cmd === 'down') down();
else if (cmd === 'reset') {
  down();
  up();
} else {
  console.error('usage: local-db.ts <up|down|reset>');
  process.exit(1);
}
