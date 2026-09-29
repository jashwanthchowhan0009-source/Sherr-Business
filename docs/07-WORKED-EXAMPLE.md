# 07 — Worked Example: how input records become verified output numbers

*A realistic Indian trading business, September 2026. Every figure below is arithmetically consistent and traced end-to-end. **All figures are illustrative example data** — this is a specification, not a real company.*

**Shree Balaji Traders Pvt Ltd** · Bengaluru, Karnataka · GSTIN `29AABCS1234A1Z5` · FY Apr–Mar · payment terms 30 days (sales), 45 days (purchases)

---

## Step 1 — INPUT: what arrives

### Sales invoices
| Doc | Date | Customer | State | Taxable | CGST | SGST | IGST | Total |
|---|---|---|---|---:|---:|---:|---:|---:|
| INV-1031 | 05 Aug | Gokul Agencies | KA | 3,00,000 | 27,000 | 27,000 | — | **3,54,000** |
| INV-1042 | 03 Sep | Anand Enterprises | KA | 4,00,000 | 36,000 | 36,000 | — | **4,72,000** |
| INV-1043 | 09 Sep | Meridian Industries *(job work)* | TN | 6,00,000 | — | — | 1,08,000 | **7,08,000** |
| INV-1044 | 18 Sep | Anand Enterprises | KA | 2,50,000 | 22,500 | 22,500 | — | **2,95,000** |
| CN-07 | 22 Sep | Anand Enterprises *(credit note v. INV-1044)* | KA | (50,000) | (4,500) | (4,500) | — | **(59,000)** |

### Purchase bills
| Doc | Date | Supplier | State | Taxable | CGST | SGST | IGST | Total | In GSTR-2B? |
|---|---|---|---|---:|---:|---:|---:|---:|:-:|
| PB-551 | 05 Sep | Kaveri Polymers *(goods)* | KA | 5,00,000 | 45,000 | 45,000 | — | **5,90,000** | ✓ |
| PB-552 | 12 Sep | Deccan Logistics *(inward freight)* | KA | 80,000 | 7,200 | 7,200 | — | **94,400** | ✓ |
| PB-553 | 20 Sep | Sunrise Packaging *(goods)* | MH | 1,20,000 | — | — | 21,600 | **1,41,600** | ✗ *filed late* |

### Supporting documents
`PO-218` → Kaveri Polymers, **1,000 kg @ ₹500** · `DC-91` delivery challan, **950 kg received** · PB-552 arrived **twice** (vendor email + Tally sync)

### Bank statement — HDFC current account (opening 01 Sep: ₹8,00,000)
| Date | Narration | Debit | Credit |
|---|---|---:|---:|
| 15 Sep | `NEFT-ANAND ENTERPRISE-CR` | | 4,72,000 |
| 20 Sep | `GST PMT-AUG-3B` | 85,000 | |
| 25 Sep | `NEFT-MERIDIAN INDS-XXXX` | | 6,96,000 |
| 27 Sep | `UPI-4471XXXXXX` | 18,500 | |
| 28 Sep | `RTGS-DECCAN LOGISTICS` | 94,400 | |
| 30 Sep | `SALARY-SEP` | 1,50,000 | |

---

## Step 2 — PROCESS: what the system does, and what it refuses to do

**Deduplication.** PB-552 has an identical SHA-256 to its Tally-sync twin ⇒ the second is marked `superseded`, linked to the first. **One transaction, not two.** Without this, payables would be overstated by ₹94,400 — a classic silent error.

**Three-way match on PO-218.** Invoice 1,000 kg vs challan 950 kg ⇒ discrepancy `QTY_MISMATCH`, severity **high**, `amount_impact = ₹29,500` (₹25,000 + ₹4,500 GST). **The bill is not blocked from posting** — it is posted and flagged, because blocking it would make the payables figure wrong in a different way. The exception carries the impact so every downstream metric can state its uncertainty.

**Bank matching.**
- `15 Sep ₹4,72,000` → INV-1042 exactly. Tier 1 (exact), auto-matched.
- `25 Sep ₹6,96,000` vs INV-1043 ₹7,08,000 → shortfall ₹12,000 = **2.00% of the ₹6,00,000 taxable value** = the 194C TDS signature. Tier 4 residual-aware match: `residual_reason = 'tds'`, invoice settled, ₹12,000 posted to *TDS receivable*. **A naive matcher would have left this "unmatched" and understated collections by ₹6.96L.**
- `27 Sep ₹18,500 UPI` → no supporting document. Discrepancy `MISSING_DOCUMENT`, severity medium, impact ₹18,500. **The engine does not guess a category.**
- `28 Sep ₹94,400` → PB-552, exact. `20 Sep ₹85,000` → August GST challan. `30 Sep ₹1,50,000` → payroll.

**GSTR-2B reconciliation.** PB-553 is absent from September's 2B (vendor filed late) ⇒ `ITC_DEFERRED`, ₹21,600, vendor named, follow-up raised. **It is not claimed.** This single rule is the difference between a clean filing and a notice.

---

## Step 3 — OUTPUT: every number, with its arithmetic

### Sales (net of GST, net of credit notes)
```
12,50,000 (Sep invoices: 4,00,000 + 6,00,000 + 2,50,000)  −  50,000 (CN-07)
SALES_MTD = ₹12,00,000
```

