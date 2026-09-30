# 03 — Owner Dashboard Specification

*Deliverable D. Build-ready. Your 12 dashboard priorities (PDF p.28–29) and the 6-card + "Needs attention" layout (PDF p.29–30, and your design image) are **[CONFIRMED]** and are preserved exactly. What I have added is the information hierarchy, the formulas, the status model and the trace contract.*

---

## 1. The organising principle

You wrote: *"Determine the right hierarchy and information architecture, not just a random collection of KPI cards"*, and *"Clearly separate real-time operational / provisional MTD / finalized results / deadlines and exceptions."* **[CONFIRMED]**

So the dashboard is **not a grid**. It is four bands, in this order, answering four questions in the order an owner actually asks them:

| Band | Question | Nature | Refresh |
|---|---|---|---|
| **0 · Trust ribbon** | *Can I believe this screen right now?* | System state | Continuous |
| **A · MONEY NOW** | *Am I fine today?* | Operational fact | Daily / near-real-time |
| **B · WHO OWES / WHAT'S OWED** | *What's coming in and going out?* | Operational fact | Daily |
| **C · PERFORMANCE** | *Did I make money?* | **Provisional** until close, then **Finalised** | Monthly |
| **D · OBLIGATIONS & ATTENTION** | *What needs me?* | Deadlines + exceptions | Continuous |

An owner who reads only Band 0 and Band A in 20 seconds has got what they came for. Bands C and D are the reason they come back.

**Rendering rule that makes the separation visible:** Band A and B values render in **plain white numerals**. Band C values render with a **PROVISIONAL** pill until the period closes, at which point the pill becomes **FINAL** and the value switches typeface weight. An owner must be able to tell fact from estimate without reading a word.

---

## 2. The trust ribbon (Band 0) — this is what makes the product trustworthy

A single line above everything:

```
Books current to 28 Sep · 3 of 4 sources fresh · 14 items need you · Sep period OPEN
```

| Element | Definition |
|---|---|
| **Books current to** | `MIN(latest reconciled date across: bank, sales, purchase)`. If bank is reconciled to 28 Sep but purchases only to 21 Sep, this says **21 Sep**. The weakest link governs. |
| **Sources fresh** | Count of connected sources whose `last_successful_sync` is within their freshness SLA |
| **Items need you** | Open exceptions assigned to or visible to this user |
| **Period status** | `OPEN` / `CLOSING` / `CLOSED` / `LOCKED` for the current accounting period |

Clicking any element opens the relevant workspace. If **Books current to** is more than 3 days behind today, the ribbon turns amber; more than 7 days, red — and every Band C metric is downgraded to `INCOMPLETE`.

---

## 3. Metric registry

Every metric below is defined **once**, in code, in a registry. The dashboard, Excel exports, PDFs and the API all render from the same definition. There is no second place where EBITDA is calculated. **This is the single defence against the most common failure in finance products: the same metric showing two values on two screens.**

### Registry record shape

```jsonc
{
  "id": "AVAILABLE_CASH",
  "display_name": "Available cash",
  "band": "A",
  "priority": 1,                          // from your PDF p.28
  "unit": "INR",
  "formula_human": "Sum of reconciled closing balances of all active bank and cash accounts",
  "formula_ref": "engines.cash.available_cash",   // the one implementation
  "source_datasets": ["bank_accounts", "bank_statement_lines", "cash_book", "reconciliation_matches"],
  "refresh": "on_bank_sync | max 24h",
  "as_of_rule": "latest_reconciled_date",
  "status_rules": { /* see §4 */ },
  "drilldown": "/process/reconciliation?view=cash_by_account",
  "alerts": [ { "id": "CASH_BELOW_OBLIGATIONS", "…": "…" } ],
  "provisional": false
}
```

---

## 4. Status model — the honesty mechanism

Every metric renders with exactly one status. **[CONFIRMED requirement: "confidence/data completeness status"]**

| Status | Badge | Meaning | Rule |
|---|---|---|---|
| **VERIFIED** | green dot | Every feeder dataset reconciled through `as_of`; period closed where relevant | `open_exceptions == 0 AND sources_fresh == all AND (period_closed OR metric.band in [A,B])` |
| **PROVISIONAL** | amber pill, label `PROVISIONAL` | Computed from posted entries, but the period is not closed / adjustments pending | `period_status != CLOSED` for a Band C metric |
| **INCOMPLETE** | amber pill + count | Open exceptions in a feeder dataset material enough to move this number | `open_exceptions > 0` where those exceptions feed this metric |
| **STALE** | grey, value dimmed | A feeder source has not synced within its SLA | `now - min(source.last_sync) > source.sla` |

