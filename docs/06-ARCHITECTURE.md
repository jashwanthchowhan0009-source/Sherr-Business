# 06 — Architecture: Data Model, Integrations, Calculation, AI, Permissions

*Deliverable F. Where your PDF already decided something it is marked **[CONFIRMED]**. The rest is my recommendation.*

---

## 1. System shape

```
  Tally  Zoho  Banks  GSTN  Email-in  Drive  Manual upload
    │      │      │      │      │        │        │
    └──────┴──────┴──────┴──────┴────────┴────────┘
                        │
        ┌───────────────▼────────────────┐
        │  INGESTION  (connectors + queue)│  fetch · store original · hash · dedupe
        └───────────────┬────────────────┘
        ┌───────────────▼────────────────┐
        │  EXTRACTION  (AI, schema-bound) │  classify · extract · confidence
        └───────────────┬────────────────┘        ↓ low confidence
        ┌───────────────▼────────────────┐   ┌──────────────┐
        │  VALIDATION  (deterministic)    │──▶│ REVIEW QUEUE │ human
        └───────────────┬────────────────┘   └──────┬───────┘
        ┌───────────────▼──────────────────────────▼────────┐
        │  LEDGER CORE  transactions · journal · double-entry │  ← the only writer of numbers
        └───────────────┬───────────────────────────────────┘
        ┌───────────────▼────────────────┐
        │  CALCULATION ENGINES            │  accounting · tax · statements · analysis
        │  pure · versioned · unit-tested │
        └───────────────┬────────────────┘
        ┌───────────────▼────────────────┐
        │  METRIC / REPORT LAYER          │  every value carries its trace envelope
        └───────────────┬────────────────┘
              Dashboard · Excel · PDF · CSV · API · Notifications
```

## 2. Stack **[DECIDED — supersedes the FastAPI recommendation in the source material]**

*The PDF (p.22) proposed Python/FastAPI and the existing repository is Java. In September 2026 the decision was taken to build SherrByte Business as a **Next.js full-stack application**. Server actions replace the separate API service. The document-extraction worker returns in Phase 2 as Inngest jobs. This section records what was built, not what was proposed.*

| Layer | Choice | Why |
|---|---|---|
| Frontend + backend | **Next.js 15 App Router, TypeScript strict** | One deployable, one language, server actions for mutations |
| ORM | **Drizzle** | Typed schema, plain SQL migrations kept hand-written |
| Database | **Neon PostgreSQL** | Transactional integrity, `NUMERIC`/`bigint`, row-level security, `jsonb` |
| Driver | **`pg` (node-postgres)** | Neon's HTTP driver cannot hold a session, so `SET LOCAL` would not survive to the next statement. One driver for local and production. Requires the Node runtime; middleware never touches the database. |
| Auth | **Clerk** — identity, MFA, organizations | Role of record stays in `memberships.role`: Clerk custom roles need the B2B add-on in production and cannot express `valid_to` expiry or branch scope |
| Tenant isolation | **Postgres RLS via a transaction-scoped GUC** | Neon RLS/Authorize has folded into the Neon Data API and reads roles from a JWT; ours live in Postgres. `set_config(..., true)` is portable and testable against local Postgres. |
| Jobs | **Inngest** *(Phase 2)* | Nothing to schedule in Phase 1; membership expiry is applied at request time |
| Object storage | **Cloudflare R2** *(Phase 2)* | Nothing uploads files in Phase 1 |
| Observability | **Sentry** | Inert without a DSN; request bodies, headers and cookies are stripped before send |
| Tests | **Vitest + Playwright** | Integration tests run against real Postgres as the application role |
| Consumer app | **Unchanged Spring Boot**, separate service and database | See `docs/00-REPO-AUDIT.md` |

**Hard numeric rule:** money is integer **paise** — `bigint` in Postgres, `Decimal`/`bigint` in application code. **Float is banned in the money path**, enforced by `pnpm check:no-float` in CI. Rounding is half-up, applied once, at a point that is part of the engine's versioned definition.

