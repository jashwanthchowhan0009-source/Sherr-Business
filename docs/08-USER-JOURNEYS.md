# 08 — Critical User Journeys

*Deliverable G. Each journey runs from connecting/uploading data to approving and downloading a result. Each ends with the acceptance test that proves it works.*

---

## J1 — Onboarding a new company *(owner + accountant, day 1, target: first real number in under 60 minutes)*

1. Owner signs up → creates the organisation → enters legal name, PAN, GSTIN(s), FY start, branches.
2. **Guided source connection.** In order of value: Tally (local agent) or Zoho Books → bank statement upload → GSTR-2B upload → email-in address shown and copied.
3. **Opening balances.** Import the trial balance as of the chosen start date. The engine validates it balances; if it does not, the difference is itemised and the user is blocked from proceeding — *starting from a wrong opening balance poisons every number forever, so this gate is hard.*
4. **Chart of accounts mapping.** The system proposes a mapping from the imported COA to its internal types; the accountant confirms. Unmapped accounts are listed, not silently defaulted.
5. **First reconciliation run.** The engine matches what it can and produces the first exception list.
6. Owner is shown the dashboard with **honest status badges** — most metrics will read `INCOMPLETE` on day one, and the ribbon says exactly what is needed to make them `VERIFIED`.

> **Design note:** do not hide day-one incompleteness behind a polished demo dashboard. Showing "₹24.5L — INCOMPLETE, 40 unmatched items" on day one, with a clear path to fix it, is what earns the accountant's trust. A dashboard that looks perfect on day one and turns out to be wrong on day ten loses the account.

**Acceptance:** a company with a Tally file, one bank statement and an opening TB reaches a dashboard with a correct `AVAILABLE_CASH` in **under 60 minutes**, with every incomplete metric stating its cause.

---

## J2 — Bill to posted entry *(accountant, many times a day — the highest-volume journey in the product)*

1. A vendor emails a bill to `balaji@in.sherrbyte.com`. It lands in `/input/inbox` within 2 minutes.
2. Classified as `purchase_bill`; fields extracted; arithmetic self-check runs (Σ lines + tax = total).
3. Duplicate check against content hash and (vendor, invoice no, date, amount).
4. Three-way match attempted against open POs and challans.
5. **Accountant opens the inbox.** Document on the left, fields on the right, low-confidence fields highlighted. Tab between fields, correct, `⌘↵` to approve. Next item loads automatically.
6. On approval: transaction created, journal entry generated, double-entry validated, posted.
7. The correction (if any) is stored as a per-vendor hint — the next bill from that vendor extracts better.

**Acceptance:** 50 mixed real bills processed. **≥ 80% require zero field corrections**; 100% are either posted or queued with a stated reason; zero duplicates posted; median handling time under 15 seconds per document.

---

## J3 — Bank statement to reconciled cash *(accountant, daily)*

1. Upload or sync the statement. Lines normalised; the import is idempotent — re-uploading an overlapping period creates no duplicates.
2. Engine runs the matching cascade (exact → rule → set → residual-aware → fuzzy suggestion).
3. `/process/bank` shows three groups: **auto-matched** (collapsed), **suggested** (needs one click), **unmatched** (needs work).
4. Accountant confirms suggestions, drags to match the rest, records residual reasons (TDS, bank charge, round-off).
5. Anything still unmatched becomes a discrepancy with an impact amount.
6. `AVAILABLE_CASH` recomputes; its status and reason update on the owner's dashboard immediately.

**Acceptance:** on a 200-line real statement, **≥ 70% auto-matched at tier 1–4** with zero false positives. A false positive (wrong auto-match) is a **release-blocking defect** — an incorrect match is far worse than an unmatched line.

---

## J4 — Month-end close *(accountant → CA, monthly)*

1. Accountant opens `/process/close` for September. The checklist shows gates:
   - all bank accounts reconciled through 30 Sep — **blocking**
   - AI inbox empty — **blocking**
   - critical/high exceptions resolved or waived with reason — **blocking**
   - closing stock valued — **blocking for gross profit**
   - GSTR-2B reconciled — warning
   - accruals and prepayments posted — warning
2. Blocking gates link straight to the work. The period cannot close until they are green.
3. Accountant closes the period → it locks → the CA is notified.
4. **CA opens the client review board**, sees Shree Balaji is ready, and reviews **the exception summary and the workings — not the transactions.**
5. CA approves or rejects with a comment. A `review_decisions` row is written.
6. On approval: Band C metrics flip `PROVISIONAL` → `VERIFIED`; the P&L, Balance Sheet and Cash Flow are marked `FINAL`; the management report pack generates.

**Acceptance:** a period with an unresolved critical exception **cannot** be closed. A closed period **cannot** receive a posting. Reopening requires owner/admin permission and is written to the audit log.

---

## J5 — GST month *(accountant → CA, monthly)*

1. Upload GSTR-2B JSON (or fetch via GSP).
2. Engine reconciles 2B against the purchase register and classifies every line: matched / in-2B-not-in-books / in-books-not-in-2B / value mismatch.
3. Accountant works the mismatch list — the "in-books-not-in-2B" bucket becomes the vendor follow-up list.
4. Engine computes the liability with the **set-off ladder** (IGST → CGST → SGST), produces draft return data, and marks it `DRAFT — requires CA review`.
5. CA reviews the workings, drills into any figure, approves.
6. Return data exports in the filing tool's format. **SherrByte does not file.** An authorised human does.

**Acceptance:** the full `docs/07-WORKED-EXAMPLE.md` scenario reproduces exactly — output ₹2,16,000, ITC ₹1,04,400, deferred ₹21,600, cash payable ₹1,11,600 with the correct head-wise split. Deferred ITC is never included in claimed ITC.

---

## J6 — Owner asks "why?" *(owner, several times a week — the journey that creates trust)*

1. Owner sees `Customer dues ₹5.9L` and taps it.
2. Trace sheet opens: formula, as-of, status + reason, source datasets.
3. Customer breakdown → Gokul Agencies ₹3,54,000, overdue 26 days.
4. Tap → INV-1031 with its payment history.
5. Tap → the source PDF with the extracted total **highlighted**, plus confidence, method, and who approved it.
6. From there: *Send reminder* / *Assign to accountant* / *Add note*.

**Acceptance (AT-DASH-1):** for **every** metric on **every** dashboard, the sum of the drill-down list equals the displayed value **to the paisa**. Automated, run in CI against the seeded demo company. This is the single most important test in the product.

---

## J7 — Lender or auditor request *(owner → external, occasional)*

1. Owner selects the period and the document set.
2. Engine runs a **completeness check against the lender's checklist and lists what is missing before generating anything.**
3. Pack assembles: financials, schedules, bank statements, supporting invoices, reconciliations — indexed and cross-referenced.
4. A scoped, watermarked, **expiring** access link is issued to the external party.
5. Every access is written to the audit log; the owner can revoke at any time.

**Acceptance:** an external user cannot reach a single record outside the granted scope. One integration test per table asserts zero cross-scope rows.