**Rules that are not negotiable:**
- An `INCOMPLETE` metric **must** state the impact bound: *"₹2.4L in 5 unmatched receipts could move this."* A badge without a number is decoration.
- **Gross profit, EBITDA and net profit are `PROVISIONAL` until the period is closed.** Your PDF says this explicitly (p.30) and it is the difference between a trustworthy product and a misleading one.
- A metric never silently degrades. Status change is an event, and the owner sees it.

---

## 5. The twelve metrics — full specification

*Columns: formula · source datasets · refresh · drill-down · alert. Priority numbers are yours (PDF p.28–29).*

### BAND A — MONEY NOW

#### A1 · `AVAILABLE_CASH` — "Available cash" *(your priority 1)*
- **Formula:** `Σ reconciled_closing_balance(account) for account in active bank + cash accounts`
- **Sources:** `bank_accounts`, `bank_statement_lines`, `cash_book`, `reconciliation_matches`
- **Refresh:** on bank sync, max 24h · **As-of:** latest reconciled date
- **Sub-caption:** `Reconciled` **[CONFIRMED — from your design image]**
- **Drill-down:** account-wise balances → statement lines → matched invoices → source document
- **Alert `CASH_BELOW_OBLIGATIONS`:** fires when `AVAILABLE_CASH < PAYABLES_DUE_7D`. Severity **critical**. Message names the shortfall and the largest obligation.
- **Status:** `INCOMPLETE` if any account has unmatched lines; caption becomes `Reconciled · ₹X unmatched`

#### A2 · `CASH_IN_TODAY` / `CASH_IN_MTD`, `CASH_OUT_TODAY` / `CASH_OUT_MTD` *(priority 2)*
- **Formula:** `Σ credits` / `Σ debits` of reconciled bank+cash movements in the window, **excluding internal transfers** (inter-account transfers are netted out — a common and embarrassing bug)
- **Sources:** `bank_statement_lines`, `cash_book`, `transfer_pairs`
- **Refresh:** daily · **Drill-down:** movement list by counterparty → document
- **Alert `UNUSUAL_OUTFLOW`:** single debit > 2× the trailing-90-day daily-debit mean **and** > a configurable floor

#### A3 · `NET_CASH_FLOW` — "Net cash flow" *(priority 2)*
- **Formula:** `CASH_IN(period) − CASH_OUT(period)`, internal transfers excluded
- **Sub-caption:** `This month` **[CONFIRMED — design image]** · rendered with explicit `+` / `−` sign
- **Refresh:** daily · **Drill-down:** daily cash movement chart → day → transactions

#### A4 · `CASH_FORECAST_7D` / `CASH_FORECAST_30D` *(priority 9)*
- **Formula:**
  `opening = AVAILABLE_CASH`
  `+ confirmed_receipts` (dated, agreed)
  `+ expected_receipts` = `Σ open_invoice × P(collect within window)` where `P` is derived from **that customer's** trailing-12-month payment behaviour
  `− committed_payments` (approved bills, salaries, EMIs, statutory dues with known dates)
  `− recurring_outflows` (rolling 3-month mean of regular costs)
- **Render:** a **range**, never a point. `₹18L – ₹26L` with `Confidence: Medium` and an expandable assumption list.
- **Refresh:** daily · **Drill-down:** the forecast ledger, line by line, each line editable by the finance team
- **Alert `PROJECTED_SHORTFALL`:** low end of the range < 0 on any day in the window. Severity **critical**; names the date and the amount.

### BAND B — WHO OWES / WHAT'S OWED

#### B1 · `RECEIVABLES_TOTAL` + `RECEIVABLES_OVERDUE` — "Customer dues" *(priority 3)*
- **Formula:** `Σ (invoice_total − payments_allocated − credit_notes_allocated)` over open sales invoices
  `OVERDUE = same, where today > invoice_date + payment_terms_days`
- **Sources:** `sales_invoices`, `payments`, `credit_notes`, `customers`, `payment_terms`
- **Sub-caption:** `₹4L overdue` **[CONFIRMED — design image]**
- **Ageing buckets:** `0–30 / 31–60 / 61–90 / 90+` — the 90+ bucket is always shown even when zero
- **Refresh:** daily · **Drill-down:** customer → invoice → payments → source PDF
- **Alerts:** `OVERDUE_CROSSED_90D` (per customer, amount above floor); `CONCENTRATION_RISK` (one customer > 25% of receivables)

