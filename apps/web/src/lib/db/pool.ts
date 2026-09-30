import 'server-only';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/**
 * INTERNAL. Do not import this module outside src/lib/db/.
 *
 * The pool connects as the *application* role, which owns no tables and has no
 * BYPASSRLS. Queries issued through it without a tenant context return zero
 * rows, because every policy tests `current_setting('app.current_org_id', true)`
 * and an unset GUC yields NULL.
 *
 * tests/unit/db-encapsulation.test.ts fails the build if anything outside
 * src/lib/db/ imports this file.
 */

declare global {
  var __sherrbytePool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(connectionString.includes('sslmode=require')
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  });

  pool.on('error', (err) => {
    // A pooled client erroring while idle must not take the process down.
    console.error('[db] idle client error', err);
  });

  return pool;
}

/** Reused across hot reloads in dev so we do not exhaust Postgres connections. */
export function appPool(): Pool {
  if (!globalThis.__sherrbytePool) globalThis.__sherrbytePool = createPool();
  return globalThis.__sherrbytePool;
}

export function appDb() {
  return drizzle(appPool(), { schema });
}

export type AppDb = ReturnType<typeof appDb>;

export async function closePool(): Promise<void> {
  if (globalThis.__sherrbytePool) {
    await globalThis.__sherrbytePool.end();
    globalThis.__sherrbytePool = undefined;
  }
}
