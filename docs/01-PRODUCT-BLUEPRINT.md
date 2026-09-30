# 01 — Product Blueprint

*Deliverables A, B and the competitive position. Everything marked **[CONFIRMED]** comes from your PDF or design images. Everything marked **[MY CALL]** is my recommendation and is yours to overrule.*

---

## A. What SherrByte Business is

> **SherrByte Business is a verification and preparation layer that sits on top of the accounting systems an Indian company already runs. It ingests the documents and feeds those systems never fully digest — bills, bank statements, POs, challans, GSTR-2B, payroll — reconciles them against the books, and produces numbers an owner can trust today and a CA can review and sign off on. Every number traces back to the document it came from.**

The one-line positioning: **Tally records. SherrByte verifies, reconciles and explains.**

### The exact problem

There are three separate pains, and they are usually described as one:

**1. The owner's number is 15–45 days old.**
An owner asks "how much cash do I have, and did I make money last month?" The honest answer in most Indian SMEs is "let me ask the accountant, he'll tell you after the 20th." Not because the data doesn't exist — it exists across Tally, the bank portal, a WhatsApp folder of bills and three Excel files — but because *nobody has reconciled it yet*. The owner runs the business on a mental estimate and the bank balance.

**2. The accountant's day is mechanical, not analytical.**
Keying purchase bills. Matching 400 bank lines to invoices. Chasing the 14 missing bills the vendor never sent. Comparing the purchase register to GSTR-2B line by line. Rebuilding the same workpaper pack every month. This is the majority of a finance executive's and a CA article's billable time, and essentially none of it requires judgement.

**3. No number can be defended.**
When a number is questioned — by the owner, the CA, a lender, an auditor — there is no path from "₹14L receivable" back to the 37 invoices that make it up, back to the PDFs. Reconstructing that takes hours. This is why month-end takes a week.

SherrByte attacks **the gap between "the data exists" and "the number is trustworthy."** That gap is where the manual work lives, and it is not owned by any existing product.

### What it is not

- **Not a replacement ledger.** We do not ask a company to leave Tally. We read from it and write back to it.
- **Not a filing utility.** We prepare return data and workpapers. An authorised human files.
- **Not a chatbot over financial data.** AI never produces a number. See `docs/06-ARCHITECTURE.md §5` — the AI/engine boundary is the single most important design rule in this product.

### The hard constraints this product must never break **[CONFIRMED]**

1. AI may extract, classify, interpret, summarise, explain and draft. **AI must never originate a transaction, balance, tax amount, or business claim.**
2. All accounting, financial-statement and tax arithmetic runs through **deterministic, versioned, unit-tested engines**.
3. Every derived number stores its **source, calculation definition, as-of time, completeness status and a click-through to underlying transactions and documents.**
4. Uncertain extractions go to a **human approval queue**, never straight to the ledger.
5. The product **never claims** to replace a qualified CA, to give a statutory audit opinion, or to guarantee tax compliance. Filing and professional judgement stay with authorised humans.
6. Multi-tenant isolation is absolute. One company's data must never reach another company — or the consumer SherrByte app's personalisation system.

---

## B. Primary users and their frequent workflows

Five roles, and they must **not** see the same screen. **[CONFIRMED — "Create different experiences for owner, accountant, CA reviewer and finance team"]**

### B1. Owner / Managing Director
*Opens the app for 90 seconds in the morning and 10 minutes on Saturday.*

| Frequency | Workflow | What "done" looks like |
|---|---|---|
| Daily, 90s | "Am I fine?" — cash, money in/out yesterday, anything urgent | Reads the top band of the Owner Dashboard, clears or delegates the attention queue |
| Weekly | "Who owes me and who am I paying?" | Reviews the ageing buckets, approves the payment run shortlist |
| Monthly | "Did I make money?" | Reads provisional P&L, then the finalised one after CA close |
| Ad hoc | "Why is this number what it is?" | Clicks any figure → sees the transactions → sees the source PDF |
| Monthly | "Are we on budget?" | Budget vs actual with variance drivers named |

**Design consequence:** the owner's home is *not* a report list. It is a four-band answer to "am I fine, who owes me, did I make money, what needs me." Everything else is one click deeper.

### B2. In-house accountant / finance executive
*The power user. Lives in the product 3–5 hours a day. If this role doesn't adopt, nothing else matters.*

| Frequency | Workflow | What "done" looks like |
|---|---|---|
| Daily | Clear the AI Document Inbox — confirm/correct extracted fields | Inbox at zero; every doc either posted or explicitly parked |
| Daily | Bank reconciliation — match statement lines to invoices/bills | Unmatched count at zero or explained |
| Daily | Exception queue — duplicates, price mismatches, missing bills | Each exception resolved, reassigned, or waived with a reason |
| Weekly | Chase missing documents (vendor bills, signed challans) | Missing-doc list shrinking; reminders sent |
| Monthly | Period close checklist | All gates green, period locked, CA notified |
| Monthly | GSTR-2B vs purchase register reconciliation | ITC mismatch list resolved or documented |

