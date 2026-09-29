# 10 — Missing Information, Risky Assumptions, and What Needs CA Validation

*Deliverable I. Read this before writing code — several items below change the design if answered differently.*

---

## 1. Decisions I made on your behalf *(because they were missing, and the work needed them)*

| # | Decision | Why | Cost to reverse |
|---|---|---|---|
| D1 | **Python/FastAPI** for the business backend, Spring Boot untouched for the consumer app | Your PDF p.22 chose FastAPI; the repo is Java. Document AI is decisively better in Python; the two products share no domain. | **Low now, very high after P2.** Decide in week 1. |
| D2 | **Integrate rather than replace** Tally/Zoho | Your own conclusion (p.37) | Low |
| D3 | **Bank statement upload, not bank API**, for the MVP | Bank/AA access takes months to obtain and would block everything | Low — it's additive |
| D4 | **User-uploaded GSTR-2B JSON, not a GSP**, for the MVP | GSP contracting is a business milestone; don't let it gate engineering | Low |
| D5 | **Band C (profit) metrics excluded from MVP** | They need valued closing stock + a closed period; shipping them early produces confidently wrong profit | Low |
| D6 | **Auto-post threshold starts at "never"** per org | Trust is earned per customer; a wrong auto-post on day one is unrecoverable | Low |
| D7 | Fixed drill-down chain and a mandatory trace envelope | Makes "every number traceable" structural rather than aspirational | **Very high after P3** |
| D8 | RLS in the database, not filtering in application code | One forgotten `WHERE` ends the company | **Very high later** |

---

## 2. Information I need from you

### Product & market *(blocks pricing and prioritisation, not code)*
1. **Target customer size?** A ₹5cr trader and a ₹200cr manufacturer need very different products. The dashboard spec assumes **₹10–100cr turnover, 1–3 entities**. Confirm or correct.
2. **Who is the buyer — the business, or the CA firm?** This changes everything: the CA-firm motion needs a multi-client board and per-client billing from day one; the direct motion needs self-serve onboarding. I have specced both, but **you cannot build both well at once.** My recommendation: **sell through CA firms.** They have distribution, they feel the pain most acutely, and one firm brings 30 companies.
3. **Which industry first?** Trading, manufacturing and services have materially different COGS and inventory logic. I assumed **trading** in the worked example. Manufacturing needs BOM/WIP and is substantially more work.
4. Single GSTIN or multi-state? Multi-GSTIN changes the tax engine's shape.
5. Composition scheme, e-invoicing applicability, e-way bill dependence?

### Technical
6. **Is Tally on a desktop behind a router at these customers?** Almost certainly yes. Confirms the need for a local agent with an outbound tunnel — that is a real piece of engineering, not a connector.
7. Which banks matter most? Statement parsing is per-format work; name the top 5 and we build those.
8. Does anyone use Zoho/Busy/Marg, or is it Tally everywhere?
9. Expected volume — documents/month/company? 200 vs 5,000 changes the extraction cost model.
10. On-premise deployment ever required? Your PDF (p.9) mentions zero-trust/on-prem. That is a very different product; I have assumed **cloud-only**.

### Commercial
11. Pricing — per company, per user, per document, or per CA firm seat?
12. **Unit economics of extraction.** At ~₹2–6 per document in model costs, 2,000 docs/month is ₹4,000–12,000/month in COGS for one customer. This must be under the price. Needs a decision before pricing.

---

## 3. Risky assumptions — with mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Extraction accuracy on real Indian documents** — handwritten annotations, poor scans, regional-language stamps, non-standard layouts | **Highest** | Test on 200 real documents in week 3, before building anything downstream. If accuracy is under 80%, the whole product thesis needs revisiting. This is the make-or-break experiment; run it first. |
| **A wrong auto-match or auto-post** destroys trust permanently | **Highest** | Conservative thresholds, "never" by default, false positives are release-blocking, every automated action is reversible and logged |
| **Tally connectivity** — desktop, behind a router, often an old version | High | Local agent with outbound tunnel; graceful fallback to scheduled file export |
| **Opening balance quality** — customers' existing books are often wrong | High | Hard gate at onboarding; itemise every difference; never absorb a difference into suspense |
| **Accountant rejection** — if the accountant feels replaced, they will kill the deal | High | Position as *removing the boring work*. The accountant's queue is the best-designed screen in the product, and the CA is the approver, never the approved. |
| **AI hallucinating a number into a report** | High | Structural separation (§5.1 of `docs/06-ARCHITECTURE.md`), import-linter enforcement, AI narrative visually separated from computed figures |
| **Tax rules change** | Medium | Versioned, dated rule sets from day one — retrofitting this is very painful |
| **Competitor adds document AI** | Medium | The moat is the per-company correction memory + evidence graph, not the OCR. Build the correction loop in P1, not later. |
| **Model cost at scale** | Medium | Cheap model for classification, expensive only for hard extraction; cache by layout; per-vendor hints reduce token use over time |
| **DPDP Act obligations** | Medium | Legal review before the first paying customer |
| **Scope creep into becoming Tally** | Medium | The "what we do not build" list in `docs/01-PRODUCT-BLUEPRINT.md` is a commitment, not a note |

---

## 4. What a qualified CA must validate before it ships

**I am not a Chartered Accountant. Nothing in these documents is professional advice, and every item below needs sign-off from a practising CA before it reaches a customer.**

### Taxation — highest priority
1. GST rate application, place-of-supply determination, and the exact **set-off ladder order** used in `docs/07-WORKED-EXAMPLE.md`
2. ITC eligibility rules, blocked credits (§17(5)), and the treatment of invoices absent from GSTR-2B
3. Reverse-charge identification
4. TDS section determination, threshold logic (single payment vs annual aggregate), higher rates for invalid/absent PAN
5. What "draft return data" may legally contain, and the exact disclaimer wording
6. Whether preparing return data creates any professional liability for us

### Accounting
7. Revenue recognition timing for the target industries
8. COGS composition — what belongs in direct cost vs operating expense
9. Inventory valuation policy options and the correct treatment of changes
10. Depreciation methods and rates (Companies Act vs Income Tax Act — they differ, and both may be needed)
11. The period-close checklist itself: are the gates in `docs/08-USER-JOURNEYS.md` J4 the right ones?
12. Financial statement formats — Schedule III compliance for companies

### Process
13. What a CA is willing to sign off on, and what evidence they need to do it
14. Audit trail requirements under the Companies (Accounts) Rules — the audit-trail/edit-log mandate has specific requirements we must meet
15. Document retention periods
16. Whether our `PROVISIONAL` / `VERIFIED` language is safe, or could be read as an assurance opinion

---

## 5. The claims this product must never make **[CONFIRMED]**

- ✗ "Replaces your CA"  → ✓ "Prepares the work your CA reviews"
- ✗ "Guarantees GST compliance"  → ✓ "Prepares GST workings for review and filing by an authorised person"
- ✗ "Audited financials"  → ✓ "Financial statements prepared from your records"
- ✗ "AI-verified accounts"  → ✓ "Reconciled records, reviewed and approved by your team"
- ✗ Any implication of a statutory audit opinion

These belong in the marketing site, the product copy and the sales deck — not just in this document. The disclaimer on every taxation output and every generated PDF is a product requirement, tracked as **AT-TAX-6**.
