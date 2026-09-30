# 04 — SherrByte Business Design System

*Derived from **your** uploaded reference images (PDF p.1–4), not from a template. Everything in §1 is read directly off your screens.*

---

## 1. What your images actually establish

I read five reference screens. Here is the design language they define — this is the source of truth, and the system below is a faithful extension of it, not a replacement.

| Element | What your images show |
|---|---|
| **Canvas** | Pure black (`#000`). Not dark grey, not navy. Content floats on it. |
| **Light** | A soft radial glow behind the bottom dock and behind the page glyph — the canvas is lit from a point, not flat |
| **Top chrome** | Circular brand mark (the tiger-eye) at far left, then a very wide light-grey pill — a **command bar**, not a search box, spanning the full width |
| **Page identity** | Title top-left in large light-weight type (`Home`, `Profile`); a **large centred glyph** marking the page (house, avatar) |
| **Primary navigation** | A **floating segmented dock** at the bottom centre. Three segments. Active segment is a **white pill with a glow**; inactive segments sit on translucent grey |
| **Side switch** | A small two-dot toggle **below the dock** — switching between the two halves of the product. Left = workspace (`Input / Process / Output`), right = identity (`Dashboard / People / Data`) |
| **Focus treatment** | A container in focus gets a **vivid blue outer border with a glow** (the upload panel) — this is the accent colour of the product |
| **Drop target** | Large **dashed rounded rectangle**, generous inner space, centred label + icon |
| **Chips** | Rounded pill outlines for input types: *Sales invoices · Credit Notes · Purchase bills · PO's · Bank statements · cashbook · Customer and supplier ledgers · Expenses · Assets · Inventory · Payroll* |
| **Objects** | **Folder icons** in a loose grid for output categories: *Accounts · Taxation · Financial reports · Documentation* (+ empty slots for growth) |
| **Data cards** | **Light** surface (near-white) on the black canvas — inverted from everything else. A header strip, a **hairline divider**, then label / huge numeral / caption |
| **Typography** | A geometric humanist sans with a single-storey `a`-feel and generous letterforms. Light weights at large sizes. |
| **Density** | Very low. Large empty areas are deliberate. |

**The two ideas in your design that I want to keep and build on, because they are genuinely original:**

1. **Input / Process / Output as the navigation spine.** Most finance products navigate by *artifact* (Invoices, Reports, Settings). Yours navigates by *stage of the pipeline*. That maps exactly onto your COLLECT→EXTRACT→…→DISTRIBUTE model and it teaches the user the mental model just by existing. Keep it.
2. **Light cards on a black canvas.** Inverting the data surface makes numbers the brightest thing on screen. Most dashboards make the chrome bright and the numbers grey. Yours is the right way round.

---

## 2. Tokens

```css
:root {
  /* canvas */
  --sb-black:        #000000;
  --sb-canvas:       #000000;
  --sb-lift-1:       #0d0d0f;   /* panels on canvas */
  --sb-lift-2:       #17171a;   /* nested surfaces  */
  --sb-hairline:     rgba(255,255,255,.10);
  --sb-glow:         rgba(255,255,255,.14);  /* the radial light behind the dock */

  /* the inverted data surface — from your card image */
  --sb-surface:      #e4e4e4;
  --sb-surface-head: #ececec;
  --sb-surface-rule: rgba(0,0,0,.22);
  --sb-on-surface:   #0a0a0a;
  --sb-on-surface-2: #4a4a4a;

  /* text on canvas */
  --sb-text:         #f5f5f5;
  --sb-text-2:       #9a9a9e;
  --sb-text-3:       #5c5c62;

  /* accent — the blue glow from your upload panel */
  --sb-accent:       #2a2aff;
  --sb-accent-soft:  rgba(42,42,255,.28);

  /* status — the only place colour carries meaning */
  --sb-verified:     #2ecc71;
  --sb-provisional:  #f0a020;
  --sb-incomplete:   #f0a020;
  --sb-critical:     #ff4d4f;
  --sb-stale:        #6b6b70;

  /* type */
  --sb-font: "General Sans", "Satoshi", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --sb-font-num: "General Sans", ui-sans-serif, system-ui, sans-serif;
  --sb-fw-light: 300; --sb-fw-reg: 400; --sb-fw-med: 500;

  /* radii — your images are generously rounded */
  --sb-r-card: 22px; --sb-r-panel: 28px; --sb-r-pill: 999px; --sb-r-drop: 32px;

  /* rhythm — 4px base, but spacing steps are large */
  --sb-s1: 4px; --sb-s2: 8px; --sb-s3: 12px; --sb-s4: 16px;
  --sb-s5: 24px; --sb-s6: 32px; --sb-s7: 48px; --sb-s8: 72px;
}
```

