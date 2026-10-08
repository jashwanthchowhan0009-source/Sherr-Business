'use server';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { accounts, bankAccounts } from '@/lib/db/schema';
import {
  acceptSuggestion as acceptSuggestionRow,
  generateSuggestions,
  ignoreLine as ignoreLineRow,
  rejectSuggestion as rejectSuggestionRow,
  storeStatement,
  unreconcileLine as unreconcileLineRow,
} from '@/lib/db/banking';
import {
  UnreadableStatementError,
  parseStatement,
  verifyRunningBalance,
} from '@/lib/banking/statement-parser';
import { conflict, invalidInput, notFound } from '@/lib/errors';

const optional = (schema: z.ZodString) => schema.optional().or(z.literal(''));

const bankAccountSchema = z.object({
  ledgerAccountId: z.string().uuid('Choose the ledger account this bank account posts to'),
  bankName: z.string().trim().min(2, 'Enter the bank name').max(100),
  accountLabel: z.string().trim().min(2, 'Give this account a name you will recognise').max(100),
  accountNumberLast4: optional(z.string().trim().regex(/^[0-9]{4}$/, 'Just the last four digits')),
  ifsc: optional(
    z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC is 11 characters: four letters, a zero, then six letters or digits'),
  ),
});

const addBankAccountAction = defineAction({
  name: 'bank.account.added',
  capability: 'bank:import',
  input: bankAccountSchema,
  handler: async ({ tx, orgId, input, audit }) => {
    const [ledger] = await tx
      .select({ id: accounts.id, code: accounts.code })
      .from(accounts)
      .where(eq(accounts.id, input.ledgerAccountId));
    if (!ledger) throw notFound('That ledger account does not exist in this company.');

    const [row] = await tx
      .insert(bankAccounts)
      .values({
        orgId,
        ledgerAccountId: input.ledgerAccountId,
        bankName: input.bankName,
        accountLabel: input.accountLabel,
        // Only the last four digits are stored: the full number is not needed to
        // reconcile and is not worth holding.
        accountNumberLast4: input.accountNumberLast4 || null,
        ifsc: input.ifsc || null,
      })
      .returning();
    if (!row) throw new Error('Bank account insert returned no row');

    await audit({
      action: 'bank.account.added',
      subjectKind: 'bank_account',
      subjectId: row.id,
      after: {
        bankName: row.bankName,
        accountLabel: row.accountLabel,
        last4: row.accountNumberLast4,
        ledgerAccount: ledger.code,
      },
    });

    revalidatePath('/process');
    return { id: row.id, label: `${row.bankName} — ${row.accountLabel}` };
  },
});

/**
 * Editing a bank account's details.
 *
 * The ledger account it posts to can only change while no statement has been
 * imported: once lines have been reconciled against one ledger, moving the
 * account to another would leave those reconciliations pointing at entries the
 * account no longer owns.
 */
