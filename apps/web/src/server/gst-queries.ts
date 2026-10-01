import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';
import {
  buildGstr1,
  buildGstr3b,
  type Gstr1Summary,
  type Gstr3bSummary,
  type ReturnSupply,
} from '@/lib/gst/returns';
import { setOffInputTaxCredit, zeroTax, type SetOffResult, type TaxAmounts } from '@/lib/gst/set-off';
import { reconcileGstr2b, type BookPurchase } from '@/lib/gst/gstr2b';
import type { TdsRule } from '@/lib/tds/engine';

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'voucher:read')) throw forbidden('view the returns');
};

/**
 * The supplies a return needs, read from posted vouchers.
 *
 * Credit and debit notes arrive with their amounts negated, so that a return
 * total is net of them by addition rather than by a special case at every point
 * of use. A reversed voucher is excluded along with its reversal, because a
 * return reports what stands, not the history of what was corrected — which is
 * the one place the books and a return legitimately differ in presentation.
 */
async function returnSupplies(
  ctx: RequestContext,
  input: { from: string; to: string; direction: 'outward' | 'inward' },
): Promise<ReturnSupply[]> {
  const types =
    input.direction === 'outward'
      ? (['sales', 'credit_note'] as const)
      : (['purchase', 'debit_note'] as const);
  const noteType = input.direction === 'outward' ? 'credit_note' : 'debit_note';

  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      voucher_id: string;
      voucher_no: string;
      voucher_type: string;
      voucher_date: string;
      party_name: string | null;
      party_gstin: string | null;
      pos: string | null;
      supply_type: string | null;
      taxable: string;
      igst: string;
      cgst: string;
      sgst: string;
      cess: string;
      reverse_charge: boolean;
      lines: unknown;
    }>(sql`
      select v.id as voucher_id, v.voucher_no, v.voucher_type,
             v.voucher_date::text as voucher_date,
             p.name as party_name, p.gstin as party_gstin,
             v.place_of_supply_state_code as pos, v.supply_type,
             v.taxable_paise::text as taxable,
             v.igst_paise::text as igst, v.cgst_paise::text as cgst,
             v.sgst_paise::text as sgst, v.cess_paise::text as cess,
             coalesce(bool_or(l.reverse_charge), false) as reverse_charge,
             coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'hsnSac', l.hsn_sac,
                   'description', l.description,
                   'quantity', l.quantity::text,
                   'unit', l.unit,
                   'taxablePaise', l.taxable_paise::text,
                   'igst', l.igst_paise::text,
                   'cgst', l.cgst_paise::text,
                   'sgst', l.sgst_paise::text,
                   'cess', l.cess_paise::text
                 )
               ) filter (where l.id is not null),
               '[]'::jsonb
             ) as lines
        from vouchers v
        left join parties p on p.id = v.party_id
        left join voucher_lines l on l.voucher_id = v.id
       where v.status = 'posted'
         and v.voucher_type = any(${sql.param([...types])}::text[])
         and v.voucher_date between ${input.from}::date and ${input.to}::date
         and v.reversed_by_voucher_id is null
         and v.reverses_voucher_id is null
       group by v.id, v.voucher_no, v.voucher_type, v.voucher_date, p.name, p.gstin,
                v.place_of_supply_state_code, v.supply_type, v.taxable_paise,
                v.igst_paise, v.cgst_paise, v.sgst_paise, v.cess_paise
       order by v.voucher_date, v.voucher_no
    `);

    return rows.map((r) => {
      // A note reduces the period's figures, so it carries a negative sign.
      const sign = r.voucher_type === noteType ? -1n : 1n;
      const rawLines = Array.isArray(r.lines) ? (r.lines as Record<string, string | null>[]) : [];

      return {
        voucherId: r.voucher_id,
        voucherNo: r.voucher_no,
        voucherType: r.voucher_type as ReturnSupply['voucherType'],
        voucherDate: r.voucher_date,
        partyName: r.party_name,
        partyGstin: r.party_gstin,
        placeOfSupplyStateCode: r.pos,
        supplyType: r.supply_type as ReturnSupply['supplyType'],
        taxablePaise: BigInt(r.taxable) * sign,
        tax: {
          igst: BigInt(r.igst) * sign,
          cgst: BigInt(r.cgst) * sign,
          sgst: BigInt(r.sgst) * sign,
          cess: BigInt(r.cess) * sign,
        },
        reverseCharge: r.reverse_charge,
        hsnLines: rawLines.map((l) => ({
          hsnSac: l.hsnSac ?? null,
          description: l.description ?? '',
          quantity: BigInt(l.quantity ?? '0'),
          unit: l.unit ?? null,
          taxablePaise: BigInt(l.taxablePaise ?? '0') * sign,
          tax: {
            igst: BigInt(l.igst ?? '0') * sign,
            cgst: BigInt(l.cgst ?? '0') * sign,
            sgst: BigInt(l.sgst ?? '0') * sign,
            cess: BigInt(l.cess ?? '0') * sign,
          },
        })),
      };
    });
  });
}

