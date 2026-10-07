# SherrByte Business — Phase 1

Tenancy, authentication, roles and the audit trail. **No invoices, no ledger** — those are Phase 2.

This phase exists to get the irreversible decisions right before there is data to migrate: how tenants are isolated, and how changes are recorded.

---

## Quick start

```bash
pnpm install
pnpm db:up            # starts local Postgres, creates the database and owner role
                      # copy the two connection strings it prints into .env.local
pnpm db:bootstrap     # creates and verifies the sherrbyte_app runtime role
pnpm db:migrate       # applies drizzle/*.sql as the owner
pnpm db:seed          # two organizations of clearly-labelled mock data
pnpm test             # 58 tests, including tenant isolation against real Postgres
pnpm dev
```

The app boots without Clerk keys so the database layer and the shell can be worked on. Protected routes are **refused**, not opened — an unconfigured auth provider never means "allow".

---

## Why two database roles

This is the part worth reading before changing anything.

A table's owner **bypasses every RLS policy**, and the failure is silent: queries keep working and simply return other tenants' rows. Neon's default role owns everything you create with it, so connecting the app as that role would give you RLS that isolates nothing.

So there are two roles and two connection strings:

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL_OWNER` | owns the tables | `db:migrate`, `db:seed` only |
| `DATABASE_URL` | `sherrbyte_app` — owns nothing, no `BYPASSRLS` | the application, always |

`pnpm db:bootstrap` **verifies** rather than repairs: it fails loudly if the runtime role has `SUPERUSER`, `BYPASSRLS`, or owns any table. `tests/integration/rls-privileges.test.ts` asserts the same properties, so a misconfigured production database fails CI rather than leaking.

Every tenant table also carries `FORCE ROW LEVEL SECURITY`, which closes the owner's exemption too. The `SECURITY DEFINER` bootstrap functions still work because the migration grants the owner an explicitly scoped `TO <owner>` policy — the application role is a different role and can never satisfy it.

## How tenant scoping works

`withTenant()` in `src/lib/db/tenant.ts` is the only supported route to tenant data:

```ts
await withTenant({ orgId, userId }, async (tx) => {
  return tx.select().from(memberships);   // policies applied automatically
});
```

It opens a transaction and sets the tenant with `set_config('app.current_org_id', $1, true)`. The `true` makes the setting **transaction-local**, so it is discarded on commit or rollback and the pooled connection goes back clean. Plain `SET` would leak the tenant to whoever picks up that connection next — the most common way multi-tenant isolation breaks in production.

Policies read `current_setting('app.current_org_id', true)`. The second `true` means "missing is fine, return NULL", so a query with **no** tenant context matches nothing and returns **zero rows rather than all rows**. There is a test for exactly that.

`src/lib/db/pool.ts` is not importable outside `src/lib/db/` — enforced by ESLint and by `tests/unit/db-encapsulation.test.ts`.

## How permission checks can't be forgotten

Every mutation is built by `defineAction()` (`src/lib/auth/action.ts`), which resolves the caller, checks the capability, rate-limits, opens the tenant transaction, and hands the handler an `audit()` bound to that same transaction:

```ts
const updateCompanyProfileAction = defineAction({
  name: 'company.profile.updated',
  capability: 'company:update',
  input: companyProfileSchema,
  handler: async ({ tx, orgId, input, audit }) => { /* … */ },
});

