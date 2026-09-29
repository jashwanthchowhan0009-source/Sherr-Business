# 09 — MVP, Roadmap, Acceptance Tests & Repository Plan

*Deliverables H and J. Estimates are planning estimates for a team of 3–4, not delivery guarantees — the same caveat your own PDF applies on p.24.*

---

## 1. The MVP, stated as one sentence

> **A company connects Tally (or Zoho) and uploads a bank statement and a folder of bills. Within an hour, the owner sees cash, sales, receivables and payables — each correct, each traceable to a document, each honestly badged — and the accountant has a working queue that removes several hours of daily manual work.**

Everything not required by that sentence is out of the MVP.

### In the MVP
- Org setup, roles, invitations, RLS tenant isolation
- Document ingestion: upload, email-in, Tally/Zoho sync
- Extraction for **4 document types only**: sales invoice, purchase bill, bank statement, PO/challan
- AI Document Inbox with confidence gating and the correction loop
- Duplicate detection, three-way match, bank reconciliation
- Ledger core with the double-entry invariant
- Metrics: `AVAILABLE_CASH`, `SALES_MTD`, `RECEIVABLES_*`, `PAYABLES_*`, `NET_CASH_FLOW`, `NEEDS_ATTENTION`
- Owner dashboard (Bands 0, A, B, D) + accountant queue
- Full trace: number → transactions → document → highlighted region
- Excel + CSV export; audit log

### Deliberately **not** in the MVP
Taxation (Phase 2), financial statements (Phase 2), profit analysis (Phase 3), documentation packs (Phase 3), forecasting (Phase 3), mobile app, GSP integration, bank API feeds, inventory, payroll processing, e-invoicing.

**The reason:** Band C metrics (gross profit, EBITDA, net profit) require a valued closing stock and a closed period. Shipping them before reconciliation is solid produces confidently wrong profit figures — the single fastest way to lose a finance customer. Your PDF says exactly this on p.21: *"Revenue/profit dashboard tabhi add karo jab sales, expenses, adjustments aur accounting periods correctly reconcile ho rahe hon."* **[CONFIRMED]**

---

## 2. Phased roadmap

| Phase | Weeks | Ships | Gate to the next phase |
|---|---|---|---|
| **P0 · Foundation** | 1–2 | Repo structure, `src/` restore + `pom.xml` for the consumer app (CHORE-0), FastAPI skeleton, Postgres + RLS + migrations, auth, org/membership, audit log, CI | RLS cross-tenant test suite green |
| **P1 · Ingestion & extraction** | 3–6 | Upload + email-in, object storage, doc classification, extraction for 4 types, JSON-Schema validation, arithmetic self-check, confidence gating, **AI Document Inbox**, correction loop | ≥ 80% zero-correction on 50 real bills |
| **P2 · Ledger & reconciliation** | 7–10 | Ledger core + double-entry invariant, masters, mapping rules, duplicate detection, three-way match, bank statement parsing (top 8 banks), matching cascade, exception queue | ≥ 70% auto-match, **zero** false positives on a 200-line statement |
| **P3 · Owner dashboard + trace** | 11–13 | Metric registry, Bands 0/A/B/D, status model, trace sheet, drill-down chain, Excel/CSV export, notifications | **AT-DASH-1** green for every metric |
| **P4 · Pilot** | 14–16 | 3 design-partner companies on real data, daily use, instrumentation, fix what breaks | 2 of 3 partners using it daily without falling back to Excel |
| **P5 · Taxation** | 17–22 | Versioned rule sets, GST engine + set-off ladder, GSTR-2B reconciliation, TDS engine + thresholds, tax calendar, CA review workflow, **CA client review board** | Worked-example reproduction + CA sign-off on 3 real months |
| **P6 · Financial reporting** | 23–28 | Period close checklist & gates, P&L, Balance Sheet, Cash Flow, schedules, budget vs actual, Band C metrics, PDF generation | Statements tie to trial balance; CFS closing cash = reconciled bank balance |
| **P7 · Analysis & documentation** | 29–34 | Profitability by product/customer/branch, expense trends, cash-flow forecast, alerts, management report, CA workpapers, audit/loan packs | Forecast accuracy measured against 3 months of actuals |
| **P8 · Scale** | 35+ | GSP integration, bank feeds, more document types, more ERPs, mobile, API/webhooks | — |

**Critical path:** P1 → P2 → P3. Everything else can slip. If extraction accuracy or match precision is not good enough, *nothing downstream matters* — do not proceed to P3 to make the demo look better.

---

## 3. Acceptance tests

*Every test below is automated and runs in CI against a seeded demo company built from `docs/07-WORKED-EXAMPLE.md`. **[CONFIRMED — your PDF p.25 requires golden test datasets: anonymised invoices, POs, challans and expected reconciliation outcomes.]***

