/**
 * Saying what actually broke, when what broke is the plumbing.
 *
 * An unexpected throw used to surface as "Something went wrong. Nothing was
 * changed." That is the right thing to say about a bug — it tells the user the
 * truth and leaks nothing — but it is the wrong thing to say about a
 * misconfiguration, because the person who can fix it learns nothing from it.
 *
 * This happened in production: the database rejected the application role's
 * password, every page that touched the database failed, and the only clue
 * anybody had was "Something went wrong." The cause was a one-line environment
 * variable pointing at the wrong database, and finding it meant reading server
 * logs.
 *
 * So a small set of failures that are always configuration, never a bug, get
 * named. The rule for what goes in the message: enough for whoever administers
 * the deployment to know which setting to look at, and nothing that would help
 * somebody who should not be looking. Connection strings, passwords, hosts and
 * usernames stay out; the NAME of the environment variable goes in, because the
 * name is already in the repository's README.
 */

export interface InfrastructureFailure {
  /** Shown to whoever hit it. */
  message: string;
  /** For the log line, so the cause is greppable. */
  reason: string;
}

/** Postgres SQLSTATEs that mean "configured wrong", not "the code is wrong". */
const POSTGRES: Record<string, InfrastructureFailure> = {
  // Covers a wrong password AND a role that does not exist: Postgres reports
  // both as 28P01 on purpose, so that probing cannot discover which usernames
  // are real. The message therefore has to name both possibilities.
  '28P01': {
    reason: 'postgres_auth_failed',
    message:
      'The app could not sign in to its database. DATABASE_URL has the wrong password for the ' +
      'application role, or points at a database where that role does not exist. Nothing was changed.',
  },
  '28000': {
    reason: 'postgres_auth_rejected',
    message:
      'The database refused the connection. Check DATABASE_URL and whether the database allows ' +
      'connections from here. Nothing was changed.',
  },
  '3D000': {
    reason: 'postgres_database_missing',
    message:
      'The database named in DATABASE_URL does not exist. Nothing was changed.',
  },
  // A missing table almost always means the schema is behind the code, which on
  // this project means the build's migration step did not reach this database.
  '42P01': {
    reason: 'postgres_relation_missing',
    message:
      'The database is missing a table this version of the app needs, so its migrations have not ' +
      'run against it. Check that DATABASE_URL_OWNER points at the same database as DATABASE_URL, ' +
      'then redeploy. Nothing was changed.',
  },
  '42501': {
    reason: 'postgres_permission_denied',
    message:
      'The database refused the app permission for that. The application role is missing a grant, ' +
      'which the migrations normally apply. Nothing was changed.',
  },
  '53300': {
    reason: 'postgres_too_many_connections',
    message: 'The database is out of connections. Try again shortly; nothing was changed.',
  },
};

/** Network failures reaching the database or an upstream service. */
const NETWORK: Record<string, InfrastructureFailure> = {
  ECONNREFUSED: {
    reason: 'connection_refused',
    message: 'The database refused the connection. It may be asleep or unreachable from here.',
  },
  ENOTFOUND: {
    reason: 'host_not_found',
    message: 'The database host in DATABASE_URL does not resolve. Check it for a typo.',
  },
  ETIMEDOUT: {
    reason: 'connection_timeout',
    message: 'The database did not answer in time. Nothing was changed.',
  },
  ECONNRESET: {
    reason: 'connection_reset',
    message: 'The connection to the database dropped. Nothing was changed.',
  },
};

/** A thrown value's `code`, wherever the driver hung it. */
function codesIn(err: unknown): string[] {
  const out: string[] = [];
  let cursor: unknown = err;
  // `pg` wraps the original error as `cause` on a query failure, and the
  // SQLSTATE lives on the inner one — reading only the outer would miss it,
  // which is how the production failure stayed unexplained.
  for (let depth = 0; cursor !== null && cursor !== undefined && depth < 5; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') out.push(code);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * Whether this failure is the deployment's configuration rather than a bug.
 *
 * Returns null for everything else, which keeps the generic message as the
 * default: a message that guesses at a cause is worse than one that admits it
 * does not know.
 */
export function describeInfrastructureFailure(err: unknown): InfrastructureFailure | null {
  for (const code of codesIn(err)) {
    const match = POSTGRES[code] ?? NETWORK[code];
    if (match) return match;
  }

  // The env guards throw plain Errors naming the variable. Matching on the
  // name rather than the sentence keeps this working if the wording changes.
  const message = err instanceof Error ? err.message : '';
  for (const name of ['DATABASE_URL_OWNER', 'DATABASE_URL']) {
    if (message.includes(name) && /not set|missing|undefined/i.test(message)) {
      return {
        reason: 'env_missing',
        message: `${name} is not set on this deployment. Nothing was changed.`,
      };
    }
  }

  return null;
}
