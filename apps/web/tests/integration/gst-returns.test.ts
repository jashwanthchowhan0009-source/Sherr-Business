import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { withTenant } from '../../src/lib/db/tenant';
import { allocateVoucherNumber, createVoucher, postVoucher } from '../../src/lib/db/ledger';
import { calculateInvoice } from '../../src/lib/accounting/gst';
import {
  creditNoteEntries,
  purchaseBillEntries,
  salesInvoiceEntries,
} from '../../src/lib/accounting/posting';
import { QTY_SCALE } from '../../src/lib/accounting/units';
import {
  getBookPurchasesForRecon,
  getGstr1,
  getGstr3b,
  getTaxRuleStatus,
  getTdsRules,
  getTdsPayable,
} from '../../src/server/gst-queries';
import { getRegister, getTrialBalance } from '../../src/server/reports';
import { reconcileGstr2b } from '../../src/lib/gst/gstr2b';
import { totalTax } from '../../src/lib/gst/set-off';
import { suggestTds } from '../../src/lib/tds/engine';
import {
  gstr1Export,
  gstr1HsnExport,
  gstr2bExport,
  gstr3bExport,
  setOffExport,
  taxRulesExport,
  tdsPayableExport,
  tdsRulesExport,
} from '../../src/lib/export/tax-exports';
import { allCells, toCsvFile, toKeyed } from '../../src/lib/export/write';
import { cleanup, ownerPool, seedTwoOrgs, type Fixture } from './_db';
import type { RequestContext } from '../../src/lib/auth/context';

/**
 * The GST returns against real postings.
 *
 * The important assertions are the cross-checks: a return that disagrees with the
 * books it was drawn from will be filed and then have to be amended, so GSTR-1
 * and GSTR-3B are reconciled against the register and the trial balance rather
 * than against each other.
 */
