import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Tx } from './tenant';
import { organizations, parties } from './schema';
import { allocateVoucherNumber, createVoucher, findDuplicateBill, postVoucher } from './ledger';
import { calculateInvoice, determineSupplyType } from '@/lib/accounting/gst';
import { purchaseBillEntries, reverseChargeLiabilityEntries } from '@/lib/accounting/posting';
import { fyLabelFor } from '@/lib/accounting/fiscal-year';
import { conflict, invalidInput, notFound } from '@/lib/errors';

/**
 * Entering a purchase bill, once.
 *
 * Two callers reach this: the form on the Process page, and approving a document
 * the AI read. They must produce the same voucher from the same figures — a bill
 * entered by hand and the same bill approved from its PDF cannot differ — so the
 * duplicate check, the supply-type decision, the tax computation and the
 * reverse-charge liability live here rather than in either caller.
 *
 * It creates and optionally posts. `post: false` leaves a draft, which is what the
 * AI path always asks for: a person posts it afterwards, deliberately.
 */
export interface PurchaseBillLine {
  itemId: string | null;
  description: string;
  hsnSac: string | null;
  unit: string | null;
  quantity: bigint;
  unitPricePaise: bigint;
  discountPaise: bigint;
  gstRateBps: number;
  cessRateBps: number;
  reverseCharge: boolean;
}

export interface EnterPurchaseBillInput {
  partyId: string;
  voucherDate: string;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  placeOfSupplyStateCode?: string | null;
  narration?: string | null;
  lines: readonly PurchaseBillLine[];
  post: boolean;
  poId?: string | null;
  grnId?: string | null;
  /** The document this bill was read from, so the voucher traces back to it. */
  sourceDocumentId?: string | null;
  userId: string;
}

export interface EnteredPurchaseBill {
  id: string;
  voucherNo: string;
  totalPaise: bigint;
  taxablePaise: bigint;
  supplyType: 'intra_state' | 'inter_state' | 'zero_rated' | 'exempt';
  partyName: string;
  posted: boolean;
  reverseChargeVoucherNo: string | null;
}

export async function enterPurchaseBill(
  tx: Tx,
  input: EnterPurchaseBillInput,
): Promise<EnteredPurchaseBill> {
  const [company] = await tx
    .select({ stateCode: organizations.stateCode, fyStartMonth: organizations.fyStartMonth })
    .from(organizations);
  if (!company?.stateCode) {
    throw invalidInput(
      'This company has no state on its profile, so GST cannot be worked out. Set it in Data first.',
    );
  }

  const [party] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.isActive, true)));
  if (!party) throw notFound('That supplier does not exist in this company.');

  const fyLabel = fyLabelFor(input.voucherDate, company.fyStartMonth);

  // The same bill entered twice is the most expensive error in payables, because
  // it is then paid twice. The unique index is what actually prevents it, including
  // against a concurrent second entry; this names the clashing bill instead of
  // surfacing a constraint name.
  const duplicate = await findDuplicateBill(tx, {
    partyId: party.id,
    supplierInvoiceNo: input.supplierInvoiceNo,
    fyLabel,
  });
  if (duplicate) {
    throw conflict(
      `${party.name} invoice ${input.supplierInvoiceNo} is already entered as ` +
        `${duplicate.voucherNo} dated ${duplicate.voucherDate}. ` +
        `Entering it again would mean paying it twice.`,
    );
  }

  // On a purchase the place of supply is where WE are: we are the recipient, so
  // the supply is taxed in our state unless it is an import.
  const placeOfSupply = input.placeOfSupplyStateCode || company.stateCode;
  const supplyType = determineSupplyType({
    supplierStateCode: party.stateCode ?? company.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
  });

  const lines = input.lines.map((l) => ({ ...l }));
  const calculation = calculateInvoice(lines, supplyType);
  const entries = purchaseBillEntries(calculation);

  const voucherNo = await allocateVoucherNumber(tx, {
    voucherType: 'purchase',
    fyLabel,
    prefix: 'BILL',
  });

  const created = await createVoucher(tx, {
    voucherType: 'purchase',
    voucherNo,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: party.id,
    supplierStateCode: party.stateCode ?? null,
    placeOfSupplyStateCode: placeOfSupply,
    supplyType,
    reference: input.supplierInvoiceNo,
    supplierInvoiceNo: input.supplierInvoiceNo,
    supplierInvoiceDate: input.supplierInvoiceDate,
    narration: input.narration || null,
    calculation,
    lines,
    entries,
    sourceDocumentId: input.sourceDocumentId ?? null,
  });

  if (input.poId || input.grnId) {
    await tx.execute(sql`
      update vouchers
         set po_id = ${input.poId || null}::uuid, grn_id = ${input.grnId || null}::uuid
       where id = ${created.id}::uuid and status = 'draft'
    `);
  }

  if (input.post) await postVoucher(tx, { voucherId: created.id, userId: input.userId });

  // A reverse-charge bill carries no tax from the supplier, but we still owe it.
  // The liability is a separate voucher so the bill keeps showing what the
  // supplier's document shows. The amount comes from the engine applied to the
  // same taxable value — nothing here invents a figure.
  let reverseChargeVoucherNo: string | null = null;
  const reverseChargeLines = lines.filter((l) => l.reverseCharge);
  if (reverseChargeLines.length > 0 && input.post) {
    const asIfTaxed = calculateInvoice(
      reverseChargeLines.map((l) => ({ ...l, reverseCharge: false })),
      supplyType,
    );
    if (asIfTaxed.totalTaxPaise > 0n) {
      const rcNo = await allocateVoucherNumber(tx, {
        voucherType: 'journal',
        fyLabel,
        prefix: 'RCM',
      });
      const rc = await createVoucher(tx, {
        voucherType: 'journal',
        voucherNo: rcNo,
        fyLabel,
        voucherDate: input.voucherDate,
        partyId: party.id,
        supplierStateCode: null,
        placeOfSupplyStateCode: null,
        supplyType: null,
        reference: created.voucherNo,
        narration: `Reverse charge on ${created.voucherNo} — tax payable by us as recipient`,
        calculation: null,
        lines: [],
        entries: reverseChargeLiabilityEntries({
          cgstPaise: asIfTaxed.cgstPaise,
          sgstPaise: asIfTaxed.sgstPaise,
          igstPaise: asIfTaxed.igstPaise,
        }),
        totalPaise: asIfTaxed.totalTaxPaise,
      });
      await postVoucher(tx, { voucherId: rc.id, userId: input.userId });
      reverseChargeVoucherNo = rc.voucherNo;
    }
  }

  return {
    id: created.id,
    voucherNo: created.voucherNo,
    totalPaise: created.totalPaise,
    taxablePaise: calculation.taxablePaise,
    supplyType,
    partyName: party.name,
    posted: input.post,
    reverseChargeVoucherNo,
  };
}