### Tenant isolation *(blocking, every release)*
- **AT-SEC-1** For every table, a request authenticated as org A returns zero rows belonging to org B.
- **AT-SEC-2** A signed document URL issued for org A returns 403 for a user of org B.
- **AT-SEC-3** A membership past `valid_to` is denied on every endpoint.
- **AT-SEC-4** No network path exists from the Business service to the consumer app's database.

### Extraction
- **AT-EXT-1** 50 real mixed bills ⇒ ≥ 80% require zero field corrections.
- **AT-EXT-2** Any document failing its arithmetic self-check is queued, never auto-posted.
- **AT-EXT-3** The same invoice uploaded as PDF, photo and Tally record ⇒ exactly 1 transaction, 2 marked `superseded`, the rule named.
- **AT-EXT-4** A malformed/unreadable document produces a clear failure state, never a partial posting.
- **AT-EXT-5** Auto-post threshold defaults to "never" for a new org.

### Ledger
- **AT-LED-1** Any posting where `Σ debit ≠ Σ credit` is rejected **by the database**.
- **AT-LED-2** A posting into a closed or locked period is rejected.
- **AT-LED-3** Trial balance nets to exactly ₹0.00 across the seeded dataset.
- **AT-LED-4** No `float` appears anywhere in the money path (static check in CI).

### Reconciliation
- **AT-REC-1** 200-line statement ⇒ ≥ 70% auto-matched at tiers 1–4, **zero** false positives.
- **AT-REC-2** ₹6,96,000 receipt vs ₹7,08,000 invoice ⇒ matched with `residual_reason='tds'`, ₹12,000 to TDS receivable.
- **AT-REC-3** One receipt against 5 invoices ⇒ the correct set proposed.
- **AT-REC-4** PO 1,000 / challan 950 / invoice 1,000 ⇒ `QTY_MISMATCH`, `amount_impact = ₹29,500`, all three documents linked.
- **AT-REC-5** Re-importing an overlapping statement period creates no duplicate lines.
- **AT-REC-6** Tier-5 fuzzy candidates are never auto-matched.