#### B2 · `PAYABLES_TOTAL` + `PAYABLES_DUE_7D` — "Payments due" *(priority 4)*
- **Formula:** `Σ (bill_total − payments_made − debit_notes)` over open purchase bills, **plus** salary obligations, loan EMIs and statutory dues falling in the window
- **Sub-caption:** `Next 7 days` **[CONFIRMED — design image]**
- **Refresh:** daily · **Drill-down:** supplier → bill → three-way-match status → source PDF
- **Alert `PAYABLE_OVERDUE`:** past due date; **`INSUFFICIENT_CASH_FOR_PAYABLES`** cross-checks against A1

### BAND C — PERFORMANCE *(all `PROVISIONAL` until period close)*

#### C1 · `SALES_TODAY` / `SALES_MTD` — "Sales MTD" *(priority 5)*
- **Formula:** `Σ taxable_value of sales invoices with invoice_date in period − credit_notes in period`.
  **Net of GST** — the dashboard shows revenue, not collections and not gross-of-tax billing. This must be stated in the tooltip, because it is the most commonly misread figure on any Indian dashboard.
- **Sub-caption:** `Month to date` **[CONFIRMED — design image]**
- **Refresh:** daily · **Drill-down:** invoice list → customer → item → PDF
- **Alert `SALES_PACE_BELOW_TARGET`:** MTD run-rate projects < 85% of budget with ≥ 7 days elapsed

#### C2 · `GROSS_PROFIT` + `GROSS_MARGIN_PCT` *(priority 6)*
- **Formula:** `SALES_NET − COGS`, where `COGS = opening_stock + purchases + direct_costs − closing_stock`
  `margin% = GROSS_PROFIT / SALES_NET × 100`
- **Refresh:** monthly (daily provisional where inventory is tracked perpetually)
- **Status:** `PROVISIONAL` until close. `INCOMPLETE` if closing stock is not valued — and the card says so: *"Closing stock not valued — margin unreliable."*
- **Drill-down:** P&L → COGS components → purchase register → bills

#### C3 · `EBITDA` + `EBITDA_MARGIN_PCT` — "EBITDA" *(priority 7)*
- **Formula:** `GROSS_PROFIT − operating_expenses` where operating expenses **exclude** interest, tax, depreciation and amortisation
- **Sub-caption:** `Provisional MTD` **[CONFIRMED — design image]**
- **The formula is shown on the card's back face.** Every finance team defines EBITDA slightly differently; making ours visible is what stops arguments.
- **Refresh:** monthly · **Drill-down:** P&L → expense heads → GL → source

#### C4 · `NET_PROFIT` + `NET_MARGIN_PCT` *(priority 8)*
- **Formula:** `EBITDA − depreciation − amortisation − interest − tax_expense ± other income/expense`
- **Status:** `PROVISIONAL` until close **always** — depreciation and tax are period-end computations
- **Refresh:** monthly · **Drill-down:** full P&L

#### C5 · `BUDGET_VARIANCE` *(priority 11)*
- **Formula:** per line: `actual − budget`; `variance% = (actual − budget)/budget × 100`
- **Render:** the **three largest absolute variances by ₹**, not a full table. Each names its driver.
- **Refresh:** monthly · **Alert `BUDGET_BREACH`:** any expense head > 110% of budget with ≥ 50% of period elapsed

### BAND D — OBLIGATIONS & ATTENTION

#### D1 · `GST_PAYABLE`, `ITC_AVAILABLE`, `TDS_PAYABLE`, `NEXT_TAX_DEADLINE` *(priority 10)*
- **Formula:** from Module 2. `GST_PAYABLE = output_tax − eligible_ITC`
- **Render:** amount **+ the deadline date + days remaining**. A tax number without its deadline is useless to an owner.
- **Status:** always `DRAFT — requires CA review` until a CA records approval
- **Refresh:** as applicable (monthly/quarterly per registration)
- **Alerts:** `TAX_DEADLINE_APPROACHING` at T-7/T-3/T-1; `ITC_MISMATCH_MATERIAL` when unreconciled ITC exceeds a floor

#### D2 · `NEEDS_ATTENTION` — the attention queue *(priority 12)* **[CONFIRMED — design image]**

```
Needs attention
  3   Overdue customer payments
  5   Unmatched transactions
  2   Upcoming tax tasks
```

- **Sources:** `exceptions`, `review_queue`, `compliance_calendar`, `missing_documents`
- **Refresh:** continuous
- **Ordering:** by `severity DESC, ₹ impact DESC, age DESC` — **never** by count
- **Cap:** 5 rows on the owner dashboard. The 6th row is *"and 11 more"* linking to the full queue. An owner facing 40 rows reads none.
- Each row: count, plain-language label, total ₹ at stake, and a one-click route into the exact queue filtered to those items.

---

