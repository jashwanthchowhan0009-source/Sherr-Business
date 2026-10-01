import { describe, expect, it } from 'vitest';
import { describeInfrastructureFailure } from '@/lib/infra-errors';

/** A `pg` query failure: the SQLSTATE is on `cause`, not on the thrown error. */
function pgFailure(code: string, message = 'Failed query') {
  const outer = new Error(message) as Error & { cause?: unknown };
  const inner = new Error('database said no') as Error & { code?: string };
  inner.code = code;
  outer.cause = inner;
  return outer;
}

describe('describeInfrastructureFailure', () => {
  it('reads the SQLSTATE off `cause`, where pg actually puts it', () => {
    // Reading only the outer error is exactly why a production outage showed
    // "Something went wrong" with no further clue for an hour.
    const result = describeInfrastructureFailure(pgFailure('28P01'));
    expect(result?.reason).toBe('postgres_auth_failed');
  });

  it('reads it off the error itself when there is no wrapper', () => {
    const err = new Error('nope') as Error & { code?: string };
    err.code = '28P01';
    expect(describeInfrastructureFailure(err)?.reason).toBe('postgres_auth_failed');
  });

  it('names both causes of 28P01, because Postgres will not say which', () => {
    // Postgres reports a wrong password and a non-existent role identically, so
    // that probing cannot discover which usernames are real. A message naming
    // only one of them sends somebody looking in the wrong place.
    const message = describeInfrastructureFailure(pgFailure('28P01'))!.message;
    expect(message).toMatch(/wrong password/);
    expect(message).toMatch(/does not exist/);
    expect(message).toMatch(/DATABASE_URL/);
  });

  it('tells a missing table apart from a bug', () => {
    const result = describeInfrastructureFailure(pgFailure('42P01'));
    expect(result?.reason).toBe('postgres_relation_missing');
    expect(result?.message).toMatch(/migrations have not run/);
    expect(result?.message).toMatch(/DATABASE_URL_OWNER/);
  });

  it('recognises the network failures that mean the database is unreachable', () => {
    for (const [code, reason] of [
      ['ECONNREFUSED', 'connection_refused'],
      ['ENOTFOUND', 'host_not_found'],
      ['ETIMEDOUT', 'connection_timeout'],
      ['ECONNRESET', 'connection_reset'],
    ] as const) {
      const err = new Error('net') as Error & { code?: string };
      err.code = code;
      expect(describeInfrastructureFailure(err)?.reason, code).toBe(reason);
    }
  });

  it('recognises an unset connection string by the variable name', () => {
    const result = describeInfrastructureFailure(
      new Error('DATABASE_URL_OWNER is not set. Migrations run as the owner role; set it to …'),
    );
    expect(result?.reason).toBe('env_missing');
    expect(result?.message).toMatch(/DATABASE_URL_OWNER is not set/);
  });

  it('leaks nothing a stranger could use', () => {
    // The point of naming the variable is to help whoever administers the
    // deployment. Naming its contents would help somebody else entirely.
    const samples = [
      pgFailure('28P01'),
      pgFailure('3D000'),
      pgFailure('42501'),
      (() => {
        const e = new Error('x') as Error & { code?: string };
        e.code = 'ENOTFOUND';
        return e;
      })(),
    ];
    for (const err of samples) {
      const message = describeInfrastructureFailure(err)!.message;
      expect(message).not.toMatch(/postgres(ql)?:\/\//);
      expect(message).not.toMatch(/password\s*[:=]/i);
      expect(message).not.toMatch(/@[\w.-]+\.(tech|com|net)/);
      expect(message).not.toMatch(/sherrbyte_app/);
    }
  });

  it('says nothing about an ordinary bug, so the generic message still applies', () => {
    // A message that guesses at a cause is worse than one that admits it does
    // not know.
    expect(describeInfrastructureFailure(new TypeError('x is not a function'))).toBeNull();
    expect(describeInfrastructureFailure(new Error('boom'))).toBeNull();
    expect(describeInfrastructureFailure(null)).toBeNull();
    expect(describeInfrastructureFailure('a string')).toBeNull();

    // A constraint violation is the database working correctly.
    expect(describeInfrastructureFailure(pgFailure('23505'))).toBeNull();
  });

  it('stops walking a cause chain that points at itself', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(() => describeInfrastructureFailure(a)).not.toThrow();
  });

  it('every message says nothing was changed, or why it could not be', () => {
    for (const code of ['28P01', '28000', '3D000', '42P01', '42501', '53300']) {
      const message = describeInfrastructureFailure(pgFailure(code))!.message;
      expect(message, code).toMatch(/Nothing was changed|try again/i);
    }
  });
});