/** A threshold or rate held in the versioned table. */
async function ruleValue(
  ctx: RequestContext,
  input: { kind: string; code: string; onDate: string },
): Promise<{ rateBps: number | null; thresholdPaise: bigint | null; needsCaVerification: boolean } | null> {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      rate_bps: number | null;
      threshold: string | null;
      needs: boolean;
    }>(sql`
      select rate_bps, threshold_single_paise::text as threshold, needs_ca_verification as needs
        from tax_rules
       where kind = ${input.kind} and code = ${input.code}
         and effective_from <= ${input.onDate}::date
         and (effective_to is null or effective_to >= ${input.onDate}::date)
       order by effective_from desc
       limit 1
    `);
    const row = rows[0];
    return row
      ? {
          rateBps: row.rate_bps,
          thresholdPaise: row.threshold === null ? null : BigInt(row.threshold),
          needsCaVerification: row.needs,
        }
      : null;
  });
}

export interface Gstr1View extends Gstr1Summary {
  /** The threshold used, and whether the rule behind it is verified. */
  b2clThresholdPaise: bigint;
  b2clThresholdVerified: boolean;
}

export async function getGstr1(
  ctx: RequestContext,
  input: { from: string; to: string },
): Promise<Gstr1View> {
  guard(ctx);
  const [supplies, threshold] = await Promise.all([
    returnSupplies(ctx, { ...input, direction: 'outward' }),
    ruleValue(ctx, { kind: 'other', code: 'GSTR1_B2CL_THRESHOLD', onDate: input.to }),
  ]);

  const b2clThresholdPaise = threshold?.thresholdPaise ?? 2_50_000_00n;
  const summary = buildGstr1({ ...input, supplies, b2clThresholdPaise });

  return {
    ...summary,
    b2clThresholdPaise,
    b2clThresholdVerified: threshold ? !threshold.needsCaVerification : false,
  };
}

export interface Gstr3bView extends Gstr3bSummary {
  setOff: SetOffResult;
}

/**
 * The GSTR-3B working, with the set-off applied.
 *
 * The set-off is shown step by step rather than as a single payable figure,
 * because the sequence is the part a CA needs to check and a total hides it.
 */
export async function getGstr3b(
  ctx: RequestContext,
  input: { from: string; to: string },
): Promise<Gstr3bView> {
  guard(ctx);
  const [outward, inward] = await Promise.all([
    returnSupplies(ctx, { ...input, direction: 'outward' }),
    returnSupplies(ctx, { ...input, direction: 'inward' }),
  ]);

  const summary = buildGstr3b({ ...input, outward, inward });

  // Credit available includes the reverse-charge tax, which is also a liability;
  // the set-off nets them, which is the correct outcome and why both appear.
  const setOff = setOffInputTaxCredit({
    liability: nonNegative(summary.totalLiability),
    creditAvailable: nonNegative(summary.itcNet),
  });

  return { ...summary, setOff };
}