### Gross profit
```
COGS = opening stock 6,00,000 + goods purchased 6,20,000 + inward freight 80,000
                                               − closing stock 5,20,000  =  7,80,000
GROSS_PROFIT = 12,00,000 − 7,80,000 = ₹4,20,000        GROSS_MARGIN = 35.00%
```
Status **INCOMPLETE** — *"₹25,000 quantity mismatch on PB-551 is unresolved and could move COGS."*

### EBITDA
```
Operating expenses = salaries 1,50,000 + rent 60,000 + other 20,000 = 2,30,000
EBITDA = 4,20,000 − 2,30,000 = ₹1,90,000                EBITDA_MARGIN = 15.83%
```
Status **PROVISIONAL** — September is not closed.

### Net profit
```
PBT = 1,90,000 − depreciation 35,000 − interest 15,000 = 1,40,000
Tax @ 25% ≈ 35,000    NET_PROFIT = ₹1,05,000            NET_MARGIN = 8.75%
```
Status **PROVISIONAL** — depreciation and tax are period-end computations.

### Cash
```
Inflow  = 4,72,000 + 6,96,000                                  = 11,68,000
Outflow = 85,000 + 18,500 + 94,400 + 1,50,000                  =  3,47,900
NET_CASH_FLOW = +₹8,20,100
AVAILABLE_CASH = 8,00,000 + 11,68,000 − 3,47,900 = ₹16,20,100
```
Status **INCOMPLETE** — *"1 unmatched bank line of ₹18,500."*

### Receivables
```
INV-1031  3,54,000  due 04 Sep   → OVERDUE 26 days
INV-1044  2,95,000 − CN 59,000 = 2,36,000  due 18 Oct → current
RECEIVABLES_TOTAL = ₹5,90,000      RECEIVABLES_OVERDUE = ₹3,54,000
```
*(INV-1042 settled in full; INV-1043 settled ₹6,96,000 cash + ₹12,000 TDS receivable.)*

### Payables
```
PB-551  5,90,000  due 20 Oct        PB-553  1,41,600  due 20 Oct
PAYABLES_TOTAL = ₹7,31,600          PAYABLES_DUE_7D = ₹0
```

### GST — including the set-off ladder the engine must get right
```
Output tax   CGST  54,000   SGST  54,000   IGST 1,08,000   = 2,16,000
ITC in 2B    CGST  52,200   SGST  52,200   IGST      —     = 1,04,400
ITC deferred (PB-553, not in 2B)                    21,600   ← not claimed

Set-off, in the statutory order:
  IGST liability 1,08,000 ← IGST ITC 0                   → pay 1,08,000
  CGST liability   54,000 ← CGST ITC 52,200              → pay     1,800
  SGST liability   54,000 ← SGST ITC 52,200              → pay     1,800
GST_PAYABLE (cash) = ₹1,11,600        due 20 Oct 2026
```

### TDS deducted by the company
```
194I  rent 60,000 @ 10%              = 6,000
194C  Deccan Logistics 80,000 @ 2%   = 1,600
TDS_PAYABLE = ₹7,600                  due 07 Oct 2026
```

---

## Step 4 — the owner's screen on 30 Sep 2026

```
Books current to 30 Sep · 4/4 sources fresh · 4 items need you · Sep period OPEN

  Available cash        ₹16.2L    Reconciled · ₹18.5K unmatched     [INCOMPLETE]
  Sales MTD             ₹12L      Month to date
  Customer dues         ₹5.9L     ₹3.54L overdue
  Payments due          ₹7.32L    Next 7 days: ₹0
  Net cash flow        +₹8.2L     This month
  EBITDA                ₹1.9L     Provisional MTD                  [PROVISIONAL]

  Needs attention
   1  Overdue customer payment — Gokul Agencies, 26 days      ₹3,54,000
   1  Quantity mismatch — PB-551 vs DC-91, 50 kg                ₹29,500
   1  ITC not in GSTR-2B — Sunrise Packaging                    ₹21,600
   1  Unmatched bank transaction — 27 Sep UPI                   ₹18,500
      GSTR-3B due in 20 days · ₹1,11,600
```

---

## Step 5 — the trace, which is the whole point

Owner clicks **₹5.9L**:

```
Customer dues ₹5,90,000 · as of 30 Sep 18:30 IST · receivables@1.3.0
  formula: Σ (invoice total − payments − credit notes) on open sales invoices

  → Gokul Agencies      ₹3,54,000   overdue 26 days
      → INV-1031 · 05 Aug · ₹3,54,000 · 0 payments
          → INV-1031.pdf  ┌───────────────────────┐
                          │ Total  ₹3,54,000  ▓▓▓ │  ← extracted region, page 1
                          └───────────────────────┘
             confidence 0.99 · method native_pdf · arithmetic check PASSED
             approved by Priya S. (accountant), 06 Aug 11:42
  → Anand Enterprises   ₹2,36,000   due 18 Oct
      → INV-1044 ₹2,95,000  −  CN-07 ₹59,000

  SUM of listed items = ₹5,90,000 ✓ matches displayed value
```

That last line is the product's contract with its user, and it is an automated test. See `docs/09-IMPLEMENTATION-PLAN.md` — **AT-DASH-1**.