// 'use server' modules may only export async functions, so each action is
// exposed through a one-line delegate.
export async function updateCompanyProfile(input: unknown) {
  return updateCompanyProfileAction(input);
}
```

Because `audit()` writes inside the caller's transaction, a change and its audit row commit or roll back together. There is no way to change data without leaving a trace, and none to leave a trace for a change that did not happen.

`tests/unit/action-guard.test.ts` fails if any export from a `'use server'` module is anything other than a one-line delegate to a `defineAction` handler.

## Roles

Clerk handles identity, MFA and organization membership. **Role is ours**, in `memberships.role` — Clerk's custom roles need the B2B add-on in production, and more importantly cannot express `valid_to` expiry or branch scope.

| Capability | Owner | Accountant | CA reviewer | Viewer |
|---|:-:|:-:|:-:|:-:|
| Read company, registrations, members | ✓ | ✓ | ✓ | ✓ |
| Update company, registrations | ✓ | ✓ | — | — |
| Invite, change role, remove | ✓ | — | — | — |
| Read audit history | ✓ | — | ✓ | — |

An accountant maintains the company's data but not who has access to it. A CA reviewer is read-only yet **can** read the audit log — a reviewer who cannot see who changed what cannot review.

External access is time-boxed: `memberships.valid_to` is applied by `app_resolve_membership()` at request time, so a lapsed membership is refused on the next request rather than on the next cron run.

## Editing entries

Every entry has an **Edit** link that opens it in the same form that created it, at `/process/edit/<kind>/<id>` (`voucher`, `party`, `item`, `bank`, `po`). Registrations and account names are edited in place on the Data page.

What saving does depends on the record:

| Record | On save |
|---|---|
| Party, item, bank account, registration, account name | Updated in place, with a before/after audit row. Vouchers already written keep the details they froze. |
| Purchase order | Updated in place while it is open and nothing has been received or billed against it. |
| Draft voucher | Rewritten under **its own number**; links from its source document and extraction follow it. |
| Posted voucher | **Corrected, never overwritten.** `runCorrection()` in `src/lib/db/corrections.ts` reverses the original and posts the edited version in one transaction. The replacement carries `corrects_voucher_id`; a reason is required and lands in the reversal's narration and the audit row. Receipts that had cleared the original are re-applied to the replacement (same party only, capped at its total), bank lines matched to the original go back to unmatched, and a bill's reverse-charge journal is reversed with it. |

The database still refuses any UPDATE to a posted voucher (0003, invariant 2) — correction is built entirely from reversal plus a new voucher, so the Companies Act audit trail keeps the original, the reversal and the fix. `tests/integration/voucher-edits.test.ts` drives every path through the real server actions against Postgres.

Forms start empty: no example text, and no GST rate, unit, quantity or party kind is assumed. An empty GST rate is refused by the server rather than read as nil.

## Money

No money columns exist yet. `src/lib/money.ts` fixes the convention now so Phase 2 cannot invent a second one: a branded `Paise` type over `bigint`, Indian lakh/crore formatting, and `paise()` in `src/lib/db/columns.ts` for the eventual columns.

`pnpm check:no-float` fails CI on `real`, `double precision`, `numeric(…)` or `decimal(…)` in any migration. Rounding is done in bigint arithmetic, not by converting to a Number — `(1.45).toFixed(1)` is `"1.4"` in IEEE-754, which would render ₹1.45Cr as ₹1.4Cr.

## Clerk configuration

1. Create the application and enable **Organizations**.
2. **User & Authentication → Multi-factor**: enable **Authenticator app (TOTP)** and **Backup codes**.
3. **Sessions → Customize session token**, add:
   ```json
   { "mfa": "{{user.two_factor_enabled}}" }
   ```
   `src/middleware.ts` reads this claim. If it is missing or malformed the check returns `false`, so a misconfigured dashboard **locks users out** rather than letting them past the gate. `requireOrgContext()` re-checks server-side regardless, because a route-matcher mistake must not become an authentication bypass.
4. Copy the publishable and secret keys into `.env.local`.

## Deploying to Neon + Vercel

### 1. Create the application role in the Neon SQL Editor

**Do not use Neon's Roles UI.** Roles created there are granted `neon_superuser`, which carries `BYPASSRLS` — every policy in this schema would be silently inert, and the failure is invisible because queries keep working and simply return other tenants' rows.

Create it with SQL instead, as the project's owner role:

```sql
CREATE ROLE sherrbyte_app WITH LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE
  PASSWORD 'replace-with-a-long-random-password';