describe('GST returns', () => {
  let owner: Pool;
  let fx: Fixture;
  let ctx: RequestContext;
  let ctxB: RequestContext;
  let registered: string;
  let unregistered: string;
  let supplier: string;

  const PERIOD = { from: '2025-06-01', to: '2025-06-30' };

  const asContext = (orgId: string, userId: string): RequestContext =>
    ({ orgId, userId, role: 'owner', clerkUserId: 'test', ip: null, userAgent: null }) as unknown as RequestContext;

  const lines = (rupees: bigint, rateBps: number, hsn: string | null = '1006') => [
    {
      itemId: null,
      description: 'Basmati rice',
      hsnSac: hsn,
      unit: 'KGS',
      quantity: 100n * QTY_SCALE,
      unitPricePaise: (rupees * 100n) / 100n,
      discountPaise: 0n,
      gstRateBps: rateBps,
      cessRateBps: 0,
      reverseCharge: false,
    },
  ];

  const raise = (input: {
    type: 'sales' | 'purchase' | 'credit_note';
    date: string;
    partyId: string;
    rupees: bigint;
    rateBps?: number;
    pos?: string;
    supplyType?: 'intra_state' | 'inter_state' | 'zero_rated' | 'exempt';
    hsn?: string | null;
    supplierInvoiceNo?: string;
    reverseCharge?: boolean;
  }) =>
    withTenant({ orgId: fx.orgA, userId: null }, async (tx) => {
      const supplyType = input.supplyType ?? (input.pos === '27' ? 'inter_state' : 'intra_state');
      // `??` would turn an explicit null HSN back into '1006', which is the
      // opposite of what the missing-HSN case needs to test.
      const hsn = input.hsn === undefined ? '1006' : input.hsn;
      const voucherLines = lines(input.rupees, input.rateBps ?? 1800, hsn).map(
        (l) => ({ ...l, reverseCharge: input.reverseCharge ?? false }),
      );
      const calculation = calculateInvoice(voucherLines, supplyType);
      const prefix =
        input.type === 'sales' ? 'INV' : input.type === 'purchase' ? 'BILL' : 'CRN';
      const voucherNo = await allocateVoucherNumber(tx, {
        voucherType: input.type,
        fyLabel: '25-26',
        prefix,
      });
      const entries =
        input.type === 'sales'
          ? salesInvoiceEntries(calculation)
          : input.type === 'purchase'
            ? purchaseBillEntries(calculation)
            : creditNoteEntries(calculation);

      const created = await createVoucher(tx, {
        voucherType: input.type,
        voucherNo,
        fyLabel: '25-26',
        voucherDate: input.date,
        partyId: input.partyId,
        supplierStateCode: '29',
        placeOfSupplyStateCode: input.pos ?? '29',
        supplyType,
        reference: null,
        ...(input.supplierInvoiceNo
          ? { supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceDate: input.date }
          : {}),
        narration: null,
        calculation,
        lines: voucherLines,
        entries,
      });
      await postVoucher(tx, { voucherId: created.id, userId: null });
      return created;
    });

  beforeAll(async () => {
    owner = ownerPool();
    fx = await seedTwoOrgs(owner, `gstr${Date.now()}`);
    ctx = asContext(fx.orgA, fx.userA);
    ctxB = asContext(fx.orgB, fx.userB);

    await owner.query(
      `insert into org_registrations (org_id, kind, number, state_code)
       values ($1, 'gstin', '29AABCS1234A1Z5', '29')
       on conflict (org_id, kind, number) do nothing`,
      [fx.orgA],
    );

    [registered, unregistered, supplier] = await withTenant(
      { orgId: fx.orgA, userId: null },
      async (tx) => {
        const mk = async (
          kind: string,
          name: string,
          gstin: string | null,
          state: string,
        ) => {
          const { rows } = await tx.execute<{ id: string }>(sql`
            insert into parties (org_id, kind, name, gstin, state_code,
                                 place_of_supply_state_code, credit_days)
            values (app_current_org_id(), ${kind}, ${name}, ${gstin}, ${state}, ${state}, 30)
            returning id
          `);
          return rows[0]!.id;
        };
        return [
          await mk('customer', 'Anand Enterprises', '29AAACA1111A1Z7', '29'),
          await mk('customer', 'Walk-in Customer', null, '27'),
          await mk('supplier', 'Mumbai Supplies', '27AAACS9999A1Z1', '27'),
        ];
      },
    );

    // Outward: a B2B intra-state sale, a large inter-state B2C sale, a credit
    // note, and an exempt supply.
    await raise({ type: 'sales', date: '2025-06-05', partyId: registered, rupees: 1_00_000n });
    await raise({
      type: 'sales',
      date: '2025-06-10',
      partyId: unregistered,
      rupees: 3_00_000n,
      pos: '27',
    });
    await raise({
      type: 'sales',
      date: '2025-06-12',
      partyId: registered,
      rupees: 20_000n,
      supplyType: 'exempt',
      rateBps: 0,
    });
    await raise({
      type: 'credit_note',
      date: '2025-06-20',
      partyId: registered,
      rupees: 10_000n,
    });

    // Inward: a bill from a registered supplier.
    await raise({
      type: 'purchase',
      date: '2025-06-08',
      partyId: supplier,
      rupees: 50_000n,
      pos: '29',
      supplierInvoiceNo: 'MS/2025/0441',
    });
  });

  afterAll(async () => {
    await cleanup(owner, fx);
    await owner.end();
  });

  describe('GSTR-1', () => {
    it('sorts supplies into their tables', async () => {
      const r1 = await getGstr1(ctx, PERIOD);
      const tables = r1.sections.map((s) => s.table);
      expect(tables).toContain('b2b');
      expect(tables).toContain('b2cl'); // inter-state, unregistered, above threshold
      expect(tables).toContain('nil_exempt');
      expect(tables).toContain('credit_notes_registered');
    });

    it('agrees with the sales register on taxable value', async () => {
      // Two independent paths: the return groups supplies into tables, the
      // register sums voucher headers. A return that disagrees with the books
      // will be filed and then amended.
      const r1 = await getGstr1(ctx, PERIOD);
      const register = await getRegister(ctx, { kind: 'sales', ...PERIOD });
      expect(r1.totalTaxablePaise).toBe(register.taxablePaise);
    });

    it('agrees with the register on every tax head', async () => {
      const r1 = await getGstr1(ctx, PERIOD);
      const register = await getRegister(ctx, { kind: 'sales', ...PERIOD });
      expect(r1.totalTax.cgst).toBe(register.cgstPaise);
      expect(r1.totalTax.sgst).toBe(register.sgstPaise);
      expect(r1.totalTax.igst).toBe(register.igstPaise);
    });

    it('lets the credit note reduce the totals', async () => {
      const r1 = await getGstr1(ctx, PERIOD);
      const notes = r1.sections.find((s) => s.table === 'credit_notes_registered')!;
      expect(notes.taxablePaise).toBeLessThan(0n);
    });

    it('builds an HSN summary from the lines', async () => {
      const r1 = await getGstr1(ctx, PERIOD);
      expect(r1.hsnSummary.length).toBeGreaterThan(0);
      expect(r1.hsnSummary[0]?.hsnSac).toBe('1006');
    });

    it('reports the B2CL threshold it used, and that the rule is unverified', async () => {
      const r1 = await getGstr1(ctx, PERIOD);
      expect(r1.b2clThresholdPaise).toBe(2_50_000_00n);
      // Every seeded rule ships unverified.
      expect(r1.b2clThresholdVerified).toBe(false);
    });

    it('names invoices with no HSN, which the portal would reject', async () => {
      await raise({
        type: 'sales',
        date: '2025-06-25',
        partyId: registered,
        rupees: 1_000n,
        hsn: null,
      });
      const r1 = await getGstr1(ctx, PERIOD);
      expect(r1.invoicesMissingHsn.length).toBeGreaterThan(0);
    });

    it('always says it needs CA verification', async () => {
      expect((await getGstr1(ctx, PERIOD)).needsCaVerification).toBe(true);
    });

    it('shows another company nothing', async () => {
      const r1 = await getGstr1(ctxB, PERIOD);
      expect(r1.sections).toEqual([]);
      expect(r1.totalTaxablePaise).toBe(0n);
    });
  });

  describe('GSTR-3B', () => {
    it('separates taxable, zero-rated and exempt outward supplies', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      expect(r3b.outwardTaxable.taxablePaise).toBeGreaterThan(0n);
      expect(r3b.outwardNilExempt.taxablePaise).toBe(20_000_00n);
    });

    it('agrees with the trial balance on output tax', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      const tb = await getTrialBalance(ctx, PERIOD.to);
      const output = (code: string) => -(tb.rows.find((r) => r.code === code)?.netPaise ?? 0n);
      // The return's liability is output tax plus reverse charge; with no
      // reverse-charge purchase in the period, it is output tax alone.
      expect(r3b.outwardTaxable.tax.cgst).toBe(output('OUTPUT_CGST'));
      expect(r3b.outwardTaxable.tax.sgst).toBe(output('OUTPUT_SGST'));
      expect(r3b.outwardTaxable.tax.igst).toBe(output('OUTPUT_IGST'));
    });

    it('agrees with the trial balance on input credit', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      const tb = await getTrialBalance(ctx, PERIOD.to);
      const input = (code: string) => tb.rows.find((r) => r.code === code)?.netPaise ?? 0n;
      expect(r3b.itcAvailable.cgst).toBe(input('INPUT_CGST'));
      expect(r3b.itcAvailable.sgst).toBe(input('INPUT_SGST'));
    });

    it('applies the set-off and shows its working', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      expect(r3b.setOff.steps.length).toBeGreaterThan(0);
      for (const step of r3b.setOff.steps) {
        expect(step.authority).toMatch(/Section 49/);
      }
    });

    it('accounts for every rupee of liability, by credit or in cash', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      expect(
        r3b.setOff.totalCreditUsedPaise + r3b.setOff.totalPayableInCashPaise,
      ).toBe(totalTax(r3b.setOff.liability));
    });

    it('never uses CGST credit against SGST, or the reverse', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      const crossed = r3b.setOff.steps.filter(
        (s) =>
          (s.creditHead === 'cgst' && s.liabilityHead === 'sgst') ||
          (s.creditHead === 'sgst' && s.liabilityHead === 'cgst'),
      );
      expect(crossed).toEqual([]);
    });

    it('reports credit reversed as nil, since nothing computes a reversal', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      expect(totalTax(r3b.itcReversed)).toBe(0n);
    });

    it('always says it needs CA verification', async () => {
      const r3b = await getGstr3b(ctx, PERIOD);
      expect(r3b.needsCaVerification).toBe(true);
      expect(r3b.setOff.needsCaVerification).toBe(true);
    });
  });

  describe('GSTR-2B reconciliation', () => {
    it('matches a bill the portal also shows', async () => {
      const bookPurchases = await getBookPurchasesForRecon(ctx, PERIOD);
      const ours = bookPurchases.find((p) => p.supplierInvoiceNo === 'MS/2025/0441')!;

      const result = reconcileGstr2b({
        period: '062025',
        portalInvoices: [
          {
            supplierGstin: '27AAACS9999A1Z1',
            supplierName: 'Mumbai Supplies',
            invoiceNo: 'MS/2025/0441',
            invoiceDate: '2025-06-08',
            taxablePaise: ours.taxablePaise,
            tax: ours.tax,
            itcAvailable: true,
            itcReason: null,
          },
        ],
        bookPurchases,
      });
      expect(result.counts.matched).toBe(1);
      expect(result.creditAtRiskPaise).toBe(0n);
    });

    it('prices credit claimed that the portal does not support', async () => {
      const bookPurchases = await getBookPurchasesForRecon(ctx, PERIOD);
      const result = reconcileGstr2b({
        period: '062025',
        portalInvoices: [],
        bookPurchases,
      });
      expect(result.counts.in_books_not_in_2b).toBe(1);
      expect(result.creditAtRiskPaise).toBe(totalTax(bookPurchases[0]!.tax));
    });

    it('shows another company no purchases', async () => {
      expect(await getBookPurchasesForRecon(ctxB, PERIOD)).toEqual([]);
    });
  });

  describe('TDS', () => {
    it('reads every version of every rule from the table', async () => {
      const rules = await getTdsRules(ctx);
      expect(rules.length).toBeGreaterThan(5);
      // All of them, including superseded versions, so a payment entered late
      // can still reach the rule that applied on its own date.
      expect(rules.some((r) => r.effectiveTo !== null)).toBe(true);
    });

    it('ships every rule unverified', async () => {
      const rules = await getTdsRules(ctx);
      expect(rules.every((r) => r.needsCaVerification)).toBe(true);
    });

    it('carries a source note saying what to confirm', async () => {
      const rules = await getTdsRules(ctx);
      expect(rules.every((r) => (r.sourceNote ?? '').length > 20)).toBe(true);
    });

    it('suggests a deduction using the rule in force on the payment date', async () => {
      const rules = await getTdsRules(ctx);
      const contractor = rules.find((r) => r.section === '194C_OTHER')!;
      const suggestion = suggestTds({
        rules,
        payment: {
          section: contractor.section,
          paymentDate: '2025-06-15',
          amountPaise: 1_00_000_00n,
          paidThisYearPaise: 0n,
          alreadyDeductedPaise: 0n,
          partyHasPan: true,
        },
      });
      expect(suggestion.outcome).toBe('deduct');
      // 2% of ₹1,00,000.
      expect(suggestion.deductNowPaise).toBe(2_000_00n);
      expect(suggestion.needsCaVerification).toBe(true);
    });

    it('uses the older commission rate for a payment before the change', async () => {
      // The rate I believe changed on 1 October 2024. A payment before it must
      // compute under the earlier rate, which is why the old row is kept.
      const rules = await getTdsRules(ctx);
      const before = suggestTds({
        rules,
        payment: {
          section: '194H_COMMISSION_PRE_OCT_2024',
          paymentDate: '2024-08-15',
          amountPaise: 1_00_000_00n,
          paidThisYearPaise: 0n,
          alreadyDeductedPaise: 0n,
          partyHasPan: true,
        },
      });
      expect(before.rateBpsApplied).toBe(500);

      const after = suggestTds({
        rules,
        payment: {
          section: '194H_COMMISSION',
          paymentDate: '2025-06-15',
          amountPaise: 1_00_000_00n,
          paidThisYearPaise: 0n,
          alreadyDeductedPaise: 0n,
          partyHasPan: true,
        },
      });
      expect(after.rateBpsApplied).toBe(200);
    });

    it('reports nothing deducted yet', async () => {
      const payable = await getTdsPayable(ctx, PERIOD.to);
      expect(payable.totalPaise).toBe(0n);
      expect(payable.rows.map((r) => r.accountCode).sort()).toEqual([
        'TDS_PAYABLE',
        'TDS_RECEIVABLE',
      ]);
    });
  });

  describe('the rule register', () => {
    it('lists every rule with its verification state', async () => {
      const rules = await getTaxRuleStatus(ctx);
      expect(rules.length).toBeGreaterThan(15);
      expect(rules.every((r) => r.needsCaVerification)).toBe(true);
    });

    it('puts unverified rules first', async () => {
      const rules = await getTaxRuleStatus(ctx);
      expect(rules[0]?.needsCaVerification).toBe(true);
    });

    it('marks a product-wide rule as not this company’s to sign off', async () => {
      const rules = await getTaxRuleStatus(ctx);
      expect(rules.every((r) => r.isOwnRule === false)).toBe(true);
    });
  });

  /**
   * The exports, against the same real postings.
   *
   * The unit tests build these from synthetic views, which proves the arrangement
   * but not the join: a query could return a field that typechecks and is still the
   * wrong one. These assertions go query → builder → file and check that a figure
   * which reached the page also reached the file, unchanged.
   */
  describe('exports', () => {
    it('carries the same totals to the file that the page shows', async () => {
      const view = await getGstr1(ctx, PERIOD);
      const file = gstr1Export(view);
      const text = allCells(file).join('|');

      // The rupee figure, exactly as the file writes it, from the paise the page used.
      const expected = (view.totalTaxablePaise / 100n).toString();
      expect(text).toContain(`${expected}.${(view.totalTaxablePaise % 100n).toString().padStart(2, '0')}`);

      // And the invoices themselves, not just the totals.
      for (const section of view.sections) {
        for (const invoice of section.invoices) {
          expect(text).toContain(invoice.voucherNo);
        }
      }
    });

    it('writes a CSV whose every data row matches its header width', async () => {
      const files = [
        gstr1Export(await getGstr1(ctx, PERIOD)),
        gstr1HsnExport(await getGstr1(ctx, PERIOD)),
        gstr3bExport(await getGstr3b(ctx, PERIOD)),
        setOffExport(await getGstr3b(ctx, PERIOD)),
        tdsPayableExport(await getTdsPayable(ctx, PERIOD.to), PERIOD),
        tdsRulesExport(await getTdsRules(ctx), PERIOD),
        taxRulesExport(await getTaxRuleStatus(ctx), PERIOD),
      ];

      for (const file of files) {
        for (const table of file.tables) {
          if (!table.header) continue;
          for (const row of table.rows) {
            expect(
              row.length,
              `${file.filename}: a row of ${row.length} cells under a header of ${table.header.length}`,
            ).toBeLessThanOrEqual(table.header.length);
          }
        }
        // And it writes without throwing on any real value.
        expect(toCsvFile(file).length).toBeGreaterThan(0);
      }
    });

    it('keys every real row without losing a cell', async () => {
      const keyed = toKeyed(gstr1Export(await getGstr1(ctx, PERIOD)));
      for (const table of keyed.tables) {
        for (const row of table.rows) {
          // No key collisions and no cell dropped: one key per cell written.
          expect(Object.keys(row).length).toBe(table.columns.length);
        }
      }
    });

    it('states on every file that it is not a filing', async () => {
      const files = [
        gstr1Export(await getGstr1(ctx, PERIOD)),
        gstr3bExport(await getGstr3b(ctx, PERIOD)),
        setOffExport(await getGstr3b(ctx, PERIOD)),
        taxRulesExport(await getTaxRuleStatus(ctx), PERIOD),
      ];
      for (const file of files) {
        expect(file.notes.join(' ')).toContain('Not filed anywhere');
        expect(file.notes.join(' ')).toContain('chartered accountant');
      }
    });

    it('says in the register export how many rules a CA has not seen', async () => {
      const rules = await getTaxRuleStatus(ctx);
      const file = taxRulesExport(rules, PERIOD);
      expect(file.notes.join(' ')).toContain(
        `${rules.length} of ${rules.length} rules have not been verified`,
      );
      expect(allCells(file).join('|')).toContain('NEEDS CA VERIFICATION');
    });

    it('shows another company nothing in its own export', async () => {
      const file = gstr1Export(await getGstr1(ctxB, PERIOD));
      const theirInvoices = (await getGstr1(ctx, PERIOD)).sections.flatMap((s) =>
        s.invoices.map((i) => i.voucherNo),
      );
      const text = allCells(file).join('|');
      for (const voucherNo of theirInvoices) {
        expect(text).not.toContain(voucherNo);
      }
    });

    it('reconciles and exports a portal file without a book match', async () => {
      const bookPurchases = await getBookPurchasesForRecon(ctx, PERIOD);
      const recon = reconcileGstr2b({
        period: '062025',
        portalInvoices: [
          {
            supplierGstin: '36AABCU9603R1ZM',
            supplierName: 'A supplier not in these books',
            invoiceNo: 'NOT-IN-BOOKS/1',
            invoiceDate: '2025-06-20',
            taxablePaise: 10_000_00n,
            tax: { igst: 0n, cgst: 900_00n, sgst: 900_00n, cess: 0n },
            itcAvailable: true,
            itcReason: null,
          },
        ],
        bookPurchases,
      });
      const text = allCells(gstr2bExport(recon, PERIOD, '2025-07-11 09:00:00')).join('|');
      expect(text).toContain('NOT-IN-BOOKS/1');
      expect(text).toContain('Credit unclaimed (in GSTR-2B, not in books)');
    });
  });
});
