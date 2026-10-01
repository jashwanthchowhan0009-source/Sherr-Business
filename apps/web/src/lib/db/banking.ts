import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from './tenant';
import { bankStatementLines, vouchers } from './schema';
import { transactionFingerprint } from '@/lib/banking/fingerprint';
import { matchStatement, type MatchCandidate, type MatchSuggestion } from '@/lib/banking/matching';
import type { StatementLine } from '@/lib/banking/statement-parser';
import { conflict, notFound } from '@/lib/errors';

/**
 * Bank statement storage, matching and reconciliation.
 *
 * Statement lines are facts about what the bank says happened; vouchers are what
 * the books say. Reconciling one against the other is a human decision recorded
 * here, never an automatic posting: a wrong auto-reconciliation is
 * indistinguishable from fraud in an audit, and reviewing a correct suggestion
 * costs seconds.
 */

export interface ImportedStatement {
  statementId: string;
  inserted: number;
  duplicates: number;
}

/**
 * Stores a parsed statement and its lines.
 *
 * Lines already present in this bank account are skipped rather than refused:
 * people export overlapping date ranges as a matter of course, and refusing the
 * whole file because three of its rows were seen last month would make the
 * feature unusable. The count of skipped lines is reported so the import screen
 * can say what happened.
 */
export async function storeStatement(
  tx: Tx,
  input: {
    bankAccountId: string;
    documentId: string | null;
    lines: readonly StatementLine[];
    problemCount: number;
    openingBalancePaise: bigint | null;
    closingBalancePaise: bigint | null;
    balanceConsistent: boolean;
    importedBy: string | null;
  },
): Promise<ImportedStatement> {
  if (input.lines.length === 0) {
    throw conflict('That file contained no readable transactions.');
  }

  const dates = input.lines.map((l) => l.date).sort();
  const periodFrom = dates[0]!;
  const periodTo = dates.at(-1)!;

  const { rows } = await tx.execute<{ id: string }>(sql`
    insert into bank_statements (
      org_id, bank_account_id, document_id, period_from, period_to,
      opening_balance_paise, closing_balance_paise, line_count, problem_count,
      balance_consistent, imported_by
    ) values (
      app_current_org_id(), ${input.bankAccountId}::uuid, ${input.documentId}::uuid,
      ${periodFrom}::date, ${periodTo}::date,
      ${input.openingBalancePaise}, ${input.closingBalancePaise},
      ${input.lines.length}, ${input.problemCount}, ${input.balanceConsistent},
      ${input.importedBy}::uuid
    ) returning id
  `);
  const statementId = rows[0]!.id;

  let inserted = 0;
  for (const line of input.lines) {
    const fingerprint = transactionFingerprint({
      bankAccountId: input.bankAccountId,
      date: line.date,
      amountPaise: line.amountPaise,
      narration: line.narration,
      reference: line.reference,
    });

    const result = await tx.execute<{ id: string }>(sql`
      insert into bank_statement_lines (
        org_id, statement_id, bank_account_id, row_number, line_date, narration,
        reference, amount_paise, balance_paise, fingerprint
      ) values (
        app_current_org_id(), ${statementId}::uuid, ${input.bankAccountId}::uuid,
        ${line.rowNumber}, ${line.date}::date, ${line.narration},
        ${line.reference}, ${line.amountPaise}, ${line.balancePaise}, ${fingerprint}
      )
      on conflict (org_id, bank_account_id, fingerprint) do nothing
      returning id
    `);
    if (result.rows.length > 0) inserted += 1;
  }

  return { statementId, inserted, duplicates: input.lines.length - inserted };
}

/**
 * Candidate vouchers a statement line could settle: anything posted, unsettled,
 * and not already reconciled against another line.
 */
export async function matchCandidates(tx: Tx): Promise<MatchCandidate[]> {
  const { rows } = await tx.execute<{
    voucher_id: string;
    voucher_no: string;
    voucher_type: string;
    voucher_date: string;
    party_id: string | null;
    party_name: string | null;
    outstanding: string;
    reference: string | null;
  }>(sql`
    select v.id as voucher_id, v.voucher_no, v.voucher_type,
           v.voucher_date::text as voucher_date,
           v.party_id, p.name as party_name,
           (v.total_paise
             - coalesce((select sum(a.amount_paise) from voucher_allocations a
                          where a.target_voucher_id = v.id), 0))::text as outstanding,
           coalesce(v.reference, v.supplier_invoice_no) as reference
      from vouchers v
      left join parties p on p.id = v.party_id
     where v.status = 'posted'
       and v.reversed_by_voucher_id is null
       and v.voucher_type in ('sales','purchase','receipt','payment')
       -- Already tied to a statement line, so not available to another.
       and not exists (
         select 1 from bank_statement_lines l where l.matched_voucher_id = v.id
       )
       and v.total_paise
             - coalesce((select sum(a.amount_paise) from voucher_allocations a
                          where a.target_voucher_id = v.id), 0) > 0
     order by v.voucher_date
  `);

  return rows.map((r) => ({
    voucherId: r.voucher_id,
    voucherNo: r.voucher_no,
    voucherType: r.voucher_type,
    voucherDate: r.voucher_date,
    partyId: r.party_id,
    partyName: r.party_name,
    outstandingPaise: BigInt(r.outstanding),
    reference: r.reference,
  }));
}

