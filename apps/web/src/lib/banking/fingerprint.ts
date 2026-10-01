import { createHash } from 'node:crypto';

/**
 * A deterministic fingerprint for a bank transaction.
 *
 * People export overlapping date ranges — the same fortnight twice, or a fresh
 * statement that repeats last month — so the same transaction arrives more than
 * once as a matter of course. Without a fingerprint, every re-import doubles the
 * review queue and then double-counts the money when both copies are reconciled.
 *
 * The narration is normalised before hashing, because the same transaction can
 * come back with different spacing or casing from a different export. The
 * balance is deliberately NOT part of it: a statement re-exported after later
 * transactions were added shows a different running balance for the same
 * transaction, and including it would make every line look new.
 *
 * The row number is also excluded, for the same reason: it changes with the
 * export, not with the transaction.
 */
export function transactionFingerprint(input: {
  bankAccountId: string;
  date: string;
  amountPaise: bigint;
  narration: string;
  reference: string | null;
}): string {
  const narration = input.narration.toUpperCase().replace(/\s+/g, ' ').trim();
  const reference = (input.reference ?? '').toUpperCase().replace(/\s+/g, '').trim();

  return createHash('sha256')
    .update(
      [
        input.bankAccountId,
        input.date,
        input.amountPaise.toString(),
        narration,
        reference,
      ].join('\u0000'),
    )
    .digest('hex');
}
