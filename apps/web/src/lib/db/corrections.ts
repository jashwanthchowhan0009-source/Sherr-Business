import 'server-only';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import type { Tx } from './tenant';
import { documentExtractions, documents, organizations, vouchers, type Role, type VoucherType } from './schema';
import {
  allocateVoucherNumber,
  createVoucher,
  markReversed,
  postVoucher,
  voucherPostings,
} from './ledger';
import { unreconcileLine } from './banking';
import { reverseEntries } from '@/lib/accounting/posting';
import { fyLabelFor } from '@/lib/accounting/fiscal-year';
import { can } from '@/lib/auth/permissions';
import type { AuditEntry } from '@/lib/audit/log';
import { conflict, forbidden, invalidInput, notFound } from '@/lib/errors';

/**
 * Editing a voucher.
 *
 * Two different things hide behind one "Edit" button, and which one happens is
 * decided by the voucher, not by the person:
 *
 *   * A DRAFT is not in the books yet, so it is rewritten. The old draft is
 *     removed and the edited one written in its place under the same number, so
 *     the series has no gap and anything that pointed at the draft (its source
 *     document, its extraction) points at the new one.
 *
 *   * A POSTED voucher is never changed in place — the database refuses it
 *     (0003, invariant 2). Editing it is a correction: the original is reversed
 *     and the edited version posted as a replacement, in one transaction. The
 *     books keep all three, the replacement names what it corrects, and the
 *     reason goes into the reversal's narration and the audit row. That is what
 *     the Companies Act audit trail asks for: the mistake stays on the record.
 *
 * Money that was settled against the original follows it to the replacement:
 * a receipt that cleared an invoice still clears the corrected invoice, as far
 * as the new total allows. Without that, correcting a typo on a paid invoice
 * would make it look unpaid.
 */

export type VoucherRow = typeof vouchers.$inferSelect;

/** What a create handler needs to know when it is writing a replacement. */
export interface CorrectionOpts {
  /** Keep the draft's own number rather than taking the next in the series. */
  reuseVoucherNo?: string | null;
  /** The voucher this one corrects, recorded on the replacement. */
  correctsVoucherId?: string | null;
  /** Carried over from the original, so the replacement traces to the same file. */
  sourceDocumentId?: string | null;
  poId?: string | null;
  grnId?: string | null;
  /** A posted original can only be replaced by a posted voucher. */
  mustPost?: boolean;
}

interface CarriedAllocation {
  settlementVoucherId: string;
  amountPaise: bigint;
}

/**
 * Reverses a posted voucher inside the caller's transaction.
 *
 * Also undoes what the original had settled or had matched, because a reversed
 * voucher is out of the books and nothing should still lean on it:
 *
 *   * allocations it made (a receipt clearing invoices) are released, so those
 *     invoices are open again;
 *   * allocations made against it (receipts that cleared it) are released and
 *     returned, so a correction can carry them to the replacement;
 *   * bank lines reconciled to it go back to unmatched, to be matched again.
 */
export async function reversePostedVoucher(
  tx: Tx,
  input: {
    original: VoucherRow;
    reason: string;
    voucherDate: string;
    fyStartMonth: number;
    userId: string;
    narrationPrefix?: string;
  },
): Promise<{ id: string; voucherNo: string; carried: CarriedAllocation[] }> {
  const { original } = input;
  if (original.status !== 'posted') {
    throw conflict(
      `${original.voucherNo} is still a draft. Edit the draft instead of reversing it.`,
    );
  }
  if (original.reversedByVoucherId) {
    throw conflict(
      `${original.voucherNo} has already been reversed. A second reversal would double the correction.`,
    );
  }

  const postings = await voucherPostings(tx, original.id);
  if (postings.length === 0) {
    throw conflict(`${original.voucherNo} has no ledger entries to reverse.`);
  }

  const fyLabel = fyLabelFor(input.voucherDate, input.fyStartMonth);
  const voucherNo = await allocateVoucherNumber(tx, {
    voucherType: original.voucherType,
    fyLabel,
    prefix: 'REV',
  });

  const reversal = await createVoucher(tx, {
    voucherType: original.voucherType,
    voucherNo,
    fyLabel,
    voucherDate: input.voucherDate,
    partyId: original.partyId,
    supplierStateCode: original.supplierStateCode,
    placeOfSupplyStateCode: original.placeOfSupplyStateCode,
    supplyType: original.supplyType,
    reference: original.voucherNo,
    narration: `${input.narrationPrefix ?? 'Reversal'} of ${original.voucherNo}: ${input.reason}`,
    calculation: null,
    lines: [],
    entries: reverseEntries(postings),
    totalPaise: original.totalPaise,
    reversesVoucherId: original.id,
  });

  await postVoucher(tx, { voucherId: reversal.id, userId: input.userId });
  await markReversed(tx, { originalVoucherId: original.id, reversalVoucherId: reversal.id });

  const { rows: against } = await tx.execute<{ settlement: string; amount: string }>(sql`
    delete from voucher_allocations
     where target_voucher_id = ${original.id}::uuid
    returning settlement_voucher_id as settlement, amount_paise::text as amount
  `);
  await tx.execute(sql`
    delete from voucher_allocations where settlement_voucher_id = ${original.id}::uuid
  `);

  const { rows: matched } = await tx.execute<{ id: string }>(sql`
    select id from bank_statement_lines where matched_voucher_id = ${original.id}::uuid
  `);
  for (const line of matched) await unreconcileLine(tx, { statementLineId: line.id });

  return {
    id: reversal.id,
    voucherNo: reversal.voucherNo,
    carried: against.map((r) => ({ settlementVoucherId: r.settlement, amountPaise: BigInt(r.amount) })),
  };
}