/**
 * Generates and stores suggestions for a bank account's unmatched lines.
 *
 * Suggestions are stored rather than recomputed on every view, so that what a
 * person was shown when they accepted one is recoverable afterwards. "The system
 * proposed this and I agreed" is a different fact from "the system would propose
 * this today", and only the first is useful to an auditor.
 */
export async function generateSuggestions(
  tx: Tx,
  input: { bankAccountId: string },
): Promise<{ suggested: number; unmatched: number }> {
  const lines = await tx
    .select({
      id: bankStatementLines.id,
      date: bankStatementLines.lineDate,
      narration: bankStatementLines.narration,
      amountPaise: bankStatementLines.amountPaise,
      reference: bankStatementLines.reference,
    })
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.bankAccountId, input.bankAccountId),
        inArray(bankStatementLines.status, ['unmatched', 'suggested']),
      ),
    );

  if (lines.length === 0) return { suggested: 0, unmatched: 0 };

  const candidates = await matchCandidates(tx);
  const result = matchStatement(
    lines.map((l) => ({
      id: l.id,
      date: l.date,
      narration: l.narration,
      amountPaise: l.amountPaise,
      reference: l.reference,
    })),
    candidates,
  );

  // Clear undecided suggestions before rewriting: a voucher settled since the
  // last run must stop being proposed. Decided ones are kept, because they are
  // the record of a human decision.
  await tx.execute(sql`
    delete from bank_match_suggestions
     where decided_at is null
       and statement_line_id in (
         select id from bank_statement_lines where bank_account_id = ${input.bankAccountId}::uuid
       )
  `);

  for (const suggestion of result.suggestions) {
    await tx.execute(sql`
      insert into bank_match_suggestions (
        org_id, statement_line_id, voucher_id, tier, confidence, reasons, day_difference
      ) values (
        app_current_org_id(), ${suggestion.statementLineId}::uuid, ${suggestion.voucherId}::uuid,
        ${suggestion.tier}, ${suggestion.confidence},
        ${JSON.stringify(suggestion.reasons)}::jsonb, ${suggestion.dayDifference}
      )
      on conflict (statement_line_id, voucher_id) do update
        set tier = excluded.tier,
            confidence = excluded.confidence,
            reasons = excluded.reasons,
            day_difference = excluded.day_difference
    `);
  }

  const suggestedIds = result.suggestions.map((s) => s.statementLineId);
  if (suggestedIds.length > 0) {
    await tx.execute(sql`
      update bank_statement_lines set status = 'suggested'
       where id = any(${sql.param(suggestedIds)}::uuid[]) and status = 'unmatched'
    `);
  }
  if (result.unmatchedLineIds.length > 0) {
    await tx.execute(sql`
      update bank_statement_lines set status = 'unmatched'
       where id = any(${sql.param(result.unmatchedLineIds)}::uuid[]) and status = 'suggested'
    `);
  }

  return { suggested: result.suggestions.length, unmatched: result.unmatchedLineIds.length };
}

export interface SuggestionWithContext extends MatchSuggestion {
  suggestionId: string;
  lineDate: string;
  lineNarration: string;
  lineAmountPaise: bigint;
  voucherNo: string;
  voucherType: string;
  partyName: string | null;
}

/**
 * Accepts a suggestion: the statement line is tied to the voucher.
 *
 * Nothing is posted. The voucher already exists and already carries the ledger
 * entries; reconciling records that the bank agrees it happened. Posting
 * something here would mean the same money appeared in the books twice.
 */
