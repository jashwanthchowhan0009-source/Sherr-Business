import { describe, expect, it } from 'vitest';
import { isPincode, stateFromPincode } from '@/lib/india/pincode';
import { STATE_CODES } from '@/lib/india/gstin';

describe('isPincode', () => {
  it('accepts six digits that do not start with zero', () => {
    for (const pin of ['500001', '110001', '400001', '999999']) {
      expect(isPincode(pin), pin).toBe(true);
    }
  });

  it('rejects anything else', () => {
    // A leading zero is not a real PIN code, and rejecting it also catches a
    // stray character pasted in front of one.
    for (const pin of ['012345', '50001', '5000011', '50000a', '', '   ', '500 001']) {
      expect(isPincode(pin), pin).toBe(false);
    }
  });

  it('ignores surrounding whitespace', () => {
    expect(isPincode('  500001 ')).toBe(true);
  });
});

describe('stateFromPincode', () => {
  it('names a single state where the prefix allows it', () => {
    const cases: [string, string][] = [
      ['110001', 'Delhi'],
      ['400001', 'Maharashtra'],
      ['560001', 'Karnataka'],
      ['600001', 'Tamil Nadu'],
      ['700001', 'West Bengal'],
      ['380001', 'Gujarat'],
      ['302001', 'Rajasthan'],
      ['751001', 'Odisha'],
      ['781001', 'Assam'],
      ['492001', 'Chhattisgarh'],
    ];
    for (const [pin, name] of cases) {
      const result = stateFromPincode(pin);
      expect(result.states[0]?.name, pin).toBe(name);
    }
  });

  it('marks a single candidate certain and several uncertain', () => {
    expect(stateFromPincode('110001').certain).toBe(true);
    // Telangana and Andhra Pradesh share a range, and putting a sale in the
    // wrong one turns an intra-state supply into an inter-state one.
    expect(stateFromPincode('500001').certain).toBe(false);
  });

  it('offers both states where a prefix genuinely spans two', () => {
    const pairs: [string, string[]][] = [
      ['500001', ['Telangana', 'Andhra Pradesh']],
      ['248001', ['Uttar Pradesh', 'Uttarakhand']],
      ['845001', ['Bihar', 'Jharkhand']],
      ['190001', ['Jammu and Kashmir', 'Ladakh']],
    ];
    for (const [pin, expected] of pairs) {
      expect(stateFromPincode(pin).states.map((s) => s.name), pin).toEqual(expected);
    }
  });

  it('finds the small states that sit inside a neighbour’s range', () => {
    // Without the three-digit table these land in Maharashtra, West Bengal and
    // Gujarat respectively.
    expect(stateFromPincode('403001').states[0]?.name).toBe('Goa');
    expect(stateFromPincode('744101').states[0]?.name).toBe('Andaman and Nicobar Islands');
    expect(stateFromPincode('737101').states[0]?.name).toBe('Sikkim');
    expect(stateFromPincode('396210').states[0]?.name).toMatch(/Daman/);
  });

  it('prefers the three-digit answer over the two-digit one', () => {
    // 40 is Maharashtra, but 403 is Goa.
    expect(stateFromPincode('400001').states[0]?.name).toBe('Maharashtra');
    expect(stateFromPincode('403001').states[0]?.name).toBe('Goa');
  });

  it('narrows the north-east to its own states rather than the whole country', () => {
    const result = stateFromPincode('795001');
    expect(result.states.length).toBeGreaterThan(1);
    expect(result.states.map((s) => s.name)).toContain('Manipur');
    // Still far shorter than the full list, which is the point.
    expect(result.states.length).toBeLessThan(Object.keys(STATE_CODES).length / 2);
  });

  it('says nothing rather than guessing on an unknown prefix', () => {
    // Guessing a state silently makes the tax on every invoice wrong.
    for (const pin of ['900001', '290001', '350001', '650001', '860001']) {
      const result = stateFromPincode(pin);
      expect(result.states, pin).toEqual([]);
      expect(result.certain, pin).toBe(false);
    }
  });

  it('says nothing for input that is not a PIN code at all', () => {
    for (const value of ['', 'abc', '50001', '012345']) {
      expect(stateFromPincode(value).states, value).toEqual([]);
    }
  });

  it('only ever names states the GST code table knows', () => {
    // A code the rest of the product cannot resolve would show as a bare number
    // on the invoice and in the returns.
    for (let pin = 100000; pin < 1000000; pin += 971) {
      for (const code of stateFromPincode(String(pin)).stateCodes) {
        expect(STATE_CODES[code], `${pin} → ${code}`).toBeDefined();
      }
    }
  });

  it('never returns a duplicate candidate', () => {
    for (let pin = 100000; pin < 1000000; pin += 1013) {
      const codes = stateFromPincode(String(pin)).stateCodes;
      expect(new Set(codes).size, String(pin)).toBe(codes.length);
    }
  });
});
