# SherrByte

This repository holds two separate products.

| | What it is | State |
|---|---|---|
| **SherrByte** (consumer) | The news / Strings / Dots app. Spring Boot backend. | 22 Java files at the repo root. **Does not build** — no `pom.xml`, no `src/` layout. See `docs/00-REPO-AUDIT.md`, ticket CHORE-0. |
| **SherrByte Business** | B2B financial & business intelligence platform for Indian companies, accountants and CA firms. | **Phase 1 built** in `apps/web` — tenancy, auth, roles, audit. See [`apps/web/README.md`](apps/web/README.md). Blueprint below; clickable design prototype in `prototype/`. |

---

## SherrByte Business — the blueprint

> **A verification and preparation layer on top of the accounting systems an Indian company already runs.** It ingests the documents those systems never fully digest — bills, bank statements, POs, challans, GSTR-2B, payroll — reconciles them against the books, and produces numbers an owner can trust today and a CA can review and sign off. Every number traces back to the document it came from.
>
> **Tally records. SherrByte verifies, reconciles and explains.**

### Read in this order

| Doc | What it answers |
|---|---|
| [`00-REPO-AUDIT.md`](docs/00-REPO-AUDIT.md) | What is actually in this repository today, verified by inspection |
| [`01-PRODUCT-BLUEPRINT.md`](docs/01-PRODUCT-BLUEPRINT.md) | What the product is, the exact problem, the five users, competitive position |
| [`02-IPO-MATRIX.md`](docs/02-IPO-MATRIX.md) | Input → process → output for all five modules, with executor and acceptance test per row |
| [`03-OWNER-DASHBOARD-SPEC.md`](docs/03-OWNER-DASHBOARD-SPEC.md) | The dashboard, build-ready: 12 metrics, formulas, refresh, status model, trace contract |
| [`04-DESIGN-SYSTEM.md`](docs/04-DESIGN-SYSTEM.md) | The design language read off the reference images, turned into tokens and components |
| [`05-INFORMATION-ARCHITECTURE.md`](docs/05-INFORMATION-ARCHITECTURE.md) | Every screen and route, mapped to the two-sided Input/Process/Output navigation |
| [`06-ARCHITECTURE.md`](docs/06-ARCHITECTURE.md) | Data model, integrations, calculation engines, AI pipeline, permissions, security |
| [`07-WORKED-EXAMPLE.md`](docs/07-WORKED-EXAMPLE.md) | A real Indian trading month, arithmetic checked end to end: documents → verified numbers |
| [`08-USER-JOURNEYS.md`](docs/08-USER-JOURNEYS.md) | Seven journeys from connecting data to approving and downloading reports |
| [`09-IMPLEMENTATION-PLAN.md`](docs/09-IMPLEMENTATION-PLAN.md) | MVP scope, 8-phase roadmap, ~40 acceptance tests, first six tickets mapped to files |
| [`10-RISKS-AND-OPEN-QUESTIONS.md`](docs/10-RISKS-AND-OPEN-QUESTIONS.md) | Assumptions made, questions for you, and what a CA must validate |

### The five modules

`ACCOUNTING` → `TAXATION` · `FINANCIAL REPORTING` · `PROFIT ANALYSIS` · `DOCUMENTATION`

Modules 2–5 read only from the **verified accounting layer**. They never read raw documents and never write back. That single rule is what makes full traceability achievable.

### The rules the product cannot break

1. AI may extract, classify, interpret, summarise and draft. **AI never originates a number.**
2. All accounting, statement and tax arithmetic runs through deterministic, versioned, unit-tested engines.
3. Every number carries its source, formula, as-of time, completeness status, and a click-through to the underlying transactions and documents.
4. Uncertain extractions queue for human approval; they never post silently.
5. The product never claims to replace a CA, give an audit opinion, or guarantee tax compliance.
6. Tenant isolation is enforced by the database, not by application code.

### Phase 1 — what exists today

`apps/web` is a Next.js full-stack app (Drizzle, Neon Postgres, Clerk) covering:

- Clerk auth with a hard MFA gate that fails closed, organizations, invitations
- Four roles — owner, accountant, ca_reviewer, viewer — held in Postgres, with time-boxed external access
- Postgres row-level security on every table, enforced through a two-role setup so the runtime can never bypass it
- An append-only `audit_logs` table, written in the same transaction as the change it records
- Company profile and registrations (GSTIN, PAN, state, financial year)
- The app shell in the reference design language
- 58 tests, including tenant isolation run against real Postgres as the application role

Invoices, the ledger, document extraction and reporting are Phase 2.

### Conventions for anyone writing this code

- Money is `NUMERIC(18,2)` / `Decimal`. **`float` is banned in the money path**, enforced in CI.
- Every table carries `org_id` with an RLS policy created in the same migration.
- Every metric is defined **once**, in the metric registry. Dashboard, Excel, PDF and API all render from it.
- The LLM client has no import path to `ledger/` or `engines/`.
- A feature is done when backend, UI, error states, tests and monitoring all work.

---

*Figures shown anywhere in these documents or in the prototype are illustrative examples, never real company data.*
