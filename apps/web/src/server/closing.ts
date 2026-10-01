'use server';

import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { organizations, periodLocks } from '@/lib/db/schema';
import { allocateVoucherNumber, createVoucher, postVoucher } from '@/lib/db/ledger';
import { journalEntries } from '@/lib/accounting/posting';
import { fiscalYearOf, fyLabelFor } from '@/lib/accounting/fiscal-year';
import { parseRupees } from '@/lib/accounting/units';
import { conflict, invalidInput } from '@/lib/errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');

/**
 * Entering closing stock.
 *
 * Purchases are expensed as they are made, so a trading company shows a loss
 * until the stock it still holds is recognised. The entry is:
 *
 *   Dr Stock-in-Hand            the value still on the shelf
 *     Cr Changes in Inventories reducing the period's cost by that much
 *
 * Valued by the person entering it, not by this product. Stock valuation is a
 * judgement — lower of cost and net realisable value, which cost formula, what
 * to do with obsolete lines — and inventing a figure here would be the clearest
 * possible case of the app making up a number.
 */
const enterClosingStockAction = defineAction({
  name: 'closing.stock.entered',
  capability: 'closing:write',
  input: z.object({
    asOfDate: isoDate,
    valueRupees: z.string().trim(),
    basis: z.string().trim().min(3, 'Say how the stock was valued').max(300),
  }),
  handler: async ({ tx, orgId, input, userId, audit }) => {
    const valuePaise = parseRupees(input.valueRupees);
    if (valuePaise < 0n) throw invalidInput('Closing stock cannot be negative.');

    const [company] = await tx
      .select({ fyStartMonth: organizations.fyStartMonth })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    const fyStartMonth = company?.fyStartMonth ?? 4;
    const fy = fiscalYearOf(input.asOfDate, fyStartMonth);

    // One closing stock entry per financial year. A second would double-count
    // the stock, and correcting the first is a reversal like anything else.
    const existing = await tx.execute<{ voucher_no: string }>(sql`
      select v.voucher_no
        from vouchers v
        join ledger_entries l on l.voucher_id = v.id
        join accounts a on a.id = l.account_id
       where v.status = 'posted'
         and v.reversed_by_voucher_id is null
         and a.code = 'INVENTORY_CHANGE'
         and l.entry_date between ${fy.startDate}::date and ${fy.endDate}::date
       limit 1
    `);
    if (existing.rows[0]) {
      throw conflict(
        `Closing stock for ${fy.longLabel} is already entered as ${existing.rows[0].voucher_no}. ` +
          'Reverse that entry before entering a different figure.',
      );
    }

    const fyLabel = fyLabelFor(input.asOfDate, fyStartMonth);
    const voucherNo = await allocateVoucherNumber(tx, {
      voucherType: 'journal',
      fyLabel,
      prefix: 'STK',
    });

    const created = await createVoucher(tx, {
      voucherType: 'journal',
      voucherNo,
      fyLabel,
      voucherDate: input.asOfDate,
      partyId: null,
      supplierStateCode: null,
      placeOfSupplyStateCode: null,
      supplyType: null,
      reference: null,
      narration: `Closing stock as at ${input.asOfDate}. Valued on the basis: ${input.basis}`,
      calculation: null,
      lines: [],
      entries: journalEntries([
        { accountCode: 'STOCK_IN_HAND', debitPaise: valuePaise, creditPaise: 0n },
        { accountCode: 'INVENTORY_CHANGE', debitPaise: 0n, creditPaise: valuePaise },
      ]),
      totalPaise: valuePaise,
    });
    await postVoucher(tx, { voucherId: created.id, userId });

    await audit({
      action: 'closing.stock.entered',
      subjectKind: 'voucher',
      subjectId: created.id,
      after: {
        voucherNo: created.voucherNo,
        asOfDate: input.asOfDate,
        valuePaise: valuePaise.toString(),
        basis: input.basis,
        financialYear: fy.longLabel,
      },
    });

    revalidatePath('/output');
    revalidatePath('/dashboard');
    return { id: created.id, voucherNo: created.voucherNo };
  },
});