**Type scale** (your images use very large, very light numerals):

| Token | Size / weight | Use |
|---|---|---|
| `display` | 72–96px / 300 | The value on a data card (`₹24.5L`) |
| `title` | 40px / 300 | Page title (`Home`, `Owner dashboard`) |
| `heading` | 24px / 400 | Section headings |
| `label` | 17px / 400 | Card label (`Available cash`) |
| `body` | 15px / 400 | Body, table cells |
| `caption` | 14px / 400, `--sb-text-2` | Card caption (`Reconciled`, `Month to date`) |
| `micro` | 12px / 500, +0.06em tracking, uppercase | Status pills, metadata |

**Numerals:** tabular figures everywhere a number can change or be compared (`font-variant-numeric: tabular-nums`). Non-negotiable in a finance product — without it, columns of rupees jitter.

**Indian number formatting:** lakh/crore grouping (`₹24,50,000`), and the compact form (`₹24.5L`, `₹1.2Cr`) on cards. The full-precision value is always in the tooltip and always in exports. Never round in an export.

---

## 3. Components

| Component | Spec |
|---|---|
| **Command bar** | Full-width pill, `--sb-surface`, 52px tall. Not just search: it accepts *"show overdue customers"*, *"open GSTR-2B recon"*, *"upload"*. Keyboard `⌘K`. This is your image's top pill, given a purpose. |
| **Bottom dock** | Floating segmented control, 3 segments, `--sb-r-pill`, translucent `#2a2a2e` track, active = `--sb-surface` pill + white glow. Sits 32px off the bottom, centred, with a radial glow behind it. |
| **Side toggle** | Two-dot control directly below the dock. Switches Workspace ⇄ Company. |
| **Data card** | `--sb-surface`, `--sb-r-card`. Header strip (48px) holding the status pill, then a 1px `--sb-surface-rule` divider, then label / display value / caption. Click = drill down. Hover lifts 2px. |
| **Drop panel** | `--sb-lift-1` panel with a `2px --sb-accent` border and `0 0 40px --sb-accent-soft` glow when armed; inside it a dashed `--sb-r-drop` target. Exactly your image. |
| **Type chip** | Outlined pill on canvas; filled `--sb-surface` when selected. |
| **Folder tile** | Large folder glyph + label beneath, in a loose grid. Badge on the folder corner for item count. |
| **Status pill** | `micro` type. `VERIFIED` (green dot only, no fill — verified is the quiet state), `PROVISIONAL` / `INCOMPLETE` (amber), `STALE` (grey), `DRAFT` (outline). |
| **Exception row** | Count numeral in a circle, plain-language label, ₹ impact right-aligned, whole row clickable. |
| **Trace sheet** | The panel that opens on any number: formula, as-of, sources, contributing transactions, and the document viewer with the extracted region highlighted. |

---

## 4. Rules that protect the product

1. **Colour carries meaning only for status.** Nothing else on the screen is coloured. This is why an amber pill is instantly readable.
2. **No decorative charts.** A chart appears only where a trend is the answer to a question the user asked. **[CONFIRMED — "Not a generic template full of unnecessary cards and charts"]**
3. **Every number is a link.** If it is not clickable to its evidence, it does not belong on screen.
4. **Provisional is visible without reading.** Amber pill + lighter numeral weight.
5. **Empty states state a cause and an action** — never "No data". *"No bank statements since 21 Sep. Connect HDFC or upload a statement."*
6. **Loading shows what is loading**, and a stale value stays on screen dimmed rather than being replaced by a skeleton. Owners re-read the same number many times a day; blanking it is worse than showing it dim.
7. **Accessibility:** all text ≥ 4.5:1 against its background. The amber and red are checked against both `--sb-surface` and `--sb-canvas`. Status is never colour-only — it always carries a word.
