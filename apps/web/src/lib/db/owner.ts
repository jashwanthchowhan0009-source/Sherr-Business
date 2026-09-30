import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/**
 * Owner-role connection. Migrations and seed ONLY.
 *
 * This role owns the tables and therefore bypasses RLS unless FORCE ROW LEVEL
 * SECURITY is set. It must never be reachable from request handling — no file
 * under src/app/ may import this module.
 */
export function ownerDb() {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set');
  const pool = new Pool({
    connectionString,
    max: 4,
    ...(connectionString.includes('sslmode=require')
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  });
  return { db: drizzle(pool, { schema }), pool };
}
