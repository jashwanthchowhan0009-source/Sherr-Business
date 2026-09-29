# 05 — Page Structure & Navigation

*Deliverable E. Built directly on the navigation model in your images: two sides, a three-segment dock on each, and Input / Process / Output as the workspace spine. **[CONFIRMED]***

---

## 1. The navigation model

```
                      ┌─────────────────────────────┐
                      │   ◉      [ command bar ]    │
                      └─────────────────────────────┘

        ◀─────────────── side toggle ( ● ○ ) ───────────────▶

   WORKSPACE side (left)                    COMPANY side (right)
   the work itself                          who, what, and how it's set up

   [ Input │ Process │ Output ]             [ Dashboard │ People │ Data ]
```

This is exactly your two design screens. The dock changes with the side; the command bar and brand mark never move.

**Why this works, stated plainly so it survives future redesigns:** the workspace side is the *pipeline* — data comes in, gets worked, comes out. The company side is the *context* — the numbers, the people, the connections. A user is always in one of those two modes.

---

## 2. Route map

### WORKSPACE › INPUT — *COLLECT + EXTRACT*

| Route | Screen | Purpose |
|---|---|---|
| `/input` | **Upload & capture** | Your reference screen: drop panel, "Enter your input type…", type chips (Sales invoices, Credit Notes, Purchase bills, PO's, Bank statements, cashbook, Customer and supplier ledgers, Expenses, Assets, Inventory, Payroll) |
| `/input/inbox` | **AI Document Inbox** *(required screen #8)* | The extraction queue. Doc preview left, extracted fields right, confidence per field, ✓ confirm / ✎ correct / ⊘ reject. Keyboard-driven, "next" flow. **The accountant's most-used screen in the product.** |
| `/input/sources` | **Data sources & integrations** *(#7)* | Tally connector, Zoho Books, bank feeds/statements, GSTN, email-in address, Google Drive/folder watch. Each row: status, last successful sync, record counts, next sync, freshness SLA, and errors in plain language. |
| `/input/sources/:id` | Source detail | Sync history, field mapping, chart-of-accounts mapping, re-sync, disconnect |
| `/input/missing` | **Missing documents** | What the system knows should exist but doesn't (bill referenced by a payment; challan without an invoice). With chase actions. |

### WORKSPACE › PROCESS — *NORMALIZE → CONNECT → VALIDATE → RECONCILE → CALCULATE*

| Route | Screen | Purpose |
|---|---|---|
| `/process` | **Process overview** | The pipeline as a live diagram: how many items at each stage, where the blockage is |
| `/process/review` | **Reconciliation & exception review** *(#9)* | The exception queue. Grouped by type: duplicates, unmatched bank lines, three-way-match failures, price variances, missing fields, ITC mismatches. Each with evidence side-by-side and resolve / reassign / waive-with-reason. |
| `/process/bank` | **Bank reconciliation** | Statement lines ⇄ invoices/bills. Engine-proposed matches with confidence; drag to match; split and part-payment handling; TDS residual handling. |
| `/process/match` | **Three-way match** | PO ⇄ Invoice ⇄ Challan, quantity and rate tolerances |
| `/process/ledger` | **Ledger & journal** | General ledger, journal, trial balance. Read-heavy, export-heavy. |
| `/process/close` | **Period close** | The checklist and its gates. A period cannot close with an unresolved blocking gate. Closing locks the period and notifies the CA. |

### WORKSPACE › OUTPUT — *ANALYZE → REVIEW → DISTRIBUTE*

Your image shows this as a **folder grid** — `Accounts · Taxation · Financial reports · Documentation`, with empty slots. Those slots are filled as below.

| Route | Folder | Contains |
|---|---|---|
| `/output/accounts` | **Accounts** *(#2 Accounting workspace)* | Sales register, purchase register, general ledger, journal, trial balance, receivables, payables, ageing, bank recon, discrepancy report |
| `/output/taxation` | **Taxation** *(#3)* | GST liability, ITC & eligibility, GSTR-2B reconciliation, TDS workings, draft return data, tax calendar, payment status |
| `/output/financials` | **Financial reports** *(#4)* | P&L, Balance Sheet, Cash Flow, working capital, depreciation / loan / inventory schedules, budget vs actual, ratios |
| `/output/analysis` | **Profit & business analysis** *(#5)* | Revenue & growth, GP/EBITDA/net margins, product · customer · branch profitability, expense trends, cash-flow forecast, evidence-linked alerts |
| `/output/documentation` | **Documentation** *(#6)* | Monthly management report, CA working papers, reconciliation reports, loan support pack, audit evidence pack, customer/supplier statements, document register |
| `/output/exports` | **Exports & API** | Export history, scheduled exports, Tally/ERP push, API keys and webhooks |

Every folder screen follows one pattern: a report list on the left, the selected report rendered on the right, with `Period` · `Status` · `Export ▾` in the header. No report is ever produced without its period status and as-of stamp.

### COMPANY › DASHBOARD

| Route | Screen |
|---|---|
| `/dashboard` | **Owner dashboard** *(#1)* — fully specified in `docs/03-OWNER-DASHBOARD-SPEC.md` |
| `/dashboard/queue` | **Accountant work queue** — the accountant's landing screen |
| `/dashboard/cash` | **Cash & forecast** — the finance manager's landing screen |
| `/dashboard/clients` | **CA client review board** — one row per client, cross-company |

### COMPANY › PEOPLE

| Route | Screen |
|---|---|
| `/people` | Members, roles, invitations |
| `/people/roles` | **Permissions matrix** *(#10)* — role × capability grid, editable |
| `/people/ca` | External CA / auditor access — scoped, expiring, per-engagement |
| `/people/approvals` | Approval routing: what needs whose sign-off, and thresholds |

### COMPANY › DATA

| Route | Screen |
|---|---|
| `/data` | **Company settings** *(#10)* — legal entity, GSTIN(s), PAN, FY, address, branches |
| `/data/coa` | Chart of accounts and the mapping rules that route transactions to it |
| `/data/masters` | Customers, suppliers, items, payment terms, tax rates |
| `/data/rules` | **Rule versions** — accounting and tax rule sets, with effective dates and change history |
| `/data/audit` | **Audit history** *(#10)* — immutable log: who saw what, who approved what, who changed what, and the before/after |
| `/data/documents` | Document vault — every original file, searchable, with retention policy |
| `/data/companies` | Company switcher (multi-entity / multi-client) |

---

## 3. Coverage check against your ten required screens

| # | Your required screen | Route |
|---|---|---|
| 1 | Owner overview dashboard | `/dashboard` |
| 2 | Accounting workspace | `/output/accounts` + `/process/*` |
| 3 | Taxation workspace | `/output/taxation` |
| 4 | Financial reporting workspace | `/output/financials` |
| 5 | Profit & business intelligence | `/output/analysis` |
| 6 | Documentation & report center | `/output/documentation` |
| 7 | Data sources & integrations | `/input/sources` |
| 8 | AI document inbox | `/input/inbox` |
| 9 | Reconciliation & exception review | `/process/review` (+ `/process/bank`, `/process/match`) |
| 10 | Settings, permissions, audit history | `/data`, `/people/roles`, `/data/audit` |

All ten are placed. None is orphaned.

---

## 4. Landing route by role

| Role | Lands on | Dock defaults to |
|---|---|---|
| Owner | `/dashboard` | Company side |
| Accountant / finance executive | `/dashboard/queue` | Workspace side, **Input** |
| Finance manager | `/dashboard/cash` | Company side |
| CA reviewer | `/dashboard/clients` | Company side |
| Auditor / lender | `/output/documentation` (scoped) | — (dock hidden) |

---

## 5. Cross-cutting surfaces

These are not routes; they open over whatever you are looking at.

| Surface | Trigger | Contents |
|---|---|---|
| **Trace sheet** | Click any number, anywhere | Formula, as-of, status + reason, source datasets, contributing transactions, document viewer with the extracted region highlighted |
| **Command bar** | `⌘K` | Navigate, search documents/customers/invoices, run an action ("upload", "close September", "export GST workings") |
| **Notification centre** | Bell / push | Overdue payments, missing documents, unusual changes, approaching deadlines. Grouped, never one-per-event. |
| **Company switcher** | Brand mark | For multi-entity owners and CA firms |
| **Period selector** | Header of any output screen | Changing it re-renders with the new period's status; it never silently mixes periods |