**Design consequence:** this role needs a **queue**, not a dashboard. Keyboard-first, bulk actions, "next item" flow, and never more than two clicks to the evidence.

### B3. Finance manager / CFO *(mid-size companies only)*

| Frequency | Workflow |
|---|---|
| Weekly | 30-day cash-flow forecast; flag shortfalls before they happen |
| Weekly | Approve payment run against available cash |
| Monthly | Budget vs actual, variance investigation, product/customer/branch profitability |
| Quarterly | Board pack from the Documentation module |

### B4. External CA firm — partner and article clerk
*Two distinct sub-roles. The article does preparation; the partner reviews and signs.*

| Frequency | Workflow (article) | Workflow (partner) |
|---|---|---|
| Monthly | Pull the client's workpaper pack; fix mapping errors | Review the exception summary, not the transactions |
| Monthly | GST workings + 2B reconciliation | Approve/reject the filing data with a recorded decision |
| Quarterly | TDS workings, 26Q/24Q prep | Sign off the review checklist |
| Annual | Financials + schedules + audit evidence pack | Review with full drill-down to source |

**Design consequence:** the CA's home is a **multi-client review board** — one row per client, showing readiness, open exceptions, and what's waiting on them. A CA firm serving 40 clients will not tolerate 40 logins.

### B5. Auditor / lender *(read-only, time-boxed)*
Receives a scoped, expiring, watermarked evidence package. Cannot see anything outside the scope granted. Every access is logged.

### Workflow frequency summary — where the engineering effort should go

| Workflow | Times/month/company | Manual hours saved (est.) | Priority |
|---|---|---|---|
| Document extraction → posting | 200–2,000 | 15–40 | **P0** |
| Bank reconciliation | 20–30 | 8–20 | **P0** |
| Invoice ↔ payment matching | daily | 6–12 | **P0** |
| Receivables/payables ageing | daily | 3–6 | **P0** |
| GSTR-2B ↔ purchase register | 1 | 4–10 | **P1** |
| Monthly workpaper pack | 1 | 6–15 | **P1** |
| P&L / Balance Sheet prep | 1 | 4–10 | **P1** |
| Cash-flow forecast | 4 | 2–4 | **P2** |
| Product/customer profitability | 1 | 3–8 | **P2** |

*Hours are my estimates for a 20–80 crore turnover business and need validation against two real clients before they appear in any pitch. See `docs/10-RISKS-AND-OPEN-QUESTIONS.md`.*

---

## Competitive positioning **[CONFIRMED — your own conclusion on p.37: "Don't build another Tally. Build something that eliminates manual work between existing systems."]**

| Product | Where it is genuinely strong | Where it leaves a gap |
|---|---|---|
| **TallyPrime** | The system of record for a large share of Indian SMEs. Inventory, GST, vouchers, CA familiarity. Desktop-first, deeply entrenched. | Data entry is still manual. No document AI. Owner visibility is poor — the owner does not open Tally. Remote/multi-user access is awkward. |
| **Zoho Books** | Best-in-class cloud accounting UX, 70+ reports, automation, good owner dashboards, strong API. | It wants to *be* your ledger. Migrating off Tally is the blocker. Weak on "reconcile documents that live outside the system." |
| **ClearTax** | GST filing and 2B reconciliation at scale; the default for compliance workflow. | Compliance-only. No general ledger, no owner P&L, no cash view, no document layer. |
| **BUSY** | Trading/distribution businesses, inventory + GST, strong in tier-2/3. | Same category as Tally — record-keeping, not verification. |

### Where SherrByte wins — the specific, defensible workflow

**Nobody owns the reconciliation layer *between* these systems.** A typical business runs Tally **and** ClearTax **and** three banks **and** a bill folder. The manual work is the stitching. Concretely, SherrByte's wedge is:

1. **Document-in, verified-entry-out.** Drop a bill folder → extracted, deduplicated, matched against PO and challan, exceptions raised, journal proposed, human approves, pushed to Tally. Nobody does this end-to-end with real accuracy today.
2. **Three-way match as a product, not a feature.** PO ↔ Invoice ↔ Challan with quantity and rate tolerance checking, surfaced as a queue.
3. **The owner dashboard Tally never had**, computed from *reconciled* data with an honest completeness badge — so the owner knows when a number is provisional and why.
4. **A CA-ready pack generated as a by-product**, not as a month-end project.
5. **Traceability as an architectural guarantee**, not a report. Every number → transactions → document → the pixel region it was read from.

### What we explicitly do **not** build **[MY CALL]**
Inventory management, e-way bills, payroll processing, e-invoicing IRN generation, and the statutory filing submission itself. These are solved, regulated, low-margin, and integrating beats rebuilding. We *read* them; we don't *run* them.

### The honest risk
ClearTax or Zoho can add document AI. Our defensibility is not the OCR — it is **the accumulated reconciliation rules, the per-company matching memory (this vendor's invoice format, this customer's payment behaviour), and the evidence graph.** That compounds; a feature does not. Design for that from day one: every human correction must train the per-company matching model. See `docs/06-ARCHITECTURE.md §5.4`.