**Two database roles, always.** A table's owner bypasses RLS silently. Migrations run as the owner (`DATABASE_URL_OWNER`); the application connects as `sherrbyte_app`, which owns nothing and has no `BYPASSRLS`. Every tenant table also sets `FORCE ROW LEVEL SECURITY`. See `apps/web/README.md`.

## 3. Data model

Extends the business-domain list from your PDF p.23 **[CONFIRMED: organizations, memberships, documents, extracted_fields, transactions, ledger_entries, reconciliation_matches, discrepancies, compliance_rules, review_decisions, reports, audit_logs]**.

### 3.1 Tenancy & identity
```sql
organizations(id, legal_name, trade_name, pan, cin, fy_start_month, base_currency,
              created_at, plan, status)
org_registrations(id, org_id→organizations, kind /*GSTIN|TAN|IEC|MSME*/, number,
                  state_code, effective_from, effective_to)
branches(id, org_id, name, state_code, gstin)
users(id, email, name, phone, mfa_enabled, created_at)
memberships(id, org_id, user_id, role, scope jsonb, invited_by,
            valid_from, valid_to, status)   -- valid_to gives CAs/auditors time-boxed access
```
**Every business table carries `org_id`, and Postgres Row-Level Security is enabled on every one of them.** Tenant isolation is enforced by the database, not by application code — application-level filtering is one forgotten `WHERE` away from a breach, and a breach here ends the company. **[CONFIRMED requirement: multi-tenant data isolation]**

### 3.2 Documents & extraction — the evidence spine
```sql
documents(id, org_id, storage_key, original_filename, mime, byte_size,
          content_hash,                      -- SHA-256, the first dedupe gate
          perceptual_hash,                   -- catches rescans of the same paper
          source_kind /*upload|email|drive|tally|bank|gstn*/, source_ref,
          doc_type /*sales_invoice|purchase_bill|po|challan|bank_stmt|receipt|payroll|contract|other*/,
          doc_type_confidence, page_count,
          status /*received|extracting|extracted|needs_review|approved|rejected|superseded*/,
          received_at, extracted_at, approved_at, approved_by)

extracted_fields(id, document_id→documents, org_id,
                 field_path,                 -- 'header.invoice_no', 'lines[2].rate'
                 value_text, value_number NUMERIC(18,4), value_date,
                 confidence NUMERIC(4,3),
                 page_no, bbox jsonb,        -- pixel region → the highlight in the trace sheet
                 method /*ocr|llm|native_pdf|api|manual*/,
                 model_version, prompt_version,
                 validated_by, validated_at, original_value_text)  -- keeps the correction trail
```
`extracted_fields.bbox` is what lets a user click `₹14L` and end up looking at the exact rectangle on page 1 of a PDF. It is the most important column in the schema and it must be captured from day one — retrofitting it is very expensive.

### 3.3 Masters
```sql
parties(id, org_id, kind /*customer|supplier|both*/, name, legal_name, gstin, pan,
        state_code, payment_terms_days, credit_limit, is_msme, status)
party_aliases(id, party_id, alias, source)   -- 'ACME ENTERPRISES' == 'Acme Enterprise Pvt Ltd'
items(id, org_id, code, name, uom, hsn_sac, default_gst_rate, is_service)
chart_of_accounts(id, org_id, code, name, type /*asset|liability|equity|income|expense*/,
                  parent_id, is_control_account, tally_ledger_name)
mapping_rules(id, org_id, scope, predicate jsonb, account_id, priority,
              created_by, effective_from)    -- how a transaction finds its ledger account
```

### 3.4 Transactions & the ledger
```sql
transactions(id, org_id, txn_type /*sales_invoice|credit_note|purchase_bill|debit_note|
             payment|receipt|journal|expense|payroll|contra*/,
             txn_no, txn_date, party_id, branch_id, currency,
             subtotal, tax_total, total, notes,
             source_document_id→documents,
             status /*draft|pending_review|posted|void*/,
             posted_at, posted_by, period_id, void_reason,
             created_from /*extraction|tally_sync|manual|api*/)

transaction_lines(id, transaction_id, org_id, line_no, item_id, description,
                  quantity, rate, amount, discount,
                  tax_rate, cgst, sgst, igst, cess, hsn_sac, account_id)

ledger_entries(id, org_id, transaction_id, account_id, debit, credit,
               entry_date, period_id, narration)
```
**Invariant, enforced by a deferred constraint trigger:** for every `transaction_id`, `SUM(debit) = SUM(credit)`. A posting that violates it is rejected by the database. Not by a service, not by a test — by the database.

