/**
 * Applies drizzle/*.sql in filename order, each inside its own transaction,
 * recording what ran in schema_migrations.
 *
 * Hand-written SQL rather than generated migrations, because the RLS policies,
 * grants and SECURITY DEFINER functions are the substance of this schema and
 * are not something a generator should be guessing at.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadEnv } from './_env';

loadEnv();

const DIR = join(process.cwd(), 'drizzle');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set (migrations run as owner)');

  const pool = new Pool({
    connectionString,
    ...(connectionString.includes('sslmode=require') ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  try {
    await pool.query(`
      create table if not exists schema_migrations (
        name        text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )
    `);

    const applied = new Map<string, string>(
      (await pool.query('select name, checksum from schema_migrations')).rows.map(
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
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
