# 02 — Input → Process → Output Matrix (all five modules)

*Deliverable C. Your table from PDF p.30–34 is **[CONFIRMED]** and is the spine of this document. I have added four columns it needs before anyone can build from it: **who executes each step** (AI / deterministic engine / human), **the trigger**, **the failure mode**, and **the acceptance test**.*

## How to read the Executor column — this is the most important column in the document

| Code | Meaning | May it decide a number? |
|---|---|---|
| **AI** | LLM/OCR extraction, classification, drafting, explanation | **No, never** |
| **ENG** | Deterministic engine: pure function, versioned rules, unit-tested, reproducible | **Yes — only ENG produces numbers** |
| **HUM** | Human review, approval, professional judgement | Yes, and it is recorded as a decision with an actor and timestamp |

A row where AI feeds ENG without a HUM gate is only allowed when extraction confidence clears the auto-post threshold **and** the entry passes all validation rules. Everything else queues. See `docs/06-ARCHITECTURE.md §5.3`.

---

## Module 1 — ACCOUNTING

| # | Input datasets | Process (executor) | Output datasets | Format | Failure mode to design for | Acceptance test |
|---|---|---|---|---|---|---|
| 1.1 | Sales invoices, credit notes (PDF/image/e-invoice JSON/Tally export) | Classify doc type **(AI)** → extract fields **(AI)** → schema+arithmetic validation **(ENG)** → duplicate detection **(ENG)** → customer resolution **(ENG+AI)** → ledger mapping **(ENG)** → post or queue **(HUM)** | Sales register, sales totals by period/customer/item, customer balances | Dashboard, Excel, CSV | Same invoice arrives twice (email + Tally sync) with different file hashes | Re-upload the same invoice in 3 formats → exactly 1 transaction, 2 suppressed as duplicates with the rule named |
| 1.2 | Purchase bills, POs, delivery challans | Extract **(AI)** → **three-way match** PO↔Invoice↔Challan on qty/rate within tolerance **(ENG)** → price-variance check vs PO **(ENG)** → duplicate check **(ENG)** → exception or post **(HUM)** | Purchase register, three-way-match status, discrepancy list | Dashboard, Excel | Partial delivery against one PO; invoice qty ≠ challan qty | PO 100 units → challan 60 → invoice 100 ⇒ exception `QTY_MISMATCH` with all three docs linked |
| 1.3 | Bank statements (PDF/CSV/Excel), cashbook, receipts | Parse statement **(ENG+AI)** → normalise **(ENG)** → match receipts/payments to invoices/bills incl. part-payments, netting, bank charges, UTR matching **(ENG)** → suggest for ambiguous **(AI)** → confirm **(HUM)** | Bank reconciliation, cash & bank balance, unmatched entries | Dashboard, Excel, PDF | One NEFT settles 7 invoices; TDS deducted by customer so receipt ≠ invoice | ₹4,92,000 receipt vs 5 invoices totalling ₹5,00,000 ⇒ engine proposes the set + ₹8,000 TDS residual, not "unmatched" |
| 1.4 | Customer & supplier ledgers (Tally/Zoho export, opening balances) | Import & reconcile against our derived balances **(ENG)** → age open items **(ENG)** → compute overdue by terms **(ENG)** → flag divergence **(ENG)** | Receivables, payables, overdue dues, ageing buckets (0-30/31-60/61-90/90+) | Dashboard, Excel, PDF | Our receivable ≠ Tally receivable | Import Tally ledger → any divergence > ₹1 is itemised to the transaction, never silently absorbed |
| 1.5 | Expenses, payroll, inventory, fixed assets | Categorise **(AI proposes, ENG applies mapping rules)** → post approved entries **(ENG)** → double-entry validation Dr=Cr **(ENG)** → reconcile control accounts **(ENG)** | General ledger, journal, trial balance | Excel, CSV, PDF | A mis-mapped expense silently distorts the P&L | Trial balance must balance to ₹0.00 or posting is rejected — hard invariant, enforced in the DB |

**Module 1 outputs also required [CONFIRMED]:** missing bills list, unmatched transactions, discrepancy report.

---

## Module 2 — TAXATION

> **Gate:** no taxation output may be produced from unverified accounting data. Module 2 reads only posted, reconciled records. **[CONFIRMED]**

