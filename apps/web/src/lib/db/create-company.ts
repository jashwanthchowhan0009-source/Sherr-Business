/**
 * The one statement that creates a company, shared by every caller.
 *
 * This module is deliberately not `server-only`: the seed script and the
 * integration fixtures connect as the owner role with their own pool, and they
 * must create companies exactly the way onboarding does. When they had their
 * own shortcut, they produced organizations with no chart of accounts — which
 * look fine until the first voucher fails. There is now one path.
 */
import { ACCOUNT_GROUPS, ACCOUNTS } from '@/lib/accounting/chart-of-accounts';

export interface CompanySeed {
  clerkOrgId: string;
  legalName: string;
  ownerUserId: string;
  tradeName?: string | null;
  gstin?: string | null;
  pan?: string | null;
  stateCode?: string | null;
  registrationType?: string;
  fyStartMonth?: number;
  booksStartDate?: string | null;
}

/** 1 April of the financial year containing `now`. */
export function defaultBooksStartDate(now: Date = new Date()): string {
  const year = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${year}-04-01`;
}

export const CREATE_COMPANY_SQL = `select app_create_company(
  $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9::int, $10::date, $11::jsonb, $12::jsonb
) as id`;

/**
 * Positional parameters for CREATE_COMPANY_SQL. The chart of accounts travels
 * as jsonb so src/lib/accounting/chart-of-accounts.ts stays the single source
 * of truth and the database never carries a second copy of it.
 */
export function createCompanyParams(input: CompanySeed): unknown[] {
  return [
    input.clerkOrgId,
    input.legalName,
    input.ownerUserId,
    input.tradeName ?? null,
    input.gstin ?? null,
    input.pan ?? null,
    input.stateCode ?? null,
    input.registrationType ?? 'regular',
    input.fyStartMonth ?? 4,
    input.booksStartDate ?? defaultBooksStartDate(),
    JSON.stringify(ACCOUNT_GROUPS),
    JSON.stringify(ACCOUNTS),
  ];
}