export async function acceptSuggestion(
  tx: Tx,
  input: { suggestionId: string; userId: string | null },
): Promise<{ statementLineId: string; voucherNo: string }> {
  const { rows } = await tx.execute<{
    statement_line_id: string;
    voucher_id: string;
    voucher_no: string;
    line_status: string;
    decided_at: string | null;
  }>(sql`
    select s.statement_line_id, s.voucher_id, v.voucher_no,
           l.status as line_status, s.decided_at::text as decided_at
      from bank_match_suggestions s
      join bank_statement_lines l on l.id = s.statement_line_id
      join vouchers v on v.id = s.voucher_id
     where s.id = ${input.suggestionId}::uuid
  `);
  const row = rows[0];
  if (!row) throw notFound('That suggestion does not exist in this company.');
  if (row.decided_at) throw conflict('That suggestion has already been decided.');
  if (row.line_status === 'reconciled') {
    throw conflict('That statement line is already reconciled.');
  }

  await tx.execute(sql`
    update bank_statement_lines
       set status = 'reconciled',
           matched_voucher_id = ${row.voucher_id}::uuid,
           reconciled_at = now(),
           reconciled_by = ${input.userId}::uuid
     where id = ${row.statement_line_id}::uuid
  `);

  await tx.execute(sql`
    update bank_match_suggestions
       set decided_at = now(), decided_by = ${input.userId}::uuid, decision = 'accepted'
     where id = ${input.suggestionId}::uuid
  `);

  // Any other suggestion for this line is now moot.
  await tx.execute(sql`
    update bank_match_suggestions
       set decided_at = now(), decided_by = ${input.userId}::uuid, decision = 'rejected'
     where statement_line_id = ${row.statement_line_id}::uuid
       and id <> ${input.suggestionId}::uuid
       and decided_at is null
  `);

  return { statementLineId: row.statement_line_id, voucherNo: row.voucher_no };
}

export async function rejectSuggestion(
  tx: Tx,
  input: { suggestionId: string; userId: string | null },
): Promise<{ statementLineId: string }> {
  const { rows } = await tx.execute<{ statement_line_id: string }>(sql`
    update bank_match_suggestions
       set decided_at = now(), decided_by = ${input.userId}::uuid, decision = 'rejected'
     where id = ${input.suggestionId}::uuid and decided_at is null
     returning statement_line_id
  `);
  const row = rows[0];
  if (!row) throw notFound('That suggestion does not exist or has already been decided.');

  // With no undecided suggestion left, the line is unmatched again.
  await tx.execute(sql`
    update bank_statement_lines set status = 'unmatched'
     where id = ${row.statement_line_id}::uuid
       and status = 'suggested'
       and not exists (
         select 1 from bank_match_suggestions s
          where s.statement_line_id = bank_statement_lines.id and s.decided_at is null
       )
  `);

  return { statementLineId: row.statement_line_id };
}

/**
 * Marks a line as needing no voucher: bank charges, interest, a transfer already
 * recorded as a contra.
 *
 * Kept distinct from reconciled, because "this is accounted for elsewhere" and
 * "this matches that voucher" are different claims, and a reconciliation
 * statement must be able to tell them apart.
 */
export async function ignoreLine(
  tx: Tx,
  input: { statementLineId: string; userId: string | null },
): Promise<void> {
  const { rows } = await tx.execute<{ status: string }>(sql`
    select status from bank_statement_lines where id = ${input.statementLineId}::uuid
  `);
  if (!rows[0]) throw notFound('That statement line does not exist in this company.');
  if (rows[0].status === 'reconciled') {
    throw conflict('That line is already reconciled against a voucher.');
  }

  await tx.execute(sql`
    update bank_statement_lines set status = 'ignored' where id = ${input.statementLineId}::uuid
  `);
  await tx.execute(sql`
    update bank_match_suggestions
       set decided_at = now(), decided_by = ${input.userId}::uuid, decision = 'rejected'
     where statement_line_id = ${input.statementLineId}::uuid and decided_at is null
  `);
}

/** Undoes a reconciliation, so a mistaken match can be corrected. */
export async function unreconcileLine(
  tx: Tx,
  input: { statementLineId: string },
): Promise<void> {
  await tx.execute(sql`
    update bank_statement_lines
       set status = 'unmatched', matched_voucher_id = null,
           reconciled_at = null, reconciled_by = null
     where id = ${input.statementLineId}::uuid and status = 'reconciled'
  `);
}

/** Vouchers of a type that should appear on a bank statement but have not. */
export async function unreconciledVouchers(
  tx: Tx,
  input: { ledgerAccountId: string; asOf: string },
) {
  return tx
    .select({
      id: vouchers.id,
      voucherNo: vouchers.voucherNo,
      voucherType: vouchers.voucherType,
      voucherDate: vouchers.voucherDate,
      totalPaise: vouchers.totalPaise,
    })
    .from(vouchers)
    .where(
      sql`${vouchers.status} = 'posted'
          and ${vouchers.voucherDate} <= ${input.asOf}::date
          and ${vouchers.reversedByVoucherId} is null
          and exists (
            select 1 from ledger_entries l
             where l.voucher_id = ${vouchers.id}
               and l.account_id = ${input.ledgerAccountId}::uuid
          )
          and not exists (
            select 1 from bank_statement_lines bl where bl.matched_voucher_id = ${vouchers.id}
          )`,
    )
    .orderBy(vouchers.voucherDate);
}