const updateBankAccountAction = defineAction({
  name: 'bank.account.updated',
  capability: 'bank:import',
  input: bankAccountSchema.extend({
    id: z.string().uuid(),
    isActive: z.coerce.boolean().default(true),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, input.id), eq(bankAccounts.orgId, orgId)));
    if (!before) throw notFound('Bank account');

    if (input.ledgerAccountId !== before.ledgerAccountId) {
      const { rows } = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from bank_statements where bank_account_id = ${input.id}::uuid
      `);
      if (Number(rows[0]?.n ?? 0) > 0) {
        throw conflict(
          'Statements have already been imported into this account, so the ledger it posts to cannot change.',
        );
      }
      const [ledger] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, input.ledgerAccountId));
      if (!ledger) throw notFound('Ledger account');
    }

    const [row] = await tx
      .update(bankAccounts)
      .set({
        ledgerAccountId: input.ledgerAccountId,
        bankName: input.bankName,
        accountLabel: input.accountLabel,
        accountNumberLast4: input.accountNumberLast4 || null,
        ifsc: input.ifsc || null,
        isActive: input.isActive,
        updatedAt: new Date(),
      })
      .where(eq(bankAccounts.id, input.id))
      .returning();
    if (!row) throw notFound('Bank account');

    await audit({
      action: 'bank.account.updated',
      subjectKind: 'bank_account',
      subjectId: row.id,
      before: {
        bankName: before.bankName, accountLabel: before.accountLabel,
        last4: before.accountNumberLast4, ifsc: before.ifsc, isActive: before.isActive,
      },
      after: {
        bankName: row.bankName, accountLabel: row.accountLabel,
        last4: row.accountNumberLast4, ifsc: row.ifsc, isActive: row.isActive,
      },
    });

    revalidatePath('/process');
    return { id: row.id, label: `${row.bankName} — ${row.accountLabel}` };
  },
});

const importSchema = z.object({
  bankAccountId: z.string().uuid('Choose a bank account'),
  /** The uploaded file this came from, so the figures trace to a document. */
  documentId: z.string().uuid().optional().or(z.literal('')),
  /** The CSV text. Base64 so the bytes survive unchanged. */
  contentBase64: z.string().min(1),
});

/**
 * Imports a bank statement.
 *
 * Importing changes no ledger balance and posts nothing. It records what the bank
 * says happened, then proposes matches against what the books already say. The
 * decision to accept a match is separate and separately gated.
 */
const importStatementAction = defineAction({
  name: 'bank.statement.imported',
  capability: 'bank:import',
  input: importSchema,
  rateLimit: { limit: 10, windowSeconds: 60 },
  handler: async ({ tx, input, userId, audit }) => {
    const [account] = await tx
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.id, input.bankAccountId));
    if (!account) throw notFound('That bank account does not exist in this company.');

    const text = Buffer.from(input.contentBase64, 'base64').toString('utf8');

    let parsed;
    try {
      parsed = parseStatement(text);
    } catch (err) {
      if (err instanceof UnreadableStatementError) throw invalidInput(err.message);
      throw err;
    }

    if (parsed.lines.length === 0) {
      throw invalidInput(
        parsed.problems.length > 0
          ? `No readable transactions. The first problem is on row ${parsed.problems[0]?.rowNumber}: ${parsed.problems[0]?.reason}`
          : 'That file contained no transactions.',
      );
    }

    const balance = verifyRunningBalance(parsed.lines);

    const stored = await storeStatement(tx, {
      bankAccountId: input.bankAccountId,
      documentId: input.documentId || null,
      lines: parsed.lines,
      problemCount: parsed.problems.length,
      openingBalancePaise: parsed.openingBalancePaise,
      closingBalancePaise: parsed.closingBalancePaise,
      balanceConsistent: balance.consistent,
      importedBy: userId,
    });

    const matched = await generateSuggestions(tx, { bankAccountId: input.bankAccountId });

    await audit({
      action: 'bank.statement.imported',
      subjectKind: 'bank_statement',
      subjectId: stored.statementId,
      after: {
        bankAccount: `${account.bankName} — ${account.accountLabel}`,
        linesRead: parsed.lines.length,
        linesInserted: stored.inserted,
        duplicatesSkipped: stored.duplicates,
        problems: parsed.problems.length,
        balanceConsistent: balance.consistent,
        suggested: matched.suggested,
      },
    });

    revalidatePath('/process');
    revalidatePath('/output');
    return {
      statementId: stored.statementId,
      linesRead: parsed.lines.length,
      inserted: stored.inserted,
      duplicates: stored.duplicates,
      problems: parsed.problems.map((p) => ({
        rowNumber: p.rowNumber,
        reason: p.reason,
      })),
      balanceConsistent: balance.consistent,
      firstBalanceBreakRow: balance.firstBreakRowNumber,
      suggested: matched.suggested,
      unmatched: matched.unmatched,
    };
  },
});

const rematchAction = defineAction({
  name: 'bank.rematched',
  capability: 'bank:reconcile',
  input: z.object({ bankAccountId: z.string().uuid() }),
  handler: async ({ tx, input, audit }) => {
    const result = await generateSuggestions(tx, { bankAccountId: input.bankAccountId });
    await audit({
      action: 'bank.rematched',
      subjectKind: 'bank_account',
      subjectId: input.bankAccountId,
      after: { suggested: result.suggested, unmatched: result.unmatched },
    });
    revalidatePath('/process');
    return result;
  },
});

/**
 * Accepting a match reconciles the line against the voucher. Nothing is posted:
 * the voucher already carries its ledger entries, and posting here would make
 * the same money appear in the books twice.
 */
const acceptMatchAction = defineAction({
  name: 'bank.match.accepted',
  capability: 'bank:reconcile',
  input: z.object({ suggestionId: z.string().uuid() }),
  handler: async ({ tx, input, userId, audit }) => {
    const result = await acceptSuggestionRow(tx, {
      suggestionId: input.suggestionId,
      userId,
    });
    await audit({
      action: 'bank.match.accepted',
      subjectKind: 'bank_statement_line',
      subjectId: result.statementLineId,
      after: { reconciledAgainst: result.voucherNo, decidedBy: userId },
    });
    revalidatePath('/process');
    revalidatePath('/output');
    return result;
  },
});

const rejectMatchAction = defineAction({
  name: 'bank.match.rejected',
  capability: 'bank:reconcile',
  input: z.object({ suggestionId: z.string().uuid() }),
  handler: async ({ tx, input, userId, audit }) => {
    const result = await rejectSuggestionRow(tx, {
      suggestionId: input.suggestionId,
      userId,
    });
    await audit({
      action: 'bank.match.rejected',
      subjectKind: 'bank_statement_line',
      subjectId: result.statementLineId,
      after: { decidedBy: userId },
    });
    revalidatePath('/process');
    return result;
  },
});

const ignoreLineAction = defineAction({
  name: 'bank.line.ignored',
  capability: 'bank:reconcile',
  input: z.object({
    statementLineId: z.string().uuid(),
    reason: z.string().trim().min(3, 'Say why this line needs no voucher').max(200),
  }),
  handler: async ({ tx, input, userId, audit }) => {
    await ignoreLineRow(tx, { statementLineId: input.statementLineId, userId });
    await audit({
      action: 'bank.line.ignored',
      subjectKind: 'bank_statement_line',
      subjectId: input.statementLineId,
      after: { reason: input.reason },
    });
    revalidatePath('/process');
    return { id: input.statementLineId };
  },
});

const unreconcileAction = defineAction({
  name: 'bank.line.unreconciled',
  capability: 'bank:reconcile',
  input: z.object({
    statementLineId: z.string().uuid(),
    reason: z.string().trim().min(3, 'Say why this is being unreconciled').max(200),
  }),
  handler: async ({ tx, input, audit }) => {
    await unreconcileLineRow(tx, { statementLineId: input.statementLineId });
    await audit({
      action: 'bank.line.unreconciled',
      subjectKind: 'bank_statement_line',
      subjectId: input.statementLineId,
      before: { status: 'reconciled' },
      after: { status: 'unmatched', reason: input.reason },
    });
    revalidatePath('/process');
    revalidatePath('/output');
    return { id: input.statementLineId };
  },
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function addBankAccount(input: unknown) {
  return addBankAccountAction(input);
}

export async function importStatement(input: unknown) {
  return importStatementAction(input);
}

export async function rematchStatement(input: unknown) {
  return rematchAction(input);
}

export async function acceptMatch(input: unknown) {
  return acceptMatchAction(input);
}

export async function rejectMatch(input: unknown) {
  return rejectMatchAction(input);
}

export async function ignoreStatementLine(input: unknown) {
  return ignoreLineAction(input);
}

export async function unreconcileStatementLine(input: unknown) {
  return unreconcileAction(input);
}

export async function updateBankAccount(input: unknown) {
  return updateBankAccountAction(input);
}
