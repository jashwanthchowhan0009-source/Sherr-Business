import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { accounts, bankAccounts, bankStatements, bankStatementLines } from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden, notFound } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';
import type { MatchTierValue } from '@/lib/db/schema';

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'bank:read')) throw forbidden('view bank statements');
};

export async function getBankAccounts(ctx: RequestContext) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select({
        id: bankAccounts.id,
        bankName: bankAccounts.bankName,
        accountLabel: bankAccounts.accountLabel,
        accountNumberLast4: bankAccounts.accountNumberLast4,
        ifsc: bankAccounts.ifsc,
        ledgerAccountId: bankAccounts.ledgerAccountId,
        ledgerAccountCode: accounts.code,
        ledgerAccountName: accounts.name,
      })
      .from(bankAccounts)
      .innerJoin(accounts, eq(accounts.id, bankAccounts.ledgerAccountId))
      .where(eq(bankAccounts.isActive, true))
      .orderBy(bankAccounts.bankName),
  );
}

export async function getStatements(ctx: RequestContext, bankAccountId?: string) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) =>
    tx
      .select()
      .from(bankStatements)
      .where(bankAccountId ? eq(bankStatements.bankAccountId, bankAccountId) : sql`true`)
      .orderBy(desc(bankStatements.createdAt))
      .limit(20),
  );
}

export interface ReviewQueueRow {
  lineId: string;
  lineDate: string;
  narration: string;
  reference: string | null;
  amountPaise: bigint;
  status: string;
  suggestion: {
    id: string;
    voucherId: string;
    voucherNo: string;
    voucherType: string;
    voucherDate: string;
    partyName: string | null;
    tier: MatchTierValue;
    confidence: number;
    reasons: string[];
    dayDifference: number;
  } | null;
  matchedVoucherNo: string | null;
}

/**
 * The review queue: every statement line that still needs a decision, with the
 * suggestion offered for it.
 *
 * Suggested lines come first and the weakest suggestions last, so the ones most
 * likely to need thought are not buried under the obvious ones. Reconciled lines
 * are excluded: they are history, and the reconciliation statement is where they
 * are accounted for.
 */
export async function getReviewQueue(
  ctx: RequestContext,
  input: { bankAccountId: string; limit?: number },
): Promise<ReviewQueueRow[]> {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { rows } = await tx.execute<{
      line_id: string;
      line_date: string;
      narration: string;
      reference: string | null;
      amount_paise: string;
      status: string;
      suggestion_id: string | null;
      voucher_id: string | null;
      voucher_no: string | null;
      voucher_type: string | null;
      voucher_date: string | null;
      party_name: string | null;
      tier: string | null;
      confidence: number | null;
      reasons: unknown;
      day_difference: number | null;
      matched_voucher_no: string | null;
    }>(sql`
      select l.id as line_id, l.line_date::text as line_date, l.narration, l.reference,
             l.amount_paise::text as amount_paise, l.status,
             s.id as suggestion_id, s.voucher_id, v.voucher_no, v.voucher_type,
             v.voucher_date::text as voucher_date, p.name as party_name,
             s.tier, s.confidence, s.reasons, s.day_difference,
             mv.voucher_no as matched_voucher_no
        from bank_statement_lines l
        left join bank_match_suggestions s
               on s.statement_line_id = l.id and s.decided_at is null
        left join vouchers v on v.id = s.voucher_id
        left join parties p on p.id = v.party_id
        left join vouchers mv on mv.id = l.matched_voucher_id
       where l.bank_account_id = ${input.bankAccountId}::uuid
         and l.status in ('unmatched', 'suggested')
       order by
         case l.status when 'suggested' then 0 else 1 end,
         s.confidence desc nulls last,
         l.line_date
       limit ${input.limit ?? 100}
    `);

    return rows.map((r) => ({
      lineId: r.line_id,
      lineDate: r.line_date,
      narration: r.narration,
      reference: r.reference,
      amountPaise: BigInt(r.amount_paise),
      status: r.status,
      suggestion:
        r.suggestion_id && r.voucher_id
          ? {
              id: r.suggestion_id,
              voucherId: r.voucher_id,
              voucherNo: r.voucher_no ?? '',
              voucherType: r.voucher_type ?? '',
              voucherDate: r.voucher_date ?? '',
              partyName: r.party_name,
              tier: (r.tier ?? 'weak') as MatchTierValue,
              confidence: r.confidence ?? 0,
              reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
              dayDifference: r.day_difference ?? 0,
            }
          : null,
      matchedVoucherNo: r.matched_voucher_no,
    }));
  });
}