```sql
periods(id, org_id, fy, name, date_from, date_to,
        status /*open|closing|closed|locked*/, closed_by, closed_at)
```
Nothing may post into a `closed` or `locked` period. Reopening is an audited action requiring elevated permission.

### 3.5 Reconciliation & exceptions
```sql
bank_accounts(id, org_id, bank, account_no_masked, ifsc, account_id→chart_of_accounts,
              opening_balance, opening_date, connector_id)
bank_statement_lines(id, org_id, bank_account_id, value_date, narration, ref_no, utr,
                     debit, credit, running_balance, import_batch_id,
                     status /*unmatched|suggested|matched|ignored*/)

reconciliation_matches(id, org_id, match_type /*bank_txn|three_way|itc_2b|ledger_import*/,
                       left_kind, left_id, right_kind, right_id,
                       amount_matched, residual, residual_reason /*tds|bank_charge|round_off|fx*/,
                       confidence, method /*exact|rule|fuzzy|manual*/, rule_version,
                       matched_by, matched_at, status)

discrepancies(id, org_id, kind /*duplicate|qty_mismatch|price_variance|missing_document|
              unmatched_bank_line|itc_mismatch|balance_divergence|missing_field|
              threshold_breach*/,
              severity /*critical|high|medium|low*/, amount_impact,
              subject_kind, subject_id, detected_by_rule, rule_version, detected_at,
              status /*open|assigned|resolved|waived*/, assigned_to,
              resolution, resolved_by, resolved_at, waiver_reason)
```
`discrepancies.amount_impact` is what drives the owner's attention queue ordering and the `INCOMPLETE` status reason on metrics. Every detector **must** populate it.

### 3.6 Rules, review, reporting, audit
```sql
rule_sets(id, kind /*gst|tds|depreciation|accounting_policy*/, version, effective_from,
          effective_to, definition jsonb, published_by, published_at)
```
Rule sets are **versioned and dated**. Recomputing March 2026 uses the rule in force in March 2026 — this is a legal requirement, not a nicety. **[CONFIRMED — "Versioned tax/accounting rules"]**

```sql
review_decisions(id, org_id, subject_kind, subject_id, decision /*approve|reject|waive|reopen*/,
                 decided_by, role_at_decision, comment, decided_at, evidence_snapshot jsonb)

metric_snapshots(id, org_id, metric_id, period_id, as_of, value NUMERIC(18,2),
                 status, status_reason, formula_version, rule_set_version,
                 inputs_hash, computed_at)
```
`metric_snapshots` gives point-in-time reproducibility: *"what did the dashboard say on 5 October, and why?"* `inputs_hash` proves the inputs have not changed since.

```sql
reports(id, org_id, kind, period_id, format, storage_key, content_hash,
        generated_by, generated_at, status /*draft|provisional|final*/,
        approved_by, approved_at, distributed_to jsonb)

audit_logs(id, org_id, actor_user_id, actor_role, action, subject_kind, subject_id,
           before jsonb, after jsonb, ip, user_agent, at)
```
`audit_logs` is append-only (no UPDATE/DELETE grant to the application role) and records **reads of sensitive data too**, not just writes. **[CONFIRMED — "Full audit trail"]**

---

## 4. Integrations

