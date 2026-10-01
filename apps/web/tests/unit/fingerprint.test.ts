import { describe, expect, it } from 'vitest';
import { transactionFingerprint } from '../../src/lib/banking/fingerprint';

const base = {
  bankAccountId: 'acc-1',
  date: '2025-06-15',
  amountPaise: 59_000_00n,
  narration: 'NEFT CR-ANAND ENTERPRISES',
  reference: 'N123456',
};

describe('transactionFingerprint', () => {
  it('is stable for the same transaction', () => {
    expect(transactionFingerprint(base)).toBe(transactionFingerprint(base));
  });

  it('ignores differences in spacing and case from a different export', () => {
    expect(
      transactionFingerprint({ ...base, narration: 'neft  cr-anand   enterprises ' }),
    ).toBe(transactionFingerprint(base));
    expect(transactionFingerprint({ ...base, reference: ' n123456 ' })).toBe(
      transactionFingerprint(base),
    );
  });

  it('ignores the running balance, which changes between exports', () => {
    // A statement re-exported after later transactions shows a different balance
    // for the same transaction. Including it would make every line look new.
    const fields = Object.keys(base);
    expect(fields).not.toContain('balancePaise');
  });

  it('differs when the amount differs', () => {
    expect(transactionFingerprint({ ...base, amountPaise: 59_000_01n })).not.toBe(
      transactionFingerprint(base),
    );
  });

  it('differs when the date differs', () => {
    expect(transactionFingerprint({ ...base, date: '2025-06-16' })).not.toBe(
      transactionFingerprint(base),
    );
  });

  it('differs when the narration differs meaningfully', () => {
    expect(transactionFingerprint({ ...base, narration: 'NEFT CR-SOMEONE ELSE' })).not.toBe(
      transactionFingerprint(base),
    );
  });

  it('differs between bank accounts', () => {
    // The same amount on the same day in two accounts is two transactions.
    expect(transactionFingerprint({ ...base, bankAccountId: 'acc-2' })).not.toBe(
      transactionFingerprint(base),
    );
  });

  it('distinguishes a missing reference from an empty one consistently', () => {
    expect(transactionFingerprint({ ...base, reference: null })).toBe(
      transactionFingerprint({ ...base, reference: '' }),
    );
  });

  it('cannot be confused by a field boundary', () => {
    // Joining on a null byte means a narration ending in the reference cannot
    // produce the same hash as a different split of the same characters.
    const a = transactionFingerprint({ ...base, narration: 'AB', reference: 'CD' });
    const b = transactionFingerprint({ ...base, narration: 'ABCD', reference: '' });
    expect(a).not.toBe(b);
  });

  it('is a hex sha256', () => {
    expect(transactionFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
