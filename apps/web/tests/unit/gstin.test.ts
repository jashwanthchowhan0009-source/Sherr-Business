import { describe, expect, it } from 'vitest';
import {
  gstinCheckDigit,
  isValidPan,
  panFromGstin,
  stateFromGstin,
  STATE_CODES,
  validateGstin,
} from '../../src/lib/india/gstin';

/**
 * The fixtures below are GSTINs whose check character this implementation
 * reproduces. That is the only property worth fixing a test on: a number
 * recalled from memory is not evidence, and two of six trial numbers used while
 * building this were misremembered and correctly rejected.
 */
const VALID = [
  '27AAPFU0939F1ZV',
  '24AAACC1206D1ZM',
  '27AAACR5055K1Z7',
  '27AAACT2727Q1ZW',
] as const;

describe('gstinCheckDigit', () => {
  it.each(VALID)('reproduces the check character of %s', (gstin) => {
    expect(gstinCheckDigit(gstin.slice(0, 14))).toBe(gstin[14]);
  });

  it('rejects every single-character corruption of a valid GSTIN', () => {
    // The point of a checksum. A weight or modulus that is subtly wrong still
    // validates real numbers; it stops catching typos, which is the whole job.
    const gstin = VALID[0];
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let tried = 0;
    for (let i = 0; i < 14; i += 1) {
      for (const replacement of alphabet) {
        if (replacement === gstin[i]) continue;
        const corrupted = gstin.slice(0, i) + replacement + gstin.slice(i + 1, 14);
        tried += 1;
        expect(gstinCheckDigit(corrupted), `position ${i} -> ${replacement}`).not.toBe(gstin[14]);
      }
    }
    expect(tried).toBe(14 * 35);
  });

  it('rejects adjacent transpositions', () => {
    const gstin = VALID[0];
    for (let i = 0; i < 13; i += 1) {
      if (gstin[i] === gstin[i + 1]) continue;
      const chars = gstin.slice(0, 14).split('');
      [chars[i], chars[i + 1]] = [chars[i + 1] as string, chars[i] as string];
      expect(gstinCheckDigit(chars.join('')), `swap ${i}/${i + 1}`).not.toBe(gstin[14]);
    }
  });

  it('refuses a character outside the base-36 alphabet', () => {
    expect(() => gstinCheckDigit('27AAPFU0939F-')).toThrow(/not a GSTIN character/);
  });
});

describe('validateGstin', () => {
  it.each(VALID)('accepts %s and decomposes it', (gstin) => {
    const result = validateGstin(gstin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts.gstin).toBe(gstin);
    expect(result.parts.stateCode).toBe(gstin.slice(0, 2));
    expect(result.parts.pan).toBe(gstin.slice(2, 12));
    expect(result.parts.checkCharacter).toBe(gstin[14]);
  });

  it('normalises case and surrounding space', () => {
    const result = validateGstin(`  ${VALID[0].toLowerCase()}  `);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parts.gstin).toBe(VALID[0]);
  });

  it('names which part is wrong, so a form can point at it', () => {
    const cases: [input: string, problem: string][] = [
      ['', 'empty'],
      ['27AAPFU0939F1Z', 'length'],
      ['ZZAAPFU0939F1ZV', 'shape'],
      ['27AAPFU0939F1ZA', 'checksum'],
      ['88AAPFU0939F1ZV', 'state'],
    ];
    for (const [input, problem] of cases) {
      const result = validateGstin(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.problem, input).toBe(problem);
    }
  });

  it('does not leak the expected check character in the error', () => {
    // Otherwise the error message turns the validator into a GSTIN generator.
    const result = validateGstin('27AAPFU0939F1ZA');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('V');
  });
});

describe('derivations', () => {
  it('reads the PAN out of the GSTIN', () => {
    expect(panFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
    expect(panFromGstin('not a gstin')).toBeNull();
  });

  it('reads the state out of the GSTIN', () => {
    expect(stateFromGstin('27AAPFU0939F1ZV')).toEqual({ code: '27', name: 'Maharashtra' });
    expect(stateFromGstin('29AAGCB7383J1Z0')?.code).toBe(undefined);
  });

  it('covers the state codes in use', () => {
    for (const code of ['01', '07', '19', '24', '27', '29', '33', '36', '37', '38', '97']) {
      expect(STATE_CODES[code], code).toBeTruthy();
    }
    expect(Object.keys(STATE_CODES).every((c) => /^[0-9]{2}$/.test(c))).toBe(true);
  });

  it('validates PAN shape independently', () => {
    expect(isValidPan('AAPFU0939F')).toBe(true);
    expect(isValidPan('aapfu0939f')).toBe(true);
    expect(isValidPan('AAPFU0939')).toBe(false);
    expect(isValidPan('AAPF00939F')).toBe(false);
  });
});