export interface Reconciliation {
  bankAccountId: string;
  asOf: string;
  /** What the ledger says the account holds. */
  bookBalancePaise: bigint;
  /** The last balance the statement reported, where it gave one. */
  statementBalancePaise: bigint | null;
  /** In the bank, not in the books. */
  unreconciledStatementLines: {
    lineId: string;
    lineDate: string;
    narration: string;
    amountPaise: bigint;
    status: string;
  }[];
  /** In the books, not on the statement. */
  unpresentedVouchers: {
    voucherId: string;
    voucherNo: string;
    voucherDate: string;
    amountPaise: bigint;
  }[];
  unreconciledStatementTotalPaise: bigint;
  unpresentedTotalPaise: bigint;
  /** Book balance adjusted for both lists; should equal the statement balance. */
  reconciledBalancePaise: bigint;
  /** Zero when the account reconciles. */
  differencePaise: bigint | null;
}

/**
 * The bank reconciliation statement.
 *
 * Starts from what the books say, adds what the bank has recorded and the books
 * have not, and subtracts what the books have recorded and the bank has not. The
 * result should equal the statement's own closing balance; the difference is
 * reported rather than hidden, because an unexplained difference is the entire
 * reason to run this report.
 *
 * Ignored lines count towards the reconciliation as much as unmatched ones: a
 * bank charge marked "accounted for elsewhere" still appears on the statement and
 * still has to be explained by the arithmetic.
 */
export async function getReconciliation(
  ctx: RequestContext,
  input: { bankAccountId: string; asOf: string },
): Promise<Reconciliation> {
  guard(ctx);

  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const [account] = await tx
      .select({ ledgerAccountId: bankAccounts.ledgerAccountId })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, input.bankAccountId));
    if (!account) throw notFound('That bank account does not exist in this company.');

    const book = await tx.execute<{ net: string }>(sql`
      select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text as net
        from ledger_entries l
        join vouchers v on v.id = l.voucher_id
       where l.account_id = ${account.ledgerAccountId}::uuid
         and v.status = 'posted'
         and l.entry_date <= ${input.asOf}::date
    `);
    const bookBalancePaise = BigInt(book.rows[0]?.net ?? '0');

    const statementBalance = await tx.execute<{ balance: string | null }>(sql`
      select balance_paise::text as balance
        from bank_statement_lines
       where bank_account_id = ${input.bankAccountId}::uuid
         and line_date <= ${input.asOf}::date
         and balance_paise is not null
       order by line_date desc, row_number desc
       limit 1
    `);
    const statementBalancePaise =
      statementBalance.rows[0]?.balance == null ? null : BigInt(statementBalance.rows[0].balance);

    const unreconciled = await tx
      .select({
        lineId: bankStatementLines.id,
        lineDate: bankStatementLines.lineDate,
        narration: bankStatementLines.narration,
        amountPaise: bankStatementLines.amountPaise,
        status: bankStatementLines.status,
      })
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.bankAccountId, input.bankAccountId),
          sql`${bankStatementLines.status} <> 'reconciled'`,
          sql`${bankStatementLines.lineDate} <= ${input.asOf}::date`,
        ),
      )
      .orderBy(bankStatementLines.lineDate);

    const unpresented = await tx.execute<{
      voucher_id: string;
      voucher_no: string;
      voucher_date: string;
      amount: string;
    }>(sql`
      select v.id as voucher_id, v.voucher_no, v.voucher_date::text as voucher_date,
             sum(l.debit_paise - l.credit_paise)::text as amount
        from vouchers v
        join ledger_entries l on l.voucher_id = v.id
       where l.account_id = ${account.ledgerAccountId}::uuid
         and v.status = 'posted'
         and v.reversed_by_voucher_id is null
         and l.entry_date <= ${input.asOf}::date
         and not exists (
           select 1 from bank_statement_lines bl where bl.matched_voucher_id = v.id
         )
       group by v.id, v.voucher_no, v.voucher_date
       order by v.voucher_date
    `);

    const unreconciledStatementTotalPaise = unreconciled.reduce(
      (acc, l) => acc + l.amountPaise,
      0n,
    );
    const unpresentedVouchers = unpresented.rows.map((r) => ({
      voucherId: r.voucher_id,
      voucherNo: r.voucher_no,
      voucherDate: r.voucher_date,
      amountPaise: BigInt(r.amount),
    }));
    const unpresentedTotalPaise = unpresentedVouchers.reduce((acc, v) => acc + v.amountPaise, 0n);

    // Books + what the bank knows and we do not − what we know and the bank does
    // not should land on the statement's own figure.
    const reconciledBalancePaise =
      bookBalancePaise + unreconciledStatementTotalPaise - unpresentedTotalPaise;

    return {
      bankAccountId: input.bankAccountId,
      asOf: input.asOf,
      bookBalancePaise,
      statementBalancePaise,
      unreconciledStatementLines: unreconciled.map((l) => ({
        lineId: l.lineId,
        lineDate: l.lineDate,
        narration: l.narration,
        amountPaise: l.amountPaise,
        status: l.status,
      })),
      unpresentedVouchers,
      unreconciledStatementTotalPaise,
      unpresentedTotalPaise,
      reconciledBalancePaise,
      differencePaise:
        statementBalancePaise === null ? null : reconciledBalancePaise - statementBalancePaise,
    };
  });
}