GRANT CONNECT ON DATABASE neondb TO sherrbyte_app;   -- your database name
GRANT USAGE ON SCHEMA public TO sherrbyte_app;
```

That is all it needs. Every table, sequence and function grant is in the migration itself, so the role must exist *before* migrations run — otherwise they fail with `role "sherrbyte_app" does not exist`.

Confirm it came out right:

```sql
SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname = 'sherrbyte_app';
-- all four must be false
```

`pnpm db:bootstrap` asserts the same properties and refuses to continue otherwise, and `tests/integration/rls-privileges.test.ts` fails the build if they ever change.

### 2. Set the two connection strings in Vercel

Both come from the same Neon endpoint; only the role, password and host differ.

| Variable | Role | Host | Why |
|---|---|---|---|
| `DATABASE_URL` | `sherrbyte_app` | **pooled** (`-pooler` in the hostname) | Serverless functions open many short-lived connections. `withTenant` uses `SET LOCAL` inside a transaction, which is safe under PgBouncer's transaction pooling. |
| `DATABASE_URL_OWNER` | the Neon owner role | **direct** (no `-pooler`) | Migrations take a session-level advisory lock, which does not survive transaction pooling. |

```
DATABASE_URL="postgresql://sherrbyte_app:<password>@<endpoint>-pooler.<region>.aws.neon.tech/<db>?sslmode=require"
DATABASE_URL_OWNER="postgresql://<owner>:<password>@<endpoint>.<region>.aws.neon.tech/<db>?sslmode=require"
```

Keep `sslmode=require`: the pg client only enables TLS when it sees it in the string.

### 3. Migrations run during the build

`vercel.json` sets the build command to `pnpm db:migrate && pnpm build`, so a deploy cannot ship code whose schema has not been applied.

Two safeguards, both in `scripts/migrate.ts`:

- **Production only.** Preview deployments inherit the same `DATABASE_URL_OWNER`, so letting them migrate would apply an unreviewed branch's schema change to production data. Previews skip with a message. Set `ALLOW_PREVIEW_MIGRATIONS=1` on a preview environment that has its own database (a Neon branch, say) to opt in.
- **A session-level advisory lock.** Two builds can run at once — a push that supersedes an in-flight deploy, for instance. The second waits, then re-reads what has been applied and does nothing.

A missing `DATABASE_URL_OWNER` fails the build rather than skipping quietly: deploying code against an older schema breaks at the first query, which is worse than a red deploy.

**Do not seed production** — `db:seed` refuses unless `ALLOW_PRODUCTION_SEED` is set.

Server actions and route handlers run on the Node runtime because `pg` cannot run on Edge. Middleware is Edge and deliberately never touches the database.

## Reading documents with AI

Optional. Without it the inbox stores documents and nothing reads them; every bill
can still be entered by hand from the Process page. The feature degrades, the
product does not.

### Getting a key

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. **Create API key**, and pick a project (a new one is fine).
3. Copy the key. It is shown once.
4. Add it where the app runs:
   - locally, `GEMINI_API_KEY=...` in `apps/web/.env.local`
   - on Vercel, Project → Settings → Environment Variables → `GEMINI_API_KEY`,
     ticked for Production, then redeploy (environment variables are read at
     build and boot, so an existing deployment will not pick it up)
5. Optionally `GEMINI_MODEL` to override the default `gemini-2.5-flash`.

### On the free tier, use demo documents only

A free-tier key comes with terms that allow the content sent to it to be used to
improve the service. **Do not send a real client's papers through a free key.** Use
your own sample invoices while evaluating; for real books, use a paid key and read
the current terms yourself. The Input page carries this warning where the button is.

### What the model is and is not allowed to do

The rule the whole feature rests on is that **the model never produces a number that
reaches the ledger.** It is asked to transcribe, in as many words told not to compute
or correct anything, and every amount it returns is a *string* — a claim about a
document rather than an accounting value. What happens to that claim:

- our own parser turns the text into integer paise;
- our own GST engine recomputes the tax from the rate and the taxable value;
- the result is compared with the totals printed on the document, and a
  disagreement becomes a finding for a person, never a figure to prefer;
- a person edits whatever they want and approves;
- approving creates a **draft** voucher. Nothing in this path calls `postVoucher`,
  so no figure enters the books until somebody posts it deliberately.

A GSTIN is checked against its own check digit, so a misread one is caught by
arithmetic rather than by eye. A document on which this company is neither the
supplier nor the buyer is refused outright.

Swapping provider is one file: implement `ExtractionProvider` from
`src/lib/ai/contract.ts` and return it from `src/lib/ai/registry.ts`. That registry
is deliberately *not* part of the `'use server'` module — an override exported from
one would itself be a server action, which would let a browser choose where these
documents are sent.

## Tests

```bash
pnpm test          # unit + integration, against real local Postgres
pnpm test:e2e      # Playwright; SKIPS without Clerk test credentials, never passes vacuously
```

| Suite | What it proves |
|---|---|
| `tenant-isolation` | Table-driven over the whole schema: org A sees, and can write, none of org B. A new table without a policy fails automatically. |
| `rls-privileges` | The runtime role is not the owner, has no `BYPASSRLS`, owns nothing, and cannot create tables. |
| `audit-append-only` | `UPDATE` and `DELETE` on `audit_logs` are denied at the privilege level. |
| `membership-expiry` | Expired, unstarted and suspended memberships resolve to no access. |
| `permissions` | Full role × capability matrix. |
| `action-guard` | Every server action goes through `defineAction()`. |
| `db-encapsulation` | Nothing imports the raw pool or reaches the owner connection from a page. |
| `money` | Paise round-trip exactly; fractional input is refused, not rounded. |

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job | What it runs |
|---|---|
| **static** | typecheck, lint, `check:no-float`, production build. No database needed — every page is `force-dynamic`. |
| **database** | Postgres 16 service container, then `db:up → db:bootstrap → db:migrate → db:seed → test`. |
| **e2e** | Playwright. **Skips** unless `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `E2E_USER_EMAIL` and `E2E_USER_PASSWORD` are set as repository secrets, and says so in the run summary rather than reporting a pass. |