| Source | Method | Direction | Notes |
|---|---|---|---|
| **Tally Prime** | Local connector over Tally's XML/ODBC on port 9000, or scheduled export watch | Read + **write-back** of approved vouchers | Tally is usually on a desktop behind a router — ship a small local agent that polls and pushes over an outbound TLS tunnel. Assume no inbound connectivity. |
| **Zoho Books** | REST API + OAuth | Read + write-back | Clean API; do this one first, it is the fastest integration to prove the loop |
| **Bank statements** | Manual upload (PDF/CSV/XLS) in MVP; account aggregator / bank API later | Read | **Start with upload.** Bank API access in India is slow to obtain and would block the MVP. Statement parsing per bank format is real work — budget for the top 8 banks. |
| **GSTN (GSTR-2B/2A/3B/1)** | Via a licensed GSP, or user-uploaded JSON/Excel from the portal | Read | MVP: **user uploads the 2B JSON.** GSP contracting is a business milestone, not an engineering one; do not let it gate the product. |
| **Email-in** | Per-org inbox `<org-slug>@in.sherrbyte.com` | Read | Vendors email bills; this is the highest-adoption ingestion channel in practice |
| **Drive / folder watch** | Google Drive / OneDrive / local folder | Read | Many businesses already dump bills into a shared folder |
| **Excel / CSV** | Templated importers with a mapping UI | Read | Always needed; never optional |
| **Outbound** | CSV/XML export, webhooks, REST API | Write | Push approved entries back to Tally/ERP |

**Integration rule:** every connector records `last_successful_sync`, `last_error`, `records_ingested`, and a freshness SLA. That feeds the trust ribbon. A connector that fails silently is worse than no connector — it makes the dashboard confidently wrong.

---

## 5. Calculation & AI — the boundary that defines this product

### 5.1 The rule
**AI never produces a number that reaches the ledger or a report.**

| AI may | AI may not |
|---|---|
| Read a document and propose field values with confidence | Decide a balance, a tax amount or a total |
| Classify a document or a transaction | Post a journal entry |
| Suggest candidate matches for reconciliation | Confirm a match above the auto-threshold |
| Draft narrative, explain a variance, summarise | Assert a fact not present in computed data |
| Answer "why is this number this?" from the trace | Compute the number it is explaining |

Enforced structurally: **the LLM client library has no import path to the ledger or engine modules.** Extraction output is a validated DTO; the only way into `transactions` is through the posting service, which requires either a confidence gate pass or a `review_decisions` row.

### 5.2 Calculation engines
Pure functions. Inputs in, value + trace out. No I/O, no clock, no randomness — the period and `as_of` are always parameters.

```python
def receivables_overdue(
    invoices: Sequence[Invoice], payments: Sequence[Payment],
    credit_notes: Sequence[CreditNote], terms: TermsResolver,
    as_of: date,
) -> MetricResult:            # MetricResult carries value, contributing ids, formula_version
    ...
```

- One module per engine: `engines/accounting`, `engines/gst`, `engines/tds`, `engines/statements`, `engines/analysis`.
- Every engine is versioned (`receivables@1.3.0`) and the version is stamped on every value it produces.
- **Golden test datasets** **[CONFIRMED — p.25]**: anonymised real invoices, POs, challans, bank statements and 2B extracts with hand-verified expected outputs. A change that alters a golden output must be an explicit, reviewed version bump.
- Property tests for the invariants: trial balance nets to zero; a reconciliation's matched amounts never exceed either side; GST components sum to the tax total.

### 5.3 The AI extraction pipeline

```
receive → hash & dedupe → classify doc_type → route to the schema for that type
   → extract with a schema-constrained LLM call → validate against JSON Schema
   → arithmetic self-check (Σ lines + tax == total; tax == taxable × rate)
   → cross-check (GSTIN checksum, PAN format, date sanity, party resolution)
   → score confidence  ──┬── ≥ auto_threshold AND all checks pass → propose posting
                         └── otherwise → REVIEW QUEUE with the failing check named
```

**Confidence gating:**
- `field_confidence` from the model, **combined with** rule-based verification. The arithmetic self-check is worth more than the model's self-reported confidence and is weighted accordingly.
- `auto_post_threshold` is **per org, per document type**, starts at "never", and only rises after a measured period of human agreement. **A new customer auto-posts nothing on day one.** This is a trust product; earn it.
- Any document whose total > a configured value always goes to review regardless of confidence.

