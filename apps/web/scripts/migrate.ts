/**
 * Applies drizzle/*.sql in filename order, each inside its own transaction,
 * recording what ran in schema_migrations.
 *
 * Hand-written SQL rather than generated migrations, because the RLS policies,
 * grants and SECURITY DEFINER functions are the substance of this schema and
 * are not something a generator should be guessing at.
 *
 * Runs during the Vercel build (see the `vercel-build` script), so two builds
 * can start at once -- a push that supersedes an in-flight deploy, or a preview
 * and production build of the same commit. A session-level advisory lock
 * serialises them: the second build waits, then finds the migration already
 * recorded and does nothing.
 *
 * DATABASE_URL_OWNER must be the DIRECT (unpooled) Neon connection string.
 * Session-level advisory locks do not survive PgBouncer's transaction pooling,
 * and neither do the SET-based session semantics migrations rely on.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { loadEnv } from './_env';

loadEnv();

const DIR = join(process.cwd(), 'drizzle');

/** Arbitrary but fixed: any process using this key contends for the same lock. */
const MIGRATION_LOCK_KEY = 8_427_301;

/**
 * On Vercel, migrate production deployments only.
 *
 * Preview deployments inherit the same DATABASE_URL_OWNER unless a separate
 * database is configured for them, so letting a preview migrate would apply an
 * unreviewed branch's schema change to production data. Set
 * ALLOW_PREVIEW_MIGRATIONS=1 on a preview environment that has its own database
 * (a Neon branch, say) to opt back in.
 *
 * Outside Vercel -- local development and CI -- this never applies.
 */
function shouldMigrateHere(): { run: boolean; reason: string } {
  if (!process.env.VERCEL) return { run: true, reason: 'not a Vercel build' };

  const env = process.env.VERCEL_ENV ?? 'unknown';
  if (env === 'production') return { run: true, reason: 'production deployment' };
  if (process.env.ALLOW_PREVIEW_MIGRATIONS === '1') {
    return { run: true, reason: `${env} deployment with ALLOW_PREVIEW_MIGRATIONS=1` };
  }
  return {
    run: false,
    reason:
      `${env} deployment. Skipped so an unreviewed branch cannot migrate the ` +
      `production database. Set ALLOW_PREVIEW_MIGRATIONS=1 if this environment ` +
      `has a database of its own.`,
  };
}

async function main(): Promise<void> {
  const gate = shouldMigrateHere();
  if (!gate.run) {
    console.log(`[migrate] skipped: ${gate.reason}`);
    return;
  }

  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) {
    // Deliberately fatal. Building against a database whose schema may be older
    // than the code produces a deployment that fails at the first query, which
    // is far worse than a failed build.
    throw new Error(
      'DATABASE_URL_OWNER is not set. Migrations run as the owner role; set it ' +
        'to the DIRECT (unpooled) Neon connection string.',
    );
  }

  const pool = new Pool({
    connectionString,
    ...(connectionString.includes('sslmode=require') ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  let lockClient: PoolClient | null = null;

  try {
    await pool.query(`
      create table if not exists schema_migrations (
        name        text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )
    `);

    // Held for the whole run on one dedicated connection, so concurrent builds
    // queue rather than race. Released in the finally below; a crashed process
    // drops its session, which releases it too.
    lockClient = await pool.connect();
    await lockClient.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    // Read the applied set only AFTER the lock: a build that waited here would
    // otherwise act on what it saw before the other build committed.
    const applied = new Map<string, string>(
      (await lockClient.query('select name, checksum from schema_migrations')).rows.map(
        (r: { name: string; checksum: string }) => [r.name, r.checksum],
      ),
    );

    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;

    for (const name of files) {
      const sql = readFileSync(join(DIR, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = applied.get(name);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${name} changed after it was applied (${previous} -> ${checksum}). ` +
              `Add a new migration instead of editing an applied one.`,
          );
        }
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('commit');
        console.log(`[migrate] applied ${name}`);
        ran += 1;
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }

    console.log(ran === 0 ? '[migrate] already up to date' : `[migrate] ${ran} migration(s) applied`);
  } finally {
    if (lockClient) {
      await lockClient.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      lockClient.release();
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