The `database` job uses three distinct roles, and that separation is the point:

```
postgres (superuser)   creates the database and the owner role
sherrbyte_owner        runs migrations and the seed
sherrbyte_app          what the tests connect as — owns nothing, no BYPASSRLS
```

Running the suite through any other role would prove nothing, because the owner is the one role the policies are designed to be bypassable by.

Several guarantees in this codebase are only real because CI keeps checking them:

- `tenant-isolation` catches a new table added without an RLS policy
- `rls-privileges` catches a database where the runtime role was given ownership or `BYPASSRLS`
- `action-guard` catches a hand-rolled server action that skipped the permission and audit path
- `check:no-float` catches a `numeric` column reaching a migration

To reproduce a CI run locally, point `SUPERUSER_DATABASE_URL` at a superuser and set the same variables the workflow does; `scripts/local-db.ts` takes that path instead of `su postgres` when the variable is present.

## Layout

```
drizzle/           hand-written SQL migrations — tables, policies, grants, functions
scripts/           local-db · bootstrap-roles · migrate · seed · check-no-float
src/lib/db/        schema · tenant (withTenant) · pool (internal) · owner (migrations only)
src/lib/auth/      permissions · context · action factory
src/lib/audit/     transaction-bound audit writer
src/server/        server actions and read queries
src/app/(app)/     shell: dashboard · people · data, plus Phase 2 placeholders
src/components/    shell (dock, top bar) and UI primitives
```

Migrations are hand-written rather than generated: the RLS policies, grants and `SECURITY DEFINER` functions are the substance of this schema, not something a generator should be guessing at. An applied migration is checksummed — editing one fails the next run and tells you to add a new file instead.