/**
 * Clamps a negative figure to zero before set-off.
 *
 * A period with more credit notes than invoices can produce a negative
 * liability. That is a refund or a carry-forward question, not a set-off one, and
 * feeding a negative into the set-off engine would produce nonsense — so it is
 * refused there and clamped here, with the real figures still shown above.
 */
function nonNegative(t: TaxAmounts): TaxAmounts {
  const clamp = (v: bigint) => (v > 0n ? v : 0n);
  return { igst: clamp(t.igst), cgst: clamp(t.cgst), sgst: clamp(t.sgst), cess: clamp(t.cess) };
}

/** The purchase register in the shape GSTR-2B reconciliation needs. */
export async function getBookPurchasesForRecon(
  ctx: RequestContext,
  input: { from: string; to: string },
): Promise<BookPurchase[]> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      voucher_id: string;
      voucher_no: string;
      supplier_gstin: string | null;
      supplier_name: string | null;
      supplier_invoice_no: string | null;
      supplier_invoice_date: string | null;
      taxable: string;
      igst: string;
      cgst: string;
      sgst: string;
      cess: string;
    }>(sql`
      select v.id as voucher_id, v.voucher_no, p.gstin as supplier_gstin,
             p.name as supplier_name, v.supplier_invoice_no,
             v.supplier_invoice_date::text as supplier_invoice_date,
             v.taxable_paise::text as taxable, v.igst_paise::text as igst,
             v.cgst_paise::text as cgst, v.sgst_paise::text as sgst,
             v.cess_paise::text as cess
        from vouchers v
        left join parties p on p.id = v.party_id
       where v.status = 'posted'
         and v.voucher_type = 'purchase'
         and v.voucher_date between ${input.from}::date and ${input.to}::date
         and v.reversed_by_voucher_id is null
       order by v.voucher_date
    `);

    return rows.map((r) => ({
      voucherId: r.voucher_id,
      voucherNo: r.voucher_no,
      supplierGstin: r.supplier_gstin,
      supplierName: r.supplier_name,
      supplierInvoiceNo: r.supplier_invoice_no,
      supplierInvoiceDate: r.supplier_invoice_date,
      taxablePaise: BigInt(r.taxable),
      tax: {
        igst: BigInt(r.igst),
        cgst: BigInt(r.cgst),
        sgst: BigInt(r.sgst),
        cess: BigInt(r.cess),
      },
    }));
  });
}

/** The most recent GSTR-2B reconciliation held for a period. */
export async function getStoredGstr2bRecon(
  ctx: RequestContext,
  input: { from: string; to: string },
) {
  guard(ctx);
  const stored = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      period: string | null;
      invoices: unknown;
      created_at: string;
    }>(sql`
      select id, period, invoices, created_at::text as created_at
        from gstr2b_uploads
       where period_from = ${input.from}::date and period_to = ${input.to}::date
       order by created_at desc
       limit 1
    `);
    return rows[0] ?? null;
  });

  if (!stored) return null;

  const bookPurchases = await getBookPurchasesForRecon(ctx, input);
  const portalInvoices = (Array.isArray(stored.invoices) ? stored.invoices : []).map(
    (raw) => {
      const i = raw as Record<string, string | boolean | null>;
      return {
        supplierGstin: String(i.supplierGstin ?? ''),
        supplierName: (i.supplierName as string | null) ?? null,
        invoiceNo: String(i.invoiceNo ?? ''),
        invoiceDate: String(i.invoiceDate ?? ''),
        taxablePaise: BigInt(String(i.taxablePaise ?? '0')),
        tax: {
          igst: BigInt(String(i.igst ?? '0')),
          cgst: BigInt(String(i.cgst ?? '0')),
          sgst: BigInt(String(i.sgst ?? '0')),
          cess: BigInt(String(i.cess ?? '0')),
        },
        itcAvailable: i.itcAvailable !== false,
        itcReason: (i.itcReason as string | null) ?? null,
      };
    },
  );

  return {
    uploadedAt: stored.created_at,
    reconciliation: reconcileGstr2b({
      period: stored.period,
      portalInvoices,
      bookPurchases,
    }),
  };
}