**The correction loop (§ the defensible asset):** every human correction writes `original_value_text` alongside the new value, keyed to the vendor and layout. These become per-org extraction hints — "this vendor puts the invoice number top-right", "this customer's PO number appears in the narration". After ~50 corrections a vendor's documents should extract near-perfectly. **This is the moat; it compounds per customer and cannot be copied by a competitor adding an OCR feature.**

### 5.4 Reconciliation matching
Deterministic cascade, cheapest and most certain first:
1. **Exact** — UTR/reference + amount + date window
2. **Rule** — amount exact + party resolved + within terms
3. **Set** — one receipt against a subset of invoices (subset-sum bounded by party + date window)
4. **Residual-aware** — exact match after allowing a TDS / bank-charge / round-off residual within tolerance, residual reason recorded
5. **Fuzzy** — narration similarity + amount tolerance ⇒ **suggestion only, never auto-matched**

Tiers 1–4 may auto-match if inside the org's tolerance. Tier 5 always requires a human. Every match records its tier, confidence and rule version.

---

## 6. Permissions

Role-based, with data scope. **[CONFIRMED — "Role-based access", and the PDF p.21 role list: company admin, accountant, finance manager, external CA, auditor]**

| Capability | Owner | Admin | Finance mgr | Accountant | CA reviewer | Auditor |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| View owner dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Upload documents | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Correct extractions | — | ✓ | ✓ | ✓ | ✓ | — |
| Post to ledger | — | ✓ | ✓ | ✓ | — | — |
| Resolve exceptions | — | ✓ | ✓ | ✓ | ✓ | — |
| Waive an exception | ✓ | ✓ | ✓ | — | ✓ | — |
| Close a period | — | ✓ | ✓ | — | ✓ | — |
| Reopen a closed period | ✓ | ✓ | — | — | — | — |
| Approve tax workings | ✓ | — | — | — | ✓ | — |
| Publish a final report | ✓ | ✓ | ✓ | — | ✓ | — |
| Manage members & roles | ✓ | ✓ | — | — | — | — |
| Manage integrations | ✓ | ✓ | — | ✓ | — | — |
| View salary-level payroll | ✓ | ✓ | — | scoped | scoped | — |
| Read audit log | ✓ | ✓ | — | — | ✓ | ✓ |
| Export evidence pack | ✓ | ✓ | ✓ | — | ✓ | ✓ (scoped) |

**Additional controls**
- **Scope** on a membership narrows access by branch, period range or module — this is how a CA gets FY 2025-26 only, and how an auditor gets one engagement only.
- **Time-boxing:** `memberships.valid_to`. External access expires by default.
- **Segregation of duties:** the user who posts a transaction cannot be the sole approver of the period containing it, above a configurable materiality.
- **Sensitive-read logging:** payroll detail, bank credentials and full document downloads are logged as read events.

---

## 7. Security **[CONFIRMED requirements]**

- **Encryption:** TLS 1.3 in transit; AES-256 at rest (DB + object storage, SSE-KMS); per-tenant KMS key.
- **Documents:** private bucket, no public URLs ever; access only via short-lived signed URLs issued after an authorisation check and written to the audit log.
- **Isolation:** Postgres RLS on every table + per-tenant storage prefix. Integration tests assert that a request authenticated as org A returns zero rows from org B — one test per table.
- **Absolute wall:** SherrByte Business data must never enter the consumer SherrByte app's personalisation system. **[CONFIRMED — p.21]** Enforce with separate databases, separate credentials, and no network path between the two services.
- **Secrets:** no key in the repo. The current consumer code reads `app.gemini.key` etc. from configuration that does not exist in the repository — keep it that way and load from a secret manager.
- **Data residency:** India region. Note in `docs/10-RISKS-AND-OPEN-QUESTIONS.md` that DPDP Act obligations need legal review before the first paying customer.
- **Retention & deletion:** per-org retention policy; a documented export-and-delete path. A finance customer will ask about this in the first sales call.