| # | Input datasets | Process (executor) | Output datasets | Format | Failure mode | Acceptance test |
|---|---|---|---|---|---|---|
| 2.1 | Sales/purchase registers, GST invoices, HSN/SAC, place of supply, GSTIN records | Determine applicable rule version by date **(ENG)** → CGST/SGST/IGST split by place of supply **(ENG)** → rate application **(ENG)** → RCM identification **(ENG)** → liability computation **(ENG)** → review **(HUM: CA)** | GST payable, output tax by head, draft return data | Dashboard, Excel, supported filing format | Inter- vs intra-state misclassified ⇒ entire split wrong | Karnataka seller → Tamil Nadu buyer ⇒ IGST; same-state ⇒ CGST+SGST. Both cases unit-tested per rule version |
| 2.2 | GSTR-2B, purchase register | Match on GSTIN + invoice no + date + taxable value with fuzzy fallback **(ENG, AI only for candidate suggestion)** → classify: matched / in-2B-not-in-books / in-books-not-in-2B / value mismatch **(ENG)** → eligibility check **(ENG)** → resolve **(HUM)** | Available ITC, potentially ineligible ITC, ITC mismatch list | Dashboard, Excel | Vendor filed late — invoice absent from this month's 2B | Invoice absent from 2B ⇒ classified `ITC_DEFERRED` with vendor + amount + follow-up, **not** silently claimed |
| 2.3 | Vendor PAN, expenses, payroll, payments | Section determination (194C/194J/194H/194I/192 …) **(ENG)** → threshold tracking cumulative per PAN per FY **(ENG)** → rate incl. higher rate for invalid PAN **(ENG)** → compute & reconcile to challans **(ENG)** → review **(HUM)** | TDS payable by section, deductions register, draft 26Q/24Q data | Dashboard, Excel, PDF | Threshold crossed mid-year retrospectively triggers deduction on earlier payments | Contractor crosses ₹1,00,000 aggregate in month 7 ⇒ engine flags the earlier under-deduction with the amount |
| 2.4 | Registrations, filing history, tax payments, official rule set | Determine applicability **(ENG)** → build calendar **(ENG)** → match payments to liabilities **(ENG)** → detect missing filings **(ENG)** → alert **(ENG)** | Tax calendar, payment status, missing filings, filing reminders | Dashboard, notifications | Deadline moves by notification | Rule versions are dated records; recomputing a past period uses the rule in force *then*, not today's |

**Hard rule [CONFIRMED]:** an AI-generated estimate is never a legally approved filing. Every taxation output carries `DRAFT — requires CA review` until a CA role records an approval decision.

---

## Module 3 — FINANCIAL REPORTING

> **Gate:** runs only against a period that has passed the close checklist, or is explicitly labelled `PROVISIONAL`.

| # | Input datasets | Process (executor) | Output datasets | Format | Failure mode | Acceptance test |
|---|---|---|---|---|---|---|
| 3.1 | Verified GL, trial balance, approved adjustments | Period-close gate check **(ENG)** → revenue/expense classification via mapping **(ENG)** → apply approved adjustments **(HUM approves, ENG applies)** → compute **(ENG)** | Profit & Loss statement | Dashboard, Excel, PDF | Statement generated on an open period and read as final | Any statement from an unclosed period is watermarked `PROVISIONAL` in **all** formats incl. PDF |
| 3.2 | Assets, liabilities, equity, closing balances | Balance validation Assets = Liabilities + Equity **(ENG)** → schedule assembly **(ENG)** | Balance Sheet | Dashboard, Excel, PDF | Suspense account hides an imbalance | Balance Sheet that does not balance is **not rendered**; the imbalance is reported instead |
| 3.3 | Bank records, GL, cash transactions | Classify operating/investing/financing **(ENG)** → indirect-method construction **(ENG)** → tie closing cash to bank recon **(ENG)** | Cash-flow statement | Dashboard, Excel, PDF | Closing cash ≠ reconciled bank balance | Closing cash in CFS must equal Module 1.3 reconciled balance exactly, or the statement is blocked |
| 3.4 | Loans, inventory, fixed assets | Depreciation per method & rate set **(ENG)** → loan amortisation **(ENG)** → inventory valuation per policy **(ENG)** | Depreciation, loan repayment, inventory schedules | Excel, PDF | Depreciation method/rate changed mid-year without trail | Changing a depreciation policy creates a versioned record and does not retroactively alter closed periods |
| 3.5 | Budgets, prior-period statements | Compare actual vs budget vs prior **(ENG)** → variance decomposition **(ENG)** → explain drivers **(AI, labelled as interpretation)** | Budget variance, period comparison, working capital, ratios | Dashboard, Excel, PDF | AI narrative presented as fact | Every AI sentence is visually and structurally separated from computed figures |

---

## Module 4 — PROFIT & BUSINESS ANALYSIS

> **Gate:** reads verified statements only. Must visibly distinguish **observed fact** from **estimate** from **forecast**. **[CONFIRMED]**