/** The TDS rules in force, as the engine needs them. */
/**
 * Every TDS rule, in every version.
 *
 * All of them, not only those in force today: the engine picks the version that
 * applied on the payment's own date, so a payment being entered late must still
 * be able to reach a rule that has since been superseded.
 */
export async function getTdsRules(ctx: RequestContext): Promise<TdsRule[]> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      code: string;
      label: string;
      rate_bps: number | null;
      single: string | null;
      annual: string | null;
      section: string | null;
      effective_from: string;
      effective_to: string | null;
      needs: boolean;
      source_note: string | null;
    }>(sql`
      select code, label, rate_bps,
             threshold_single_paise::text as single,
             threshold_annual_paise::text as annual,
             section, effective_from::text as effective_from,
             effective_to::text as effective_to,
             needs_ca_verification as needs, source_note
        from tax_rules
       where kind = 'tds_section'
       order by section, effective_from desc
    `);

    return rows
      .filter((r) => r.rate_bps !== null)
      .map((r) => ({
        // The engine matches on section; the code distinguishes variants within
        // one section, which the label carries for a person to choose between.
        section: r.code,
        label: `${r.section ?? r.code} — ${r.label}`,
        rateBps: r.rate_bps!,
        thresholdSinglePaise: r.single === null ? null : BigInt(r.single),
        thresholdAnnualPaise: r.annual === null ? null : BigInt(r.annual),
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        needsCaVerification: r.needs,
        sourceNote: r.source_note,
      }));
  });
}

export interface TdsPayableRow {
  accountCode: string;
  accountName: string;
  balancePaise: bigint;
}

/** What has been deducted and not yet paid over. */
export async function getTdsPayable(
  ctx: RequestContext,
  asOf: string,
): Promise<{ rows: TdsPayableRow[]; totalPaise: bigint }> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{ code: string; name: string; net: string }>(sql`
      select a.code, a.name,
             coalesce(sum(l.credit_paise - l.debit_paise), 0)::text as net
        from accounts a
        left join ledger_entries l on l.account_id = a.id and l.entry_date <= ${asOf}::date
        left join vouchers v on v.id = l.voucher_id and v.status = 'posted'
       where a.code in ('TDS_PAYABLE', 'TDS_RECEIVABLE')
         and (l.id is null or v.id is not null)
       group by a.code, a.name
       order by a.code
    `);

    const mapped = rows.map((r) => ({
      accountCode: r.code,
      accountName: r.name,
      balancePaise: BigInt(r.net),
    }));

    return {
      rows: mapped,
      totalPaise: mapped
        .filter((r) => r.accountCode === 'TDS_PAYABLE')
        .reduce((acc, r) => acc + r.balancePaise, 0n),
    };
  });
}

/** Every tax rule, for the page that shows what still needs verifying. */
export async function getTaxRuleStatus(ctx: RequestContext) {
  if (!can(ctx.role, 'taxrule:read')) throw forbidden('view tax rules');
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      kind: string;
      code: string;
      label: string;
      rate_bps: number | null;
      section: string | null;
      effective_from: string;
      effective_to: string | null;
      needs: boolean;
      verified_by: string | null;
      verified_at: string | null;
      source_note: string | null;
      is_own: boolean;
    }>(sql`
      select id, kind, code, label, rate_bps, section,
             effective_from::text as effective_from, effective_to::text as effective_to,
             needs_ca_verification as needs, verified_by, verified_at::text as verified_at,
             source_note, (org_id is not null) as is_own
        from tax_rules
       order by needs_ca_verification desc, kind, code
    `);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      code: r.code,
      label: r.label,
      rateBps: r.rate_bps,
      section: r.section,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      needsCaVerification: r.needs,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at,
      sourceNote: r.source_note,
      /** A product-wide rule cannot be signed off by one company. */
      isOwnRule: r.is_own,
    }));
  });
}

export const emptyTax = zeroTax;
