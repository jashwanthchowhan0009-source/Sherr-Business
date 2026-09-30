/**
 * Creates and then VERIFIES the application role. Run ONCE per database,
 * before migrations.
 *
 * The whole tenant-isolation design rests on the runtime connecting as a role
 * that owns nothing and cannot bypass RLS. Neon's default role owns everything
 * you create with it, so this separation has to be made explicitly.
 *
 * This script verifies rather than fixes: clearing SUPERUSER or BYPASSRLS needs
 * superuser anyway, and a loud failure on a misconfigured role is worth more
 * than a silent repair that hides how the database was set up.
 */
import { Pool } from 'pg';
import { loadEnv } from './_env';

loadEnv();

const APP_ROLE = process.env.APP_DB_ROLE ?? 'sherrbyte_app';
// APP_DB_PASSWORD wins: it is what CI and production set explicitly, and it
// must not be shadowed by a LOCAL_DB_APP_PASSWORD left in a developer's
// .env.local. Getting this the wrong way round sets the role's password from
// the local file and the application then cannot authenticate.
const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? process.env.LOCAL_DB_APP_PASSWORD;

interface RoleAttrs {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set');
  if (!APP_PASSWORD) throw new Error('APP_DB_PASSWORD (or LOCAL_DB_APP_PASSWORD) is not set');

  const pool = new Pool({
    connectionString,
    ...(connectionString.includes('sslmode=require') ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  try {
    const quoted = APP_PASSWORD.replace(/'/g, "''");
    const existing = await pool.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);

    if (existing.rows.length === 0) {
      await pool.query(`create role ${APP_ROLE} login password '${quoted}'`);
      console.log(`[bootstrap] created role ${APP_ROLE}`);
    } else {
      // Idempotent on purpose. Re-running against a role that already exists
      // must leave the password matching DATABASE_URL, or the application
      // simply cannot authenticate -- and the failure appears at runtime,
      // nowhere near this script.
      try {
        await pool.query(`alter role ${APP_ROLE} login password '${quoted}'`);
        console.log(`[bootstrap] role ${APP_ROLE} already exists; password reset to match`);
      } catch (err) {
        console.warn(
          `[bootstrap] WARNING: ${APP_ROLE} exists but its password could not be set ` +
            `(${(err as Error).message}). The previous password remains in effect, so ` +
            `DATABASE_URL must already carry it.`,
        );
      }
    }

    const db = (await pool.query('select current_database() as d')).rows[0].d;
    await pool.query(`grant connect on database ${db} to ${APP_ROLE}`);
    await pool.query(`grant usage on schema public to ${APP_ROLE}`);
    try {
      await pool.query(`revoke create on schema public from ${APP_ROLE}`);
    } catch {
      // Not owner of schema public (some managed setups). Not fatal: the role
      // is never granted CREATE explicitly, and the verification below is what
      // actually gates correctness.
    }

    const attrs: RoleAttrs = (
      await pool.query(
        `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
           from pg_roles where rolname = $1`,
        [APP_ROLE],
      )
    ).rows[0];

    const owned = await pool.query(
      `select count(*)::int as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r     on r.oid = c.relowner
        where n.nspname = 'public' and c.relkind = 'r' and r.rolname = $1`,
      [APP_ROLE],
    );

    const problems: string[] = [];
    if (attrs.rolsuper) problems.push('has SUPERUSER');
    if (attrs.rolbypassrls) problems.push('has BYPASSRLS');
    if (owned.rows[0].n > 0) problems.push(`owns ${owned.rows[0].n} table(s)`);

    if (problems.length > 0) {
      throw new Error(
        `Role ${APP_ROLE} is not safe to use at runtime: ${problems.join(', ')}.\n` +
          `A role with any of these silently bypasses every RLS policy. Recreate it ` +
          `as a plain LOGIN role that owns nothing.`,
      );
    }

    console.log(
      `[bootstrap] verified ${APP_ROLE}: no superuser, no bypassrls, owns no tables ` +
        `(createdb=${attrs.rolcreatedb}, createrole=${attrs.rolcreaterole})`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\n${err.message ?? err}\n`);
  process.exit(1);
});
