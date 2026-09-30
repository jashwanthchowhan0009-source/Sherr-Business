import { Pool, type PoolClient } from 'pg';

/**
 * Integration tests connect as the APPLICATION role, never the owner.
 *
 * Testing RLS through the owner connection would prove nothing: the owner is the
 * one role the policies are designed to be bypassable by (absent FORCE), so a
 * green suite against it would be meaningless.
 */
export function appPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString, max: 5 });
}

export function ownerPool(): Pool {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set');
  return new Pool({ connectionString, max: 5 });
}

/** Runs `fn` inside a transaction with the tenant GUC set, exactly as withTenant does. */
export async function asTenant<T>(
  pool: Pool,
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
  userId?: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.current_org_id', $1, true)`, [orgId]);
    await client.query(`select set_config('app.current_user_id', $1, true)`, [userId ?? '']);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export interface Fixture {
  orgA: string;
  orgB: string;
  userA: string;
  userB: string;
}

/** Creates two isolated organizations through the same vetted bootstrap path the app uses. */
export async function seedTwoOrgs(owner: Pool, tag: string): Promise<Fixture> {
  const mk = async (suffix: string, email: string) => {
    const { rows } = await owner.query<{ id: string }>(
      'select app_ensure_user($1, $2, $3, true) as id',
      [`test_user_${tag}_${suffix}`, email, `Test ${suffix}`],
    );
    return rows[0]!.id;
  };
  const userA = await mk('a', `a_${tag}@test.invalid`);
  const userB = await mk('b', `b_${tag}@test.invalid`);

  const org = async (slug: string, name: string, ownerId: string) => {
    const { rows } = await owner.query<{ id: string }>(
      'select app_create_organization($1, $2, $3::uuid) as id',
      [`org_test_${tag}_${slug}`, name, ownerId],
    );
    return rows[0]!.id;
  };
  const orgA = await org('a', `Test Org A ${tag}`, userA);
  const orgB = await org('b', `Test Org B ${tag}`, userB);

  return { orgA, orgB, userA, userB };
}

export async function cleanup(owner: Pool, fixture: Fixture): Promise<void> {
  await owner.query('delete from organizations where id = any($1::uuid[])', [
    [fixture.orgA, fixture.orgB],
  ]);
  await owner.query('delete from users where id = any($1::uuid[])', [
    [fixture.userA, fixture.userB],
  ]);
}