| # | Input datasets | Process (executor) | Output datasets | Format | Failure mode | Acceptance test |
|---|---|---|---|---|---|---|
| 4.1 | Verified sales, costs, P&L | Revenue by period/segment **(ENG)** → growth MoM/YoY **(ENG)** → trend **(ENG)** | Revenue, growth, sales trends | Dashboard, charts, Excel | A one-off sale read as a trend | Outliers > 2σ are marked, not smoothed away |
| 4.2 | Revenue, direct costs, operating expenses | Gross profit, EBITDA, operating profit, net profit + margins **(ENG)** | Profitability dashboard | Dashboard, Excel, PDF | EBITDA definition drifts between screens | **One** canonical formula per metric, defined once in the metric registry, rendered everywhere from it |
| 4.3 | Product / customer / branch sales & costs | Allocate directly traceable costs **(ENG)** → allocate shared costs by declared basis **(ENG)** → rank **(ENG)** | Product, customer, branch profitability | Dashboard, Excel | Arbitrary overhead allocation presented as truth | Every allocated cost shows its basis; unallocated overhead is shown as a separate line, never buried |
| 4.4 | Historical financials, budgets | Trend & variance analysis **(ENG)** → anomaly detection **(ENG)** → explanation **(AI, labelled)** | Expense trends, unusual cost changes, performance reports | Dashboard, charts, PDF | Alert fatigue | An alert fires only with a named driver and a ₹ impact above a configured floor |
| 4.5 | Receivables, payables, expected receipts/payments, recurring obligations | Model future cash: confirmed → expected (by customer payment behaviour) → recurring **(ENG)** | 7/30/90-day cash-flow forecast, shortage alerts | Dashboard, Excel | Forecast shown with false precision | Forecast renders as a **range** with a stated confidence and its assumptions listed |

---

## Module 5 — DOCUMENTATION

> **Gate:** assembles only approved data. Cannot pull from open periods without an explicit `PROVISIONAL` stamp.

| # | Input datasets | Process (executor) | Output datasets | Format | Failure mode | Acceptance test |
|---|---|---|---|---|---|---|
| 5.1 | Approved ledgers & statements | Template fill **(ENG)** → narrative **(AI, labelled)** → attach schedules **(ENG)** → approve **(HUM)** | Monthly management report | PDF, Excel | Stale figure in a distributed PDF | Every generated document embeds as-of timestamp, period status and a content hash |
| 5.2 | Verified accounting + tax data | Compile reconciliations, workings, tie-outs **(ENG)** → index **(ENG)** | CA-ready working papers | Excel, PDF | CA cannot trace a figure back | Every workpaper cell that is derived carries a reference to its source schedule |
| 5.3 | Approved financials, bank & loan records | Assemble requested set **(ENG)** → completeness check vs lender checklist **(ENG)** | Loan application support package | PDF, Excel | Missing document discovered by the bank | Package generation lists what is missing **before** producing the file |
| 5.4 | Invoices, contracts, transaction evidence | Group, index, cross-reference **(ENG)** → scope & expiry **(ENG)** | Audit evidence package | PDF, ZIP | Auditor receives out-of-scope data | Package is scoped, watermarked, expiring; every access logged |
| 5.5 | Company registrations, licences, contracts | Extract key fields & dates **(AI)** → validate **(HUM)** → monitor expiry **(ENG)** | Document register, renewal alerts | Dashboard, Excel, PDF | A licence lapses unnoticed | Alerts at T-90/T-30/T-7 days, escalating to the owner |

---

## How the five modules connect **[CONFIRMED — PDF p.34–35]**

```
     Tally / Zoho / ERP · Excel · Bills · Bank · Payroll · Inventory · Tax portals
                                    │
                   ┌────────────────▼────────────────┐
                   │  COLLECT  →  EXTRACT            │  AI + validation
                   │  identify fields · dedupe       │  flag missing data
                   └────────────────┬────────────────┘
                   ┌────────────────▼────────────────┐
                   │  NORMALIZE → CONNECT → VALIDATE │  ACCOUNTING ENGINE
                   │  RECONCILE → CALCULATE          │  deterministic, versioned
                   └────────────────┬────────────────┘
                                    │  verified accounting records
        ┌───────────────┬───────────┼───────────────┬────────────────┐
        ▼               ▼           ▼               ▼                ▼
   2. TAXATION   3. FIN. REPORTS  4. PROFIT    5. DOCUMENTATION   (exceptions)
   GST · TDS     P&L · BS · CF    ANALYSIS     packs · workpapers  review queue
        └───────────────┴───────────┼───────────────┴────────────────┘
                                    ▼
              OWNER DASHBOARD  ·  DEPARTMENT REPORTS  ·  CA REVIEW
```

**The direction of this graph is a hard architectural rule.** Modules 2–5 read from the verified accounting layer. They never read raw documents directly, and they never write back into it. This is what makes "every number is traceable" achievable rather than aspirational.

## Output format rule **[CONFIRMED — PDF p.35]**

| Format | Use it for |
|---|---|
| **Dashboard** | Daily numbers, trends, overdue dues, alerts, upcoming tasks |
| **Excel** | Detailed transactions, reconciliations, calculations, editable working papers |
| **PDF** | Financial statements, management reports, reviewed tax reports, audit packages |
| **CSV / software export** | Moving structured data into Tally, ERP or filing software |
| **Notifications** | Overdue payments, missing documents, unusual changes, compliance deadlines |
