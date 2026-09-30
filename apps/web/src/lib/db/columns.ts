import { bigint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Primary key used on every table. */
export const pk = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/** The tenant discriminator. Every tenant-scoped table carries exactly this. */
export const orgId = () => uuid('org_id').notNull();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Money column. Always integer paise, never a fraction of one.
 *
 * `mode: 'bigint'` gives us a JS bigint rather than a string or a number, so
 * there is no silent path to a float. Phase 1 has no money columns yet; this
 * exists so Phase 2 cannot invent its own convention. See src/lib/money.ts.
 */
export const paise = (name: string) => bigint(name, { mode: 'bigint' });
