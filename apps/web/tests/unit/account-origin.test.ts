import { describe, expect, it } from 'vitest';
import { ACCOUNTS, STANDARD_ACCOUNT_CODES, SYSTEM_ACCOUNT_CODES } from '../../src/lib/accounting/chart-of-accounts';

describe('where an account came from', () => {
  it('counts every seeded account as standard, system or not', () => {
    for (const a of ACCOUNTS) {
      expect(STANDARD_ACCOUNT_CODES.has(a.code), a.code).toBe(true);
    }
  });

  it('covers the editable ones a new company sees first', () => {
    // These were the two the Data page labelled "Added by you" to somebody who
    // had just created their company and added nothing.
    expect(STANDARD_ACCOUNT_CODES.has('CAPITAL_ACCOUNT')).toBe(true);
    expect(STANDARD_ACCOUNT_CODES.has('BANK_CHARGES')).toBe(true);
  });

  it('is wider than the system set, not a copy of it', () => {
    expect(STANDARD_ACCOUNT_CODES.size).toBeGreaterThan(SYSTEM_ACCOUNT_CODES.length);
    for (const code of SYSTEM_ACCOUNT_CODES) {
      expect(STANDARD_ACCOUNT_CODES.has(code), code).toBe(true);
    }
  });

  it('does not claim an account nobody seeded', () => {
    expect(STANDARD_ACCOUNT_CODES.has('MY_OWN_ACCOUNT')).toBe(false);
  });
});