## 6. The trace contract — "every number must have its source" **[CONFIRMED]**

Every metric the API returns carries this envelope. This is not optional metadata; the UI refuses to render a value without it.

```jsonc
{
  "metric_id": "RECEIVABLES_OVERDUE",
  "value": 412500.00,                       // NUMERIC(18,2) — never float
  "currency": "INR",
  "display": "₹4.13L",
  "as_of": "2026-09-28T18:30:00+05:30",
  "computed_at": "2026-09-29T06:15:02+05:30",
  "status": "INCOMPLETE",
  "status_reason": "5 bank receipts totalling ₹2.4L are unmatched and may reduce this figure",
  "period": { "from": "2026-09-01", "to": "2026-09-30", "state": "OPEN" },
  "formula_human": "Sum of unpaid sales invoices where today > due date",
  "formula_version": "receivables@1.3.0",
  "rule_set_version": "2026-04-01",
  "source_datasets": ["sales_invoices", "payments", "credit_notes", "payment_terms"],
  "contributing_txn_count": 37,
  "drilldown_url": "/process/receivables?bucket=overdue&as_of=2026-09-28",
  "evidence_sample": [
    { "txn_id": "…", "document_id": "…", "page": 1, "bbox": [120, 340, 460, 372] }
  ]
}
```

**The drill-down chain is fixed and must work at every level:**

```
Dashboard number
   → contributing transactions (filtered list, sums to the number to the paisa)
      → single transaction (with its journal entry, Dr/Cr)
         → source document (rendered PDF/image)
            → the highlighted region the field was extracted from
               → extraction confidence, method, and who approved it
```

**Acceptance test for the whole dashboard:** pick any number on any screen. Click through to the transaction list. `SUM(list) == displayed value` exactly, to the paisa. If it does not, the screen is broken. This test runs in CI against the seeded demo company.

---

## 7. Layout (desktop) — following your design image exactly

```
┌─────────────────────────────────────────────────────────────────┐
│ ◉ SherrByte    [  ⌕ command bar …                             ] │   top chrome
├─────────────────────────────────────────────────────────────────┤
│                          ( ◎ )                                   │   page glyph
│  Owner dashboard                                                 │
│  Books current to 28 Sep · 3/4 sources fresh · 14 need you       │   BAND 0
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │ Available cash       │  │ Sales MTD            │             │   BAND A/C
│  │ ₹24.5L               │  │ ₹48L                 │             │
│  │ Reconciled           │  │ Month to date        │             │
│  └──────────────────────┘  └──────────────────────┘             │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │ Customer dues        │  │ Payments due         │             │   BAND B
│  │ ₹14L                 │  │ ₹6.2L                │             │
│  │ ₹4L overdue          │  │ Next 7 days          │             │
│  └──────────────────────┘  └──────────────────────┘             │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │ Net cash flow        │  │ EBITDA  [PROVISIONAL]│             │   BAND A/C
│  │ +₹3.1L               │  │ ₹9L                  │             │
│  │ This month           │  │ Provisional MTD      │             │
│  └──────────────────────┘  └──────────────────────┘             │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Needs attention                                            │ │   BAND D
│  │  3  Overdue customer payments              ₹4.0L          │ │
│  │  5  Unmatched transactions                 ₹2.4L          │ │
│  │  2  Upcoming tax tasks              GSTR-3B in 5 days     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│              [ Dashboard │ People │ Data ]                       │   bottom dock
└─────────────────────────────────────────────────────────────────┘
```

Card anatomy follows your image precisely: rounded light surface, a header strip separated by a hairline divider, label in sentence case, the value in a large light-weight numeral, and a caption below. The status pill sits in the header strip so it never competes with the number.

**Mobile:** single column, Band 0 pinned, Bands A–B first, Band C collapsed behind a "Performance" disclosure, Band D pinned above the dock.

---

## 8. Role variants of this screen **[CONFIRMED requirement]**

| Role | Lands on | Bands shown | Notably different |
|---|---|---|---|
| **Owner** | Owner Dashboard | 0, A, B, C, D | The spec above. Read-first, minimal actions. |
| **Accountant** | Work Queue | 0, D, then queue | Cards replaced by *counts of work*: inbox, unmatched, exceptions, missing docs. Keyboard-driven. |
| **Finance manager** | Cash & Performance | 0, A, C, D + forecast | Forecast and budget variance are the primary surface, not a card. |
| **CA reviewer** | Client Review Board | One row per client | Readiness %, open exceptions, what's awaiting their approval, close status. Cross-client. |
| **Auditor / lender** | Evidence Package | none | Only the granted scope. No dashboard at all. |