/**
 * Locking a period.
 *
 * This is the act that turns a provisional figure into a settled one: nothing
 * dated on or before the lock can be posted afterwards, which is what lets the
 * dashboard stop calling a profit provisional. It is therefore the owner's
 * decision, not the bookkeeper's.
 *
 * The lock refuses to close a period that still has drafts in it. A draft inside
 * a locked period can never be posted, so leaving one there would silently
 * discard work somebody started.
 */
const lockPeriodAction = defineAction({
  name: 'period.locked',
  capability: 'period:lock',
  input: z.object({
    lockedUpto: isoDate,
    reason: z.string().trim().min(3, 'Say why the period is being closed').max(300),
  }),
  handler: async ({ tx, orgId, input, userId, audit }) => {
    const [existing] = await tx.select().from(periodLocks).where(eq(periodLocks.orgId, orgId));

    // Moving a lock backwards would reopen a period that has been reported on.
    if (existing && input.lockedUpto < existing.lockedUpto) {
      throw conflict(
        `The books are already closed to ${existing.lockedUpto}. Closing to an earlier date ` +
          'would reopen a period that has been reported on — unlock it explicitly instead.',
      );
    }

    const drafts = await tx.execute<{ n: string; first: string | null }>(sql`
      select count(*)::text as n, min(voucher_no) as first
        from vouchers
       where status = 'draft' and voucher_date <= ${input.lockedUpto}::date
    `);
    const draftCount = Number(drafts.rows[0]?.n ?? 0);
    if (draftCount > 0) {
      throw conflict(
        `${draftCount} ${draftCount === 1 ? 'voucher is' : 'vouchers are'} still a draft inside ` +
          `that period, starting with ${drafts.rows[0]?.first}. A draft in a locked period can ` +
          'never be posted, so post or delete them first.',
      );
    }

    await tx.execute(sql`
      insert into period_locks (org_id, locked_upto, reason, locked_by)
      values (app_current_org_id(), ${input.lockedUpto}::date, ${input.reason}, ${userId}::uuid)
      on conflict (org_id) do update
        set locked_upto = excluded.locked_upto,
            reason = excluded.reason,
            locked_by = excluded.locked_by,
            created_at = now()
    `);

    await audit({
      action: 'period.locked',
      subjectKind: 'period_lock',
      subjectId: orgId,
      before: existing ? { lockedUpto: existing.lockedUpto } : undefined,
      after: { lockedUpto: input.lockedUpto, reason: input.reason },
    });

    revalidatePath('/output');
    revalidatePath('/dashboard');
    revalidatePath('/process');
    return { lockedUpto: input.lockedUpto };
  },
});

/**
 * Unlocking, which is deliberately awkward.
 *
 * Reopening a closed period changes figures that have been reported, so it
 * requires its own capability, a reason, and leaves a record naming who did it
 * and from what date. It is not an undo button.
 */
const unlockPeriodAction = defineAction({
  name: 'period.unlocked',
  capability: 'period:unlock',
  input: z.object({
    reason: z.string().trim().min(10, 'Reopening closed books needs a full explanation').max(500),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [existing] = await tx.select().from(periodLocks).where(eq(periodLocks.orgId, orgId));
    if (!existing) throw conflict('The books are not closed to any date.');

    await tx.delete(periodLocks).where(eq(periodLocks.orgId, orgId));

    await audit({
      action: 'period.unlocked',
      subjectKind: 'period_lock',
      subjectId: orgId,
      before: { lockedUpto: existing.lockedUpto, reason: existing.reason },
      after: { lockedUpto: null, reason: input.reason },
    });

    revalidatePath('/output');
    revalidatePath('/dashboard');
    revalidatePath('/process');
    return { reopenedFrom: existing.lockedUpto };
  },
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function enterClosingStock(input: unknown) {
  return enterClosingStockAction(input);
}

export async function lockPeriod(input: unknown) {
  return lockPeriodAction(input);
}

export async function unlockPeriod(input: unknown) {
  return unlockPeriodAction(input);
}
