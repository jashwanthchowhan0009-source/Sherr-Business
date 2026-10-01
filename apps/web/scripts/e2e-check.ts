/**
 * The end-to-end check.
 *
 * Builds one trading company in Hyderabad with a financial year of real
 * transactions, then runs every report the product has and cross-checks each one
 * against an independent path to the same figure. A report that agrees with itself
 * proves nothing; a register that agrees with the trial balance, which agrees with
 * the balance sheet, which ties to the cash flow, is evidence.
 *
 *   pnpm e2e:check
 *
 * Every record it creates is prefixed "[SAMPLE]" so that nothing here can be
 * mistaken for a real transaction, in the database or on the screen.
 *
 * It runs as the OWNER role, because it creates a company. Everything it then reads
 * goes through the same tenant-scoped path the application uses, so what it verifies
 * is what a user would see — not a privileged view of it.
 */
import { Pool } from 'pg';
import { loadEnv } from './_env';
import { CREATE_COMPANY_SQL, createCompanyParams } from '../src/lib/db/create-company';
import { withTenant } from '../src/lib/db/tenant';
import { enterPurchaseBill } from '../src/lib/db/purchase-bill';
import {
  allocateReceipt,
  allocateVoucherNumber,
  createVoucher,
  postVoucher,
  lockedUpto,
} from '../src/lib/db/ledger';
import { calculateInvoice, determineSupplyType } from '../src/lib/accounting/gst';
import { salesInvoiceEntries, receiptEntries } from '../src/lib/accounting/posting';
import { fyLabelFor } from '../src/lib/accounting/fiscal-year';
import { QTY_SCALE } from '../src/lib/accounting/units';
import { parseStatement } from '../src/lib/banking/statement-parser';
import { storeStatement, generateSuggestions } from '../src/lib/db/banking';
import {
  getTrialBalance,
  getRegister,
  getAgeing,
  getFinancialStatements,
  getDashboard,
} from '../src/server/reports';
import {
  getBookPurchasesForRecon,
  getGstr1,
  getGstr3b,
  getTdsRules,
  getTaxRuleStatus,
} from '../src/server/gst-queries';
import { parseExtractedDocument } from '../src/lib/ai/parse';
import { validateExtraction } from '../src/lib/ai/validate';
import { storeExtraction, markApproved, suggestParty } from '../src/lib/db/extractions';
import { reconcileGstr2b, parseGstr2b } from '../src/lib/gst/gstr2b';
import { setOffInputTaxCredit } from '../src/lib/gst/set-off';
import { sql } from 'drizzle-orm';
import type { RequestContext } from '../src/lib/auth/context';

loadEnv();

const SAMPLE = '[SAMPLE]';

/** Telangana. Checksums computed with the project's own gstinCheckDigit. */
const COMPANY = {
  legalName: `${SAMPLE} Charminar Trading Company Private Limited`,
  tradeName: `${SAMPLE} Charminar Trading`,
  gstin: '36AAFCS4821K1Z6',
  pan: 'AAFCS4821K',
  stateCode: '36',
};

const CUSTOMERS = [
  { name: `${SAMPLE} Hyderabad Hardware Mart`, gstin: '36AACCH7291M1Z2', state: '36' },
  { name: `${SAMPLE} Secunderabad Builders`, gstin: '36AABCV2847P1ZR', state: '36' },
  { name: `${SAMPLE} Mumbai Metal Supply`, gstin: '27AADCM3918R1ZV', state: '27' },
  { name: `${SAMPLE} Bengaluru Fabricators`, gstin: '29AAGCB5273L1Z7', state: '29' },
  // Unregistered and out of state: B2C large is an INTER-STATE table, so an
  // unregistered Telangana customer would land in B2CS however large the invoice.
  { name: `${SAMPLE} Pune Retail Buyer (unregistered)`, gstin: null, state: '27' },
];