### Dashboard & trace
- **AT-DASH-1** *(the product's core contract)* For every metric on every dashboard, `SUM(drill-down list) == displayed value`, to the paisa.
- **AT-DASH-2** Every Band C metric renders `PROVISIONAL` while its period is open — on screen, in Excel **and** in PDF.
- **AT-DASH-3** Every `INCOMPLETE` metric states a cause **and** a ₹ impact bound.
- **AT-DASH-4** Every metric value carries a complete trace envelope; the UI refuses to render one without it.
- **AT-DASH-5** Killing a source connector flips affected metrics to `STALE` within one refresh cycle.
- **AT-DASH-6** The same metric shows the identical value on the dashboard, in Excel and in the API.

### Taxation *(P5)*
- **AT-TAX-1** The `docs/07-WORKED-EXAMPLE.md` GST scenario reproduces exactly, including the head-wise set-off.
- **AT-TAX-2** Karnataka→Tamil Nadu ⇒ IGST; Karnataka→Karnataka ⇒ CGST+SGST.
- **AT-TAX-3** An invoice absent from GSTR-2B is `ITC_DEFERRED` and never included in claimed ITC.
- **AT-TAX-4** Recomputing a past period uses the rule version in force **then**, not today's.
- **AT-TAX-5** 194C threshold crossed mid-year ⇒ earlier under-deduction flagged with the amount.
- **AT-TAX-6** Every taxation output reads `DRAFT — requires CA review` until a CA records approval.

### Statements *(P6)*
- **AT-FIN-1** A Balance Sheet that does not balance is **not rendered**; the imbalance is reported.
- **AT-FIN-2** Cash Flow closing cash == reconciled bank balance, exactly.
- **AT-FIN-3** A period with an unresolved critical exception cannot be closed.
- **AT-FIN-4** Changing a depreciation policy does not alter closed periods.

### Audit
- **AT-AUD-1** Every posting, approval, waiver, close and reopen is in `audit_logs` with actor, role, before/after.
- **AT-AUD-2** The application role has no UPDATE or DELETE grant on `audit_logs`.
- **AT-AUD-3** Sensitive reads (payroll detail, document download) are logged.

---

## 4. Repository plan — mapped to the files that actually exist

### 4.1 Target structure

```
/                                   ← this repository
├── docs/                           ← this blueprint  ✅ exists
├── apps/
│   ├── consumer-api/               ← CHORE-0: the 22 existing .java files, restored
│   │   ├── pom.xml                     (NEW — none exists today)
│   │   └── src/main/java/com/sherbyte/
│   │       ├── SherbyteApplication.java
│   │       ├── config/       AppConfig · CorsConfig · SecurityConfig
│   │       ├── security/     JwtUtil · JwtFilter
│   │       ├── model/        Article · RawArticle · UserProfile · Interaction
│   │       ├── repository/   ArticleRepository · RawArticleRepository ·
│   │       │                 UserProfileRepository · InteractionRepository
│   │       ├── dto/          InteractRequest · OnboardRequest
│   │       ├── service/      CollectorService · ProcessorService ·
│   │       │                 SchedulerService · FeedService · CacheService
│   │       └── controller/   FeedController
│   │   └── src/main/resources/application.yml   (NEW — externalised secrets)
│   │
│   ├── business-api/               ← NEW: SherrByte Business (Python/FastAPI)
│   │   ├── alembic/                    migrations
│   │   └── sherrbyte/
│   │       ├── tenancy/                orgs, memberships, RLS policies
│   │       ├── ingestion/              connectors: tally · zoho · email · drive · upload
│   │       ├── extraction/             classify · extract · schemas · confidence · hints
│   │       ├── ledger/                 transactions · journal · periods · invariants
│   │       ├── recon/                  cascade · three_way · bank · itc_2b
│   │       ├── engines/                accounting · gst · tds · statements · analysis
│   │       │                           ↑ pure, versioned, no I/O
│   │       ├── metrics/                registry.py ← the single source of truth
│   │       ├── reporting/              excel · pdf · csv · packs
│   │       ├── api/                    FastAPI routers
│   │       └── audit/                  append-only log
│   │
│   └── business-web/               ← NEW: Next.js + TS + Tailwind
│       ├── design/tokens.ts            from docs/04-DESIGN-SYSTEM.md
│       ├── components/                 DataCard · Dock · SideToggle · DropPanel ·
│       │                               TypeChip · FolderTile · StatusPill ·
│       │                               ExceptionRow · TraceSheet · CommandBar
│       └── app/                        routes exactly per docs/05-INFORMATION-ARCHITECTURE.md
│
├── prototype/                      ← clickable design prototype  ✅ shipped this sprint
└── infra/                          ← docker-compose, migrations, CI
```

### 4.2 The first six tickets, in order

| # | Ticket | Files | Done when |
|---|---|---|---|
| **CHORE-0** | Make the consumer app buildable again | Move the 22 root `.java` files into `apps/consumer-api/src/main/java/com/sherbyte/**` per their own line-1 path comments; add `pom.xml` (Spring Boot 3, JPA, Security, JJWT, Redis, Rome, Lombok); add `application.yml` reading `app.jwt.secret`, `app.newsapi.key`, `app.gnews.key`, `app.gemini.key`, `app.gemini.model` from env | `mvn -q package` succeeds; `/health` returns `{"status":"ok"}` |
| **SB-1** | Postgres schema + RLS | `apps/business-api/alembic/versions/0001_*` — §3 of `docs/06-ARCHITECTURE.md` | **AT-SEC-1** green for every table |
| **SB-2** | Ledger core + double-entry invariant | `sherrbyte/ledger/` + a deferred constraint trigger | **AT-LED-1/2/3/4** green |
| **SB-3** | Document ingestion + storage + dedupe | `sherrbyte/ingestion/` | **AT-EXT-3** green |
| **SB-4** | Extraction pipeline + AI Document Inbox | `sherrbyte/extraction/`, `business-web/app/input/inbox` | **AT-EXT-1/2/4/5** green |
| **SB-5** | Matching cascade + exception queue | `sherrbyte/recon/`, `business-web/app/process/review` | **AT-REC-1…6** green |
| **SB-6** | Metric registry + owner dashboard + trace | `sherrbyte/metrics/registry.py`, `business-web/app/dashboard` | **AT-DASH-1…6** green |

### 4.3 Rules for whoever writes this code

1. **Do not touch the 22 existing Java files except to move them.** They are a different product. CHORE-0 is a move plus two new files — no logic changes.
2. **No `float` in the money path.** `Decimal` in Python, `NUMERIC` in Postgres, enforced by a CI check.
3. **Every table gets `org_id` and an RLS policy in the same migration that creates it.** Never "add RLS later".
4. **A metric is defined once**, in `metrics/registry.py`. Dashboard, Excel, PDF and API all render from it. No second EBITDA.
5. **The LLM client must have no import path to `ledger/` or `engines/`.** Enforce with an import-linter rule in CI.
6. **Every engine function is pure and versioned**, and stamps its version on every value it returns.
7. **Feature-flag anything incomplete.** A half-built taxation screen must not be reachable in production. **[CONFIRMED — p.27]**
8. **A feature is done when backend, UI, error states, tests and monitoring all work** — not when the screen renders. **[CONFIRMED — p.24]**
