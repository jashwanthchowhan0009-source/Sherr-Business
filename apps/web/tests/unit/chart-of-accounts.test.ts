import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  ACCOUNT_GROUPS,
  natureOf,
  rootGroupOf,
  SYSTEM_ACCOUNT_CODES,
} from '../../src/lib/accounting/chart-of-accounts';

/**
 * Structural invariants of the seeded chart. These are cheap to assert and
 * expensive to discover later: a dangling group reference or a duplicated code
 * only shows up once a company has been created with it and postings exist.
 */
describe('account groups', () => {
  it('has unique codes', () => {
    const codes = ACCOUNT_GROUPS.map((g) => g.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('names only parents that exist', () => {
    const codes = new Set(ACCOUNT_GROUPS.map((g) => g.code));
    for (const group of ACCOUNT_GROUPS) {
      if (group.parent) expect(codes.has(group.parent), `${group.code} -> ${group.parent}`).toBe(true);
    }
  });

  it('resolves every group to a root without cycling', () => {
    for (const group of ACCOUNT_GROUPS) {
      expect(() => rootGroupOf(group.code), group.code).not.toThrow();
      expect(rootGroupOf(group.code).parent).toBeNull();
    }
  });

  it('keeps a child in the same nature as its parent', () => {
    // A liability group under an asset root would silently invert the balance
    // sheet for everything posted beneath it.
    for (const group of ACCOUNT_GROUPS) {
      expect(group.nature, group.code).toBe(rootGroupOf(group.code).nature);
    }
  });

  it('covers all five natures', () => {
    const natures = new Set(ACCOUNT_GROUPS.map((g) => g.nature));
    expect([...natures].sort()).toEqual(['asset', 'equity', 'expense', 'income', 'liability']);
  });
});

describe('accounts', () => {
  it('has unique codes', () => {
    const codes = ACCOUNTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('names only groups that exist', () => {
    const codes = new Set(ACCOUNT_GROUPS.map((g) => g.code));
    for (const account of ACCOUNTS) {
      expect(codes.has(account.group), `${account.code} -> ${account.group}`).toBe(true);
    }
  });

  it('inherits a nature from its group', () => {
    for (const account of ACCOUNTS) {
      expect(() => natureOf(account.code), account.code).not.toThrow();
    }
  });

  it('carries the accounts the engines reference by code', () => {
    // Each of these is looked up by code by a later step: the rounding rule,
    // the GST engine, the receivable/payable control accounts.
    for (const required of [
      'ROUND_OFF',
      'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST',
      'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST',
      'SUNDRY_DEBTORS', 'SUNDRY_CREDITORS',
      'SALES', 'PURCHASES', 'CASH', 'STOCK_IN_HAND',
      'TDS_PAYABLE', 'TDS_RECEIVABLE', 'RETAINED_EARNINGS',
    ]) {
      expect(SYSTEM_ACCOUNT_CODES, required).toContain(required);
    }
  });

  it('puts output tax in liabilities and input tax in assets', () => {
    // Getting this backwards is the classic GST ledger error: output tax is
    // owed to the government, input tax is recoverable from it.
    for (const code of ['OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'TDS_PAYABLE']) {
      expect(natureOf(code), code).toBe('liability');
    }
    for (const code of ['INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'TDS_RECEIVABLE']) {
      expect(natureOf(code), code).toBe('asset');
    }
  });

  it('places the control accounts on the right side', () => {
    expect(natureOf('SUNDRY_DEBTORS')).toBe('asset');
    expect(natureOf('SUNDRY_CREDITORS')).toBe('liability');
  });

  it('keeps Round Off where a difference of either sign can land', () => {
    expect(natureOf('ROUND_OFF')).toBe('expense');
  });
});