export interface CorrectionContext {
  tx: Tx;
  orgId: string;
  userId: string;
  role: Role;
  audit: (entry: AuditEntry) => Promise<void>;
}

export interface CorrectionResult<T> {
  created: T;
  mode: 'draft' | 'posted';
  originalVoucherNo: string;
  reversalVoucherNo: string | null;
}

/**
 * Runs an edit end to end: checks the original, takes it out of the way
 * (rewrite or reverse), lets `create` write the edited voucher with the same
 * engine a new one goes through, then reattaches what pointed at the original.
 *
 * `create` is the voucher type's own create handler. Nothing here computes an
 * amount: an edited invoice is calculated exactly as a new one would be.
 */
export async function runCorrection<T extends { id: string; voucherNo: string }>(
  ctx: CorrectionContext,
  input: {
    id: string;
    reason: string | undefined;
    types: readonly VoucherType[];
    /** The date the edited voucher will carry. */
    voucherDate: string;
    create: (opts: CorrectionOpts) => Promise<T>;
  },
): Promise<CorrectionResult<T>> {
  const { tx } = ctx;

  const [company] = await tx
    .select({ fyStartMonth: organizations.fyStartMonth })
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId));
  const fyStartMonth = company?.fyStartMonth ?? 4;

  // Locked for the length of the transaction, so two people editing the same
  // voucher cannot both reverse it.
  const { rows: locked } = await tx.execute<{ id: string }>(sql`
    select id from vouchers where id = ${input.id}::uuid for update
  `);
  if (locked.length === 0) throw notFound('Voucher');

  const [original] = await tx.select().from(vouchers).where(eq(vouchers.id, input.id));
  if (!original) throw notFound('Voucher');

  if (!input.types.includes(original.voucherType)) {
    throw invalidInput(`${original.voucherNo} is a ${original.voucherType.replace('_', ' ')}, not this kind of entry.`);
  }
  if (original.reversesVoucherId) {
    throw conflict(
      `${original.voucherNo} is a reversal. It cannot be edited — it exists only to cancel another entry.`,
    );
  }
  if (original.reversedByVoucherId) {
    throw conflict(
      `${original.voucherNo} has already been reversed. Edit the entry that replaced it instead.`,
    );
  }
  if (original.voucherType === 'journal' && original.voucherNo.startsWith('RCM')) {
    throw conflict(
      `${original.voucherNo} was raised automatically for reverse charge on ${original.reference ?? 'a bill'}. Edit that bill and this follows.`,
    );
  }

  const linkedDocs = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.linkedVoucherId, original.id));
  const docIds = linkedDocs.map((d) => d.id);

  let reversalVoucherNo: string | null = null;
  let carried: CarriedAllocation[] = [];
  let extractionIds: string[] = [];
  let opts: CorrectionOpts;

  if (original.status === 'draft') {
    // Composite foreign keys cannot SET NULL one column of two, so the links
    // are cleared by hand before the draft goes, and restored afterwards.
    const extractions = await tx
      .select({ id: documentExtractions.id })
      .from(documentExtractions)
      .where(eq(documentExtractions.voucherId, original.id));
    extractionIds = extractions.map((e) => e.id);
    if (docIds.length > 0) {
      await tx.update(documents).set({ linkedVoucherId: null }).where(inArray(documents.id, docIds));
    }
    if (extractionIds.length > 0) {
      await tx
        .update(documentExtractions)
        .set({ voucherId: null })
        .where(inArray(documentExtractions.id, extractionIds));
    }

    await tx.delete(vouchers).where(and(eq(vouchers.id, original.id), eq(vouchers.status, 'draft')));

    const sameYear = fyLabelFor(input.voucherDate, fyStartMonth) === original.fyLabel;
    opts = {
      reuseVoucherNo: sameYear ? original.voucherNo : null,
      sourceDocumentId: original.sourceDocumentId,
      poId: original.poId,
      grnId: original.grnId,
      mustPost: false,
    };
  } else {
    if (!can(ctx.role, 'voucher:post')) throw forbidden('correct a posted voucher');
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw invalidInput(
        `${original.voucherNo} is posted, so editing it posts a correction. Say why it is being changed.`,
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const reversal = await reversePostedVoucher(tx, {
      original,
      reason,
      voucherDate: today,
      fyStartMonth,
      userId: ctx.userId,
      narrationPrefix: 'Correction',
    });
    reversalVoucherNo = reversal.voucherNo;
    carried = reversal.carried;

    // A reverse-charge bill raised its liability as a separate journal. It goes
    // with the bill: the replacement raises its own from the corrected lines.
    if (original.voucherType === 'purchase') {
      const companions = await tx
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.voucherType, 'journal'),
            eq(vouchers.status, 'posted'),
            eq(vouchers.reference, original.voucherNo),
            like(vouchers.voucherNo, 'RCM%'),
            isNull(vouchers.reversedByVoucherId),
          ),
        );
      for (const companion of companions) {
        await reversePostedVoucher(tx, {
          original: companion,
          reason: `bill ${original.voucherNo} corrected`,
          voucherDate: today,
          fyStartMonth,
          userId: ctx.userId,
          narrationPrefix: 'Correction',
        });
      }
    }

    opts = {
      correctsVoucherId: original.id,
      sourceDocumentId: original.sourceDocumentId,
      poId: original.poId,
      grnId: original.grnId,
      mustPost: true,
    };
  }

  const created = await input.create(opts);

  if (docIds.length > 0) {
    await tx.update(documents).set({ linkedVoucherId: created.id }).where(inArray(documents.id, docIds));
  }
  if (extractionIds.length > 0) {
    await tx
      .update(documentExtractions)
      .set({ voucherId: created.id })
      .where(inArray(documentExtractions.id, extractionIds));
  }

  if (carried.length > 0) await carryAllocations(tx, original, created.id, carried);

  await ctx.audit({
    action: original.status === 'draft' ? 'voucher.draft.edited' : 'voucher.corrected',
    subjectKind: 'voucher',
    subjectId: created.id,
    before: {
      voucherId: original.id,
      voucherNo: original.voucherNo,
      voucherDate: original.voucherDate,
      partyId: original.partyId,
      totalPaise: original.totalPaise.toString(),
      status: original.status,
    },
    after: {
      voucherNo: created.voucherNo,
      reversalVoucherNo,
      reason: input.reason?.trim() || null,
      carriedAllocations: carried.length,
    },
  });

  return {
    created,
    mode: original.status === 'draft' ? 'draft' : 'posted',
    originalVoucherNo: original.voucherNo,
    reversalVoucherNo,
  };
}

