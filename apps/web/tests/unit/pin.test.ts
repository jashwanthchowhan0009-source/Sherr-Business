import { describe, expect, it } from 'vitest';
import {
  FREE_ATTEMPTS,
  MAX_LOCKOUT_SECONDS,
  checkPinStrength,
  hashPin,
  lockoutFor,
  newUnlockToken,
  verifyPin,
} from '@/lib/auth/pin';

describe('checkPinStrength', () => {
  it('takes six digits', () => {
    for (const pin of ['481902', '305729', '860413']) {
      expect(checkPinStrength(pin), pin).toEqual({ ok: true });
    }
  });

  it('refuses anything that is not six digits', () => {
    for (const pin of ['12345', '1234567', '12a456', '', '  1234', '١٢٣٤٥٦']) {
      const result = checkPinStrength(pin);
      expect(result.ok, pin).toBe(false);
      if (!result.ok) expect(result.reason).toBe('format');
    }
  });

  it('refuses a repeated digit', () => {
    for (const d of '0123456789') {
      const pin = d.repeat(6);
      const result = checkPinStrength(pin);
      expect(result.ok, pin).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    }
  });

  it('refuses a run of consecutive digits in either direction', () => {
    for (const pin of ['123456', '234567', '456789', '654321', '987654']) {
      expect(checkPinStrength(pin).ok, pin).toBe(false);
    }
  });

  it('refuses the keypad patterns people reach for first', () => {
    for (const pin of ['121212', '112233', '147258', '159753']) {
      expect(checkPinStrength(pin).ok, pin).toBe(false);
    }
  });

  it('allows a PIN that merely looks like a date', () => {
    // The blocklist is a few shapes, not a guess at what is memorable. Refusing
    // every birthday would reject most of the usable space and still not make a
    // six-digit PIN strong — the rate limiting does that.
    expect(checkPinStrength('150892').ok).toBe(true);
    expect(checkPinStrength('010203').ok).toBe(true);
  });
});

describe('hashPin / verifyPin', () => {
  it('accepts the right PIN', async () => {
    const stored = await hashPin('481902');
    expect(await verifyPin('481902', stored)).toBe(true);
  });

  it('rejects every other PIN', async () => {
    const stored = await hashPin('481902');
    for (const wrong of ['481903', '184902', '000000', '12345']) {
      expect(await verifyPin(wrong, stored), wrong).toBe(false);
    }
  });

  it('salts, so the same PIN hashes differently for two people', async () => {
    // Without this one rainbow table covers every user, which for a million
    // possible PINs is a small table.
    const a = await hashPin('481902');
    const b = await hashPin('481902');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // And neither salt verifies the other's hash.
    expect(await verifyPin('481902', { hash: a.hash, salt: b.salt })).toBe(false);
  });

  it('never stores the PIN itself', async () => {
    const stored = await hashPin('481902');
    expect(stored.hash).not.toContain('481902');
    expect(stored.salt).not.toContain('481902');
    expect(stored.hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('refuses a stored hash of the wrong length rather than matching it', async () => {
    // A truncated or corrupted row must fail closed; treating it as a match
    // would be the worst possible failure.
    expect(await verifyPin('481902', { hash: '', salt: 'abc' })).toBe(false);
    expect(await verifyPin('481902', { hash: 'ab'.repeat(16), salt: 'abc' })).toBe(false);
    expect(await verifyPin('481902', { hash: 'not hex at all', salt: 'abc' })).toBe(false);
  });
});

describe('lockoutFor', () => {
  it('costs nothing for the first few, because mistyping is ordinary', () => {
    for (let n = 0; n <= FREE_ATTEMPTS; n += 1) {
      expect(lockoutFor(n), String(n)).toBe(0);
    }
  });

  it('doubles after that', () => {
    expect(lockoutFor(FREE_ATTEMPTS + 1)).toBe(15);
    expect(lockoutFor(FREE_ATTEMPTS + 2)).toBe(30);
    expect(lockoutFor(FREE_ATTEMPTS + 3)).toBe(60);
    expect(lockoutFor(FREE_ATTEMPTS + 4)).toBe(120);
  });

  it('stops at a ceiling, so nobody is locked out for ever', () => {
    expect(lockoutFor(100)).toBe(MAX_LOCKOUT_SECONDS);
    expect(lockoutFor(10_000)).toBe(MAX_LOCKOUT_SECONDS);
  });

  it('makes exhausting a million PINs take years, which is the whole point', () => {
    // A six-digit PIN is not strong. The waiting is.
    const perGuessAtCeiling = MAX_LOCKOUT_SECONDS;
    const years = (1_000_000 * perGuessAtCeiling) / (60 * 60 * 24 * 365);
    expect(years).toBeGreaterThan(25);
  });
});

describe('newUnlockToken', () => {
  it('is long and random', () => {
    const a = newUnlockToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const many = new Set(Array.from({ length: 200 }, () => newUnlockToken()));
    expect(many.size).toBe(200);
  });
});