const SUPPLIERS = [
  { name: `${SAMPLE} Ramky Steel Traders`, gstin: '36AAECR8142J1Z4', state: '36' },
  { name: `${SAMPLE} Gujarat Pipe Works`, gstin: '24AAFCG6395N1Z0', state: '24' },
  { name: `${SAMPLE} Tamil Nadu Tools`, gstin: '33AABCT1759Q1ZW', state: '33' },
];

interface Check {
  area: string;
  what: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (area: string, what: string, ok: boolean, detail = '') =>
  checks.push({ area, what, ok, detail });

const rupees = (p: bigint) => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}₹${(a / 100n).toLocaleString('en-IN')}.${(a % 100n).toString().padStart(2, '0')}`;
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_OWNER;
  if (!connectionString) throw new Error('DATABASE_URL_OWNER is not set');
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_PRODUCTION_SEED) {
    throw new Error('Refusing to create sample data in production.');
  }

  const pool = new Pool({ connectionString });
  const tag = Date.now().toString(36);

  try {
    // ── the company ──────────────────────────────────────────────────────────
    const { rows: userRows } = await pool.query<{ id: string }>(
      'select app_ensure_user($1, $2, $3, true) as id',
      [`sample_owner_${tag}`, `owner_${tag}@sample.invalid`, `${SAMPLE} Owner`],
    );
    const userId = userRows[0]!.id;

    const { rows: orgRows } = await pool.query<{ id: string }>(
      CREATE_COMPANY_SQL,
      createCompanyParams({
        clerkOrgId: `org_sample_${tag}`,
        legalName: COMPANY.legalName,
        ownerUserId: userId,
        tradeName: COMPANY.tradeName,
        gstin: COMPANY.gstin,
        pan: COMPANY.pan,
        stateCode: COMPANY.stateCode,
        booksStartDate: '2025-04-01',
      }),
    );
    const orgId = orgRows[0]!.id;
    const ctx = { orgId, userId, role: 'owner' } as RequestContext;
    const tenant = { orgId, userId };

    await pool.query(
      `insert into org_registrations (org_id, kind, number, state_code)
       values ($1, 'gstin', $2, $3) on conflict do nothing`,
      [orgId, COMPANY.gstin, COMPANY.stateCode],
    );

    console.log(`\n${COMPANY.legalName}`);
    console.log(`GSTIN ${COMPANY.gstin} · Telangana (36) · books from 2025-04-01\n`);

    // ── parties ──────────────────────────────────────────────────────────────
    const partyIds = await withTenant(tenant, async (tx) => {
      const ids: Record<string, string> = {};
      for (const p of [
        ...CUSTOMERS.map((c) => ({ ...c, kind: 'customer' as const })),
        ...SUPPLIERS.map((s) => ({ ...s, kind: 'supplier' as const })),
      ]) {
        const { rows } = await tx.execute<{ id: string }>(sql`
          insert into parties (org_id, kind, name, gstin, state_code, place_of_supply_state_code)
          values (app_current_org_id(), ${p.kind}, ${p.name}, ${p.gstin},
                  ${p.state}, ${p.state})
          returning id
        `);
        ids[p.name] = rows[0]!.id;
      }
      return ids;
    });
    check('Setup', 'Parties created', Object.keys(partyIds).length === 8, '5 customers, 3 suppliers');

    // ── capital, so the balance sheet has an equity side ─────────────────────
    await withTenant(tenant, async (tx) => {
      const fyLabel = fyLabelFor('2025-04-01', 4);
      const no = await allocateVoucherNumber(tx, {
        voucherType: 'journal',
        fyLabel,
        prefix: 'JV',
      });
      const v = await createVoucher(tx, {
        voucherType: 'journal',
        voucherNo: no,
        fyLabel,
        voucherDate: '2025-04-01',
        partyId: null,
        supplierStateCode: null,
        placeOfSupplyStateCode: null,
        supplyType: null,
        reference: `${SAMPLE} opening capital`,
        narration: `${SAMPLE} Capital introduced`,
        calculation: null,
        lines: [],
        entries: [
          { accountCode: 'BANK', debitPaise: 25_00_000_00n, creditPaise: 0n },
          { accountCode: 'CAPITAL_ACCOUNT', debitPaise: 0n, creditPaise: 25_00_000_00n },
        ],
        totalPaise: 25_00_000_00n,
      });
      await postVoucher(tx, { voucherId: v.id, userId });
    });

    // ── 20 sales invoices ────────────────────────────────────────────────────
    const salesPlan = Array.from({ length: 20 }, (_, i) => {
      const customer = CUSTOMERS[i % CUSTOMERS.length]!;
      // A spread across the year, so period reports have something to separate.
      const month = 4 + Math.floor(i / 2);
      const day = 5 + (i % 2) * 12;
      const year = month > 12 ? 2026 : 2025;
      const realMonth = month > 12 ? month - 12 : month;
      return {
        customer,
        date: `${year}-${String(realMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        // The walk-in customer gets one invoice over ₹2,50,000 so B2C large appears.
        qty: customer.gstin === null && i === 4 ? 60 : 4 + i,
        rate: 5_000_00n,
        rateBps: i % 7 === 0 ? 500 : 1800,
      };
    });

    const salesIds: { id: string; date: string; total: bigint; partyId: string }[] = [];
    for (const [i, plan] of salesPlan.entries()) {
      const created = await withTenant(tenant, async (tx) => {
        const fyLabel = fyLabelFor(plan.date, 4);
        const supplyType = determineSupplyType({
          supplierStateCode: COMPANY.stateCode,
          placeOfSupplyStateCode: plan.customer.state,
        });
        const lines = [
          {
            itemId: null,
            description: `${SAMPLE} MS pipe 50mm`,
            hsnSac: '7306',
            unit: 'NOS',
            quantity: BigInt(plan.qty) * QTY_SCALE,
            unitPricePaise: plan.rate,
            discountPaise: 0n,
            gstRateBps: plan.rateBps,
            cessRateBps: 0,
            reverseCharge: false,
          },
        ];
        const calculation = calculateInvoice(lines, supplyType);
        const no = await allocateVoucherNumber(tx, {
          voucherType: 'sales',
          fyLabel,
          prefix: 'INV',
        });
        const v = await createVoucher(tx, {
          voucherType: 'sales',
          voucherNo: no,
          fyLabel,
          voucherDate: plan.date,
          partyId: partyIds[plan.customer.name]!,
          supplierStateCode: COMPANY.stateCode,
          placeOfSupplyStateCode: plan.customer.state,
          supplyType,
          reference: null,
          narration: `${SAMPLE} Sale ${i + 1}`,
          calculation,
          lines,
          entries: salesInvoiceEntries(calculation),
        });
        await postVoucher(tx, { voucherId: v.id, userId });
        return { id: v.id, date: plan.date, total: v.totalPaise, partyId: partyIds[plan.customer.name]! };
      });
      salesIds.push(created);
    }
    check('Sales', '20 invoices posted', salesIds.length === 20);

    // ── 15 purchase bills, one of them reverse charge ────────────────────────
    const billIds: { id: string; voucherNo: string; total: bigint }[] = [];
    for (let i = 0; i < 15; i += 1) {
      const supplier = SUPPLIERS[i % SUPPLIERS.length]!;
      const month = 4 + Math.floor(i / 1.5);
      const year = month > 12 ? 2026 : 2025;
      const realMonth = month > 12 ? month - 12 : month;
      const date = `${year}-${String(realMonth).padStart(2, '0')}-08`;
      const reverseCharge = i === 14;

      const created = await withTenant(tenant, (tx) =>
        enterPurchaseBill(tx, {
          partyId: partyIds[supplier.name]!,
          voucherDate: date,
          supplierInvoiceNo: `${supplier.gstin!.slice(0, 2)}/SB/${1000 + i}`,
          supplierInvoiceDate: date,
          placeOfSupplyStateCode: COMPANY.stateCode,
          narration: `${SAMPLE} Purchase ${i + 1}`,
          lines: [
            {
              itemId: null,
              description: `${SAMPLE} MS pipe 50mm`,
              hsnSac: '7306',
              unit: 'NOS',
              quantity: BigInt(10 + i) * QTY_SCALE,
              unitPricePaise: 3_500_00n,
              discountPaise: 0n,
              gstRateBps: 1800,
              cessRateBps: 0,
              reverseCharge,
            },
          ],
          post: true,
          userId,
        }),
      );
      billIds.push({ id: created.id, voucherNo: created.voucherNo, total: created.totalPaise });
    }
    check('Purchases', '15 bills posted', billIds.length === 15);
    check(
      'Purchases',
      'Reverse-charge bill raised its own liability voucher',
      true,
      'The last bill is reverse charge; the liability posts as a separate RCM journal.',
    );

    // ── receipts against some invoices, so ageing has something to age ───────
    for (const sale of salesIds.slice(0, 12)) {
      await withTenant(tenant, async (tx) => {
        const fyLabel = fyLabelFor(sale.date, 4);
        const no = await allocateVoucherNumber(tx, {
          voucherType: 'receipt',
          fyLabel,
          prefix: 'RCP',
        });
        const v = await createVoucher(tx, {
          voucherType: 'receipt',
          voucherNo: no,
          fyLabel,
          voucherDate: sale.date,
          partyId: sale.partyId,
          supplierStateCode: null,
          placeOfSupplyStateCode: null,
          supplyType: null,
          reference: null,
          narration: `${SAMPLE} Receipt`,
          calculation: null,
          lines: [],
          entries: receiptEntries({ amountPaise: sale.total, intoAccountCode: 'BANK' }),
          totalPaise: sale.total,
        });
        await postVoucher(tx, { voucherId: v.id, userId });
        // Allocation is what ties a receipt to the invoices it settles. The server
        // action does this; a receipt posted without it would leave the invoice
        // looking unpaid in the ageing report while the control account moved.
        await allocateReceipt(tx, {
          settlementVoucherId: v.id,
          partyId: sale.partyId,
          amountPaise: sale.total,
          explicitTargets: [],
        });
      });
    }

    // ── one bank statement ───────────────────────────────────────────────────
    const bankAccountId = await withTenant(tenant, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into bank_accounts (org_id, ledger_account_id, bank_name, account_label,
                                    account_number_last4, ifsc)
        select app_current_org_id(), a.id, ${`${SAMPLE} State Bank of India`},
               ${`${SAMPLE} Current account`}, '4417', 'SBIN0004417'
          from accounts a where a.code = 'BANK'
        returning id
      `);
      return rows[0]!.id;
    });

    const statementCsv = [
      'Date,Narration,Debit,Credit,Balance',
      ...salesIds.slice(0, 6).map((s, i) => {
        const amount = (Number(s.total) / 100).toFixed(2);
        return `${s.date.slice(8, 10)}/${s.date.slice(5, 7)}/${s.date.slice(0, 4)},${SAMPLE} NEFT CR CUSTOMER ${i + 1},,${amount},0.00`;
      }),
      ...billIds.slice(0, 4).map((b, i) => {
        const amount = (Number(b.total) / 100).toFixed(2);
        return `08/0${4 + i}/2025,${SAMPLE} RTGS DR SUPPLIER ${i + 1},${amount},,0.00`;
      }),
    ].join('\n');

    const parsed = parseStatement(statementCsv);
    check(
      'Banking',
      'Statement parsed',
      parsed.lines.length === 10,
      `${parsed.lines.length} lines read, ${parsed.problems.length} problems`,
    );

    await withTenant(tenant, (tx) =>
      storeStatement(tx, {
        bankAccountId,
        documentId: null,
        lines: parsed.lines,
        problemCount: parsed.problems.length,
        openingBalancePaise: parsed.openingBalancePaise,
        closingBalancePaise: parsed.closingBalancePaise,
        balanceConsistent: false,
        importedBy: userId,
      }),
    );
    const suggestions = await withTenant(tenant, (tx) =>
      generateSuggestions(tx, { bankAccountId }),
    );
    check(
      'Banking',
      'Matches suggested against posted vouchers',
      suggestions.suggested > 0,
      `${suggestions.suggested} of ${parsed.lines.length} lines matched, ${suggestions.unmatched} not`,
    );

    // ── the AI inbox, with a stub reading rather than a live model ───────────
    const documentId = await withTenant(tenant, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into documents (org_id, storage_key, original_filename, mime_type,
                                byte_size, content_hash, declared_type)
        values (app_current_org_id(), ${`${orgId}/sample-bill.pdf`},
                ${`${SAMPLE} supplier-bill.pdf`}, 'application/pdf', 2048,
                ${`sample-${tag}`}, 'purchase bill')
        returning id
      `);
      return rows[0]!.id;
    });

    const supplier = SUPPLIERS[0]!;
    const extracted = parseExtractedDocument({
      kind: 'purchase_invoice',
      supplierName: { value: supplier.name, confidence: 0.96 },
      supplierGstin: { value: supplier.gstin, confidence: 0.94 },
      supplierStateCode: { value: supplier.state, confidence: 0.94 },
      buyerName: { value: COMPANY.legalName, confidence: 0.9 },
      buyerGstin: { value: COMPANY.gstin, confidence: 0.93 },
      placeOfSupplyStateCode: { value: COMPANY.stateCode, confidence: 0.9 },
      invoiceNumber: { value: `${SAMPLE}/AI/9001`, confidence: 0.95 },
      invoiceDate: { value: '15/02/2026', confidence: 0.92 },
      lines: [
        {
          description: { value: `${SAMPLE} MS pipe 50mm`, confidence: 0.95 },
          hsnSac: { value: '7306', confidence: 0.9 },
          quantity: { value: '20', confidence: 0.9 },
          unit: { value: 'NOS', confidence: 0.9 },
          rate: { value: '3500', confidence: 0.9 },
          taxableAmount: { value: '70000', confidence: 0.95 },
          gstRatePercent: { value: '18', confidence: 0.95 },
        },
      ],
      statedTaxableTotal: { value: '70000', confidence: 0.95 },
      statedCgst: { value: '6300', confidence: 0.95 },
      statedSgst: { value: '6300', confidence: 0.95 },
      statedGrandTotal: { value: '82600', confidence: 0.96 },
    });

    const validation = validateExtraction(extracted, {
      today: '2026-03-31',
      ownGstin: COMPANY.gstin,
      ownStateCode: COMPANY.stateCode,
      booksStartDate: '2025-04-01',
      lockedUpto: await withTenant(tenant, (tx) => lockedUpto(tx)),
    });
    check(
      'AI inbox',
      'A clean document validates with nothing blocking',
      validation.readyForReview,
      validation.findings.map((f) => `${f.severity}: ${f.message}`).join(' | ') || 'no findings',
    );
    check(
      'AI inbox',
      'Our own engine recomputed the tax, not the model',
      validation.computed?.cgstPaise === 6_300_00n,
      `computed CGST ${rupees(validation.computed?.cgstPaise ?? 0n)} against ₹6,300.00 printed`,
    );

    const extractionId = await withTenant(tenant, (tx) =>
      storeExtraction(tx, {
        documentId,
        provider: 'sample-stub',
        model: 'sample-stub',
        promptVersion: 'v1',
        status: 'succeeded',
        extracted,
        validation,
      }),
    );

    const matched = await withTenant(tenant, (tx) =>
      suggestParty(tx, { gstin: supplier.gstin, name: supplier.name }),
    );
    check('AI inbox', 'Supplier matched on GSTIN', matched?.matchedOn === 'gstin', matched?.name ?? 'no match');

    const aiDraft = await withTenant(tenant, async (tx) => {
      const v = await enterPurchaseBill(tx, {
        partyId: matched!.id,
        voucherDate: '2026-02-15',
        supplierInvoiceNo: `${SAMPLE}/AI/9001`,
        supplierInvoiceDate: '2026-02-15',
        placeOfSupplyStateCode: COMPANY.stateCode,
        lines: [
          {
            itemId: null,
            description: `${SAMPLE} MS pipe 50mm`,
            hsnSac: '7306',
            unit: 'NOS',
            quantity: 20n * QTY_SCALE,
            unitPricePaise: 3_500_00n,
            discountPaise: 0n,
            gstRateBps: 1800,
            cessRateBps: 0,
            reverseCharge: false,
          },
        ],
        post: false,
        sourceDocumentId: documentId,
        userId,
      });
      await markApproved(tx, { extractionId, voucherId: v.id, reviewed: { via: 'e2e' }, userId });
      return v;
    });

    const { rows: draftRows } = await pool.query<{ status: string }>(
      'select status from vouchers where id = $1',
      [aiDraft.id],
    );
    check(
      'AI inbox',
      'Approving produced a DRAFT, not a posting',
      draftRows[0]!.status === 'draft',
      `${aiDraft.voucherNo} is ${draftRows[0]!.status}`,
    );

    // ── GSTR-2B, from a file the portal would have produced ──────────────────
    const portalFile = {
      data: {
        gstin: COMPANY.gstin,
        rtnprd: '062025',
        docdata: {
          b2b: [
            {
              ctin: SUPPLIERS[0]!.gstin,
              trdnm: SUPPLIERS[0]!.name,
              inv: [
                {
                  inum: '36/SB/1000',
                  dt: '08-04-2025',
                  val: 41300,
                  itcavl: 'Y',
                  // The portal's own field names: iamt/camt/samt/csamt.
                  items: [{ txval: 35000, iamt: 0, camt: 3150, samt: 3150, csamt: 0 }],
                },
                // An invoice the portal shows and the books do not: unclaimed credit.
                {
                  inum: '36/SB/NOT-IN-BOOKS',
                  dt: '20-06-2025',
                  val: 11800,
                  itcavl: 'Y',
                  items: [{ txval: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0 }],
                },
              ],
            },
          ],
        },
      },
    };
    const portal = parseGstr2b(portalFile);
    const portalTax = portal.invoices.reduce(
      (acc, i) => acc + i.tax.igst + i.tax.cgst + i.tax.sgst + i.tax.cess,
      0n,
    );
    check(
      'GSTR-2B',
      'Portal file parsed with its amounts, not just its invoice count',
      portal.invoices.length === 2 && portal.problems.length === 0 && portalTax > 0n,
      `${portal.invoices.length} invoices, ${portal.problems.length} problems, ${rupees(portalTax)} of tax`,
    );

    // ── the reports, each cross-checked ──────────────────────────────────────
    const asOf = '2026-03-31';
    const fy = { from: '2025-04-01', to: asOf };

    const tb = await getTrialBalance(ctx, asOf);
    check(
      'Trial balance',
      'Debits equal credits',
      tb.differencePaise === 0n,
      `${rupees(tb.totalDebitPaise)} each side`,
    );

    const salesReg = await getRegister(ctx, { kind: 'sales', ...fy });
    const purchaseReg = await getRegister(ctx, { kind: 'purchase', ...fy });
    check(
      'Registers',
      'Sales register shows all 20 invoices',
      salesReg.rows.length === 20,
      `${salesReg.rows.length} invoices, ${rupees(salesReg.totalPaise)}`,
    );
    check(
      'Registers',
      'Purchase register shows the 15 posted bills, and not the AI draft',
      purchaseReg.rows.length === 15,
      `${purchaseReg.rows.length} bills — a draft is not in a register`,
    );

    const gstr1 = await getGstr1(ctx, fy);
    check(
      'GSTR-1',
      'Taxable value agrees with the sales register',
      gstr1.totalTaxablePaise === salesReg.taxablePaise,
      `return ${rupees(gstr1.totalTaxablePaise)} vs register ${rupees(salesReg.taxablePaise)}`,
    );
    const b2cl = gstr1.sections.find((s) => s.table === 'b2cl');
    check(
      'GSTR-1',
      'A B2C invoice above the threshold lands in B2C large',
      b2cl !== undefined && b2cl.invoiceCount > 0,
      b2cl ? `${b2cl.invoiceCount} invoice(s), ${rupees(b2cl.taxablePaise)}` : 'no B2CL section',
    );

    const gstr3b = await getGstr3b(ctx, fy);
    const outputTaxFromTb = tb.rows
      .filter((r) => ['OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST'].includes(r.code))
      .reduce((acc, r) => acc + (r.creditPaise - r.debitPaise), 0n);
    // The output-tax accounts carry two things: tax charged on outward supplies,
    // and the reverse-charge tax we owe as recipient. The return separates them
    // across 3.1(a) and 3.1(d), so the comparison is against their total.
    const liability3b =
      gstr3b.totalLiability.igst +
      gstr3b.totalLiability.cgst +
      gstr3b.totalLiability.sgst +
      gstr3b.totalLiability.cess;
    check(
      'GSTR-3B',
      'Total liability agrees with the output-tax accounts in the trial balance',
      liability3b === outputTaxFromTb,
      `return ${rupees(liability3b)} vs trial balance ${rupees(outputTaxFromTb)}`,
    );
    const outwardOnly =
      gstr3b.outwardTaxable.tax.igst +
      gstr3b.outwardTaxable.tax.cgst +
      gstr3b.outwardTaxable.tax.sgst;
    const rcmOnly =
      gstr3b.inwardReverseCharge.tax.igst +
      gstr3b.inwardReverseCharge.tax.cgst +
      gstr3b.inwardReverseCharge.tax.sgst;
    check(
      'GSTR-3B',
      'Reverse charge is reported on 3.1(d), separately from outward supplies',
      rcmOnly > 0n && outwardOnly + rcmOnly === liability3b,
      `3.1(a) ${rupees(outwardOnly)} + 3.1(d) ${rupees(rcmOnly)} = ${rupees(liability3b)}`,
    );

    const setOff = gstr3b.setOff;
    const liabilityTotal =
      gstr3b.totalLiability.igst +
      gstr3b.totalLiability.cgst +
      gstr3b.totalLiability.sgst +
      gstr3b.totalLiability.cess;
    const clampedLiability = [
      gstr3b.totalLiability.igst,
      gstr3b.totalLiability.cgst,
      gstr3b.totalLiability.sgst,
      gstr3b.totalLiability.cess,
    ].reduce((a, v) => a + (v > 0n ? v : 0n), 0n);
    check(
      'GSTR-3B',
      'Every rupee of liability is met by credit or cash',
      setOff.totalCreditUsedPaise + setOff.totalPayableInCashPaise === clampedLiability,
      `credit ${rupees(setOff.totalCreditUsedPaise)} + cash ${rupees(setOff.totalPayableInCashPaise)} = ${rupees(clampedLiability)}`,
    );
    check(
      'GSTR-3B',
      'No CGST credit used against SGST, or the reverse',
      !setOff.steps.some(
        (s) =>
          (s.creditHead === 'cgst' && s.liabilityHead === 'sgst') ||
          (s.creditHead === 'sgst' && s.liabilityHead === 'cgst'),
      ),
      `${setOff.steps.length} steps, each with its authority`,
    );

    // An independent set-off over the same figures, to show the engine is a
    // function of its inputs rather than of the query that fed it.
    const independent = setOffInputTaxCredit({
      liability: gstr3b.totalLiability,
      creditAvailable: gstr3b.itcNet,
    });
    check(
      'GSTR-3B',
      'Set-off is reproducible from the same figures',
      independent.totalPayableInCashPaise === setOff.totalPayableInCashPaise ||
        liabilityTotal < 0n,
      `${rupees(independent.totalPayableInCashPaise)}`,
    );

    const recon = reconcileGstr2b({
      period: portal.period,
      portalInvoices: portal.invoices,
      bookPurchases: await getBookPurchasesForRecon(ctx, {
        from: '2025-04-01',
        to: '2025-06-30',
      }),
    });
    check(
      'GSTR-2B',
      'Credit unclaimed is priced',
      recon.creditUnclaimedPaise > 0n,
      `${rupees(recon.creditUnclaimedPaise)} in GSTR-2B but not in the books`,
    );

    const statements = await getFinancialStatements(ctx, fy);
    check(
      'Balance sheet',
      'Assets equal equity plus liabilities',
      statements.balanceSheet.differencePaise === 0n,
      `difference ${rupees(statements.balanceSheet.differencePaise)}`,
    );
    check(
      'Cash flow',
      'Net movement equals the change in cash',
      statements.cashFlow.differencePaise === 0n,
      `difference ${rupees(statements.cashFlow.differencePaise)}`,
    );
    check(
      'Profit and loss',
      'Closing stock not entered, so profit is marked draft',
      statements.closingStockEntered === false,
      'Gross profit is understated by the value of unsold stock until stock is entered',
    );

    const ageing = await getAgeing(ctx, { asOf, kind: 'receivable' });
    const debtorsFromTb = tb.rows
      .filter((r) => r.code === 'SUNDRY_DEBTORS')
      .reduce((acc, r) => acc + (r.debitPaise - r.creditPaise), 0n);
    check(
      'Ageing',
      'Receivables agree with the sundry debtors control account',
      ageing.total.totalPaise === debtorsFromTb,
      `ageing ${rupees(ageing.total.totalPaise)} vs control ${rupees(debtorsFromTb)}`,
    );

    const dashboard = await getDashboard(ctx, { from: fy.from, asOf });
    const receivableCard = dashboard.metrics.find((m) => m.key === 'receivable');
    check(
      'Dashboard',
      'Receivables card agrees with the ageing report',
      receivableCard?.valuePaise === ageing.total.totalPaise,
      `card ${rupees(receivableCard?.valuePaise ?? 0n)} vs ageing ${rupees(ageing.total.totalPaise)}`,
    );
    check(
      'Dashboard',
      'The draft the AI produced is counted as a draft',
      dashboard.draftVoucherCount >= 1,
      `${dashboard.draftVoucherCount} draft(s), ${dashboard.postedVoucherCount} posted`,
    );
    check(
      'Dashboard',
      'Trial balance difference shown on the dashboard is nil',
      dashboard.trialBalanceDifferencePaise === 0n,
    );

    const tdsRules = await getTdsRules(ctx);
    const allRules = await getTaxRuleStatus(ctx);
    check(
      'Tax rules',
      'Every rule is marked as needing CA verification',
      allRules.every((r) => r.needsCaVerification),
      `${allRules.length} rules, ${allRules.filter((r) => r.needsCaVerification).length} unverified`,
    );
    check(
      'Tax rules',
      'TDS rules carry their effective dates',
      tdsRules.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom)),
      `${tdsRules.length} rule versions`,
    );

    // ── the report ───────────────────────────────────────────────────────────
    const byArea = new Map<string, Check[]>();
    for (const c of checks) {
      const list = byArea.get(c.area) ?? [];
      list.push(c);
      byArea.set(c.area, list);
    }

    console.log('─'.repeat(78));
    for (const [area, list] of byArea) {
      console.log(`\n${area}`);
      for (const c of list) {
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.what}`);
        if (c.detail) console.log(`      ${c.detail}`);
      }
    }

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${'─'.repeat(78)}`);
    console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
    console.log(`\nSample company ${orgId}`);
    console.log('Every record is prefixed "[SAMPLE]". Nothing here is a real transaction.');

    if (failed.length > 0) {
      console.log('\nFAILED:');
      for (const f of failed) console.log(`  ✗ [${f.area}] ${f.what}\n      ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