/**
 * Re-applies settlements that cleared the original to its replacement.
 *
 * Only when the replacement is the same kind of document for the same party and
 * is posted — a receipt from one customer must never clear another customer's
 * invoice. Capped at what the replacement leaves outstanding; anything beyond
 * stays with the receipt as an unallocated advance, exactly as an overpayment
 * would.
 */
async function carryAllocations(
  tx: Tx,
  original: VoucherRow,
  replacementId: string,
  carried: readonly CarriedAllocation[],
): Promise<void> {
  const [replacement] = await tx.select().from(vouchers).where(eq(vouchers.id, replacementId));
  if (
    !replacement ||
    replacement.status !== 'posted' ||
    replacement.voucherType !== original.voucherType ||
    replacement.partyId !== original.partyId
  ) {
    return;
  }

  let outstanding = replacement.totalPaise;
  for (const allocation of carried) {
    if (outstanding <= 0n) break;
    const applied = allocation.amountPaise < outstanding ? allocation.amountPaise : outstanding;
    await tx.execute(sql`
      insert into voucher_allocations (org_id, settlement_voucher_id, target_voucher_id, amount_paise)
      values (app_current_org_id(), ${allocation.settlementVoucherId}::uuid, ${replacementId}::uuid, ${applied})
      on conflict (settlement_voucher_id, target_voucher_id) do nothing
    `);
    outstanding -= applied;
  }
}

