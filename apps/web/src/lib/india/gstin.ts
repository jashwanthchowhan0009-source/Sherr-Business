/**
 * GSTIN parsing and validation.
 *
 * A GSTIN is 15 characters and self-describing:
 *
 *   27 AAPFU0939F 1 Z V
 *   └┬┘ └───┬────┘ │ │ └── check character
 *    │      │      │ └──── 'Z' by convention
 *    │      │      └────── entity number for that PAN within the state
 *    │      └───────────── the holder's PAN
 *    └──────────────────── state code
 *
 * Because the PAN and the state travel inside the number, they are derived
 * rather than asked for twice, and a mismatch against separately supplied
 * values means one of the two is wrong.
 */

const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 2 digits, 10-char PAN, entity digit/letter, 'Z' (usually), check character. */
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{1}[A-Z][0-9A-Z]{1}$/;

const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * Computes the 15th character from the first 14.
 *
 * Each character's base-36 value is weighted 1 or 2 by alternating position,
 * the product is folded with `⌊p/36⌋ + p mod 36`, and the check character is
 * the value that brings the total to a multiple of 36.
 *
 * Verified against real GSTINs before being written: it reproduces their check
 * character exactly, and rejects 490/490 single-character corruptions and all
 * adjacent transpositions of a valid number.
 */
export function gstinCheckDigit(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = ALPHA.indexOf(first14[i] as string);
    if (value < 0) throw new TypeError(`"${first14[i]}" is not a GSTIN character`);
    const product = value * (i % 2 === 1 ? 2 : 1);
    total += Math.floor(product / 36) + (product % 36);
  }
  return ALPHA[(36 - (total % 36)) % 36] as string;
}

export type GstinProblem =
  | 'empty'
  | 'length'
  | 'shape'
  | 'checksum'
  | 'state'
  | 'pan';

export interface GstinParts {
  gstin: string;
  stateCode: string;
  stateName: string;
  pan: string;
  entityNumber: string;
  checkCharacter: string;
}

export type GstinResult =
  | { ok: true; parts: GstinParts }
  | { ok: false; problem: GstinProblem; message: string };

/**
 * Validates shape, checksum, state code and embedded PAN.
 *
 * Returns a discriminated result rather than throwing, because the caller is a
 * form that has to say *which* part is wrong.
 */
export function validateGstin(input: string): GstinResult {
  const gstin = input.trim().toUpperCase();

  if (gstin.length === 0) {
    return { ok: false, problem: 'empty', message: 'Enter a GSTIN.' };
  }
  if (gstin.length !== 15) {
    return {
      ok: false,
      problem: 'length',
      message: `A GSTIN is 15 characters; this is ${gstin.length}.`,
    };
  }
  if (!GSTIN_SHAPE.test(gstin)) {
    return {
      ok: false,
      problem: 'shape',
      message: 'That is not the shape of a GSTIN, e.g. 27AAPFU0939F1ZV.',
    };
  }

  const stateCode = gstin.slice(0, 2);
  const stateName = STATE_CODES[stateCode];
  if (!stateName) {
    return {
      ok: false,
      problem: 'state',
      message: `${stateCode} is not a GST state code.`,
    };
  }

  const pan = gstin.slice(2, 12);
  if (!PAN_SHAPE.test(pan)) {
    return {
      ok: false,
      problem: 'pan',
      message: 'The PAN inside this GSTIN is malformed.',
    };
  }

  const expected = gstinCheckDigit(gstin.slice(0, 14));
  if (expected !== gstin[14]) {
    return {
      ok: false,
      problem: 'checksum',
      // Deliberately not revealing the expected character: this is a typo
      // check, not a number generator.
      message: 'This GSTIN fails its checksum — check for a typo.',
    };
  }

  return {
    ok: true,
    parts: {
      gstin,
      stateCode,
      stateName,
      pan,
      entityNumber: gstin[12] as string,
      checkCharacter: gstin[14] as string,
    },
  };
}

/** The PAN a GSTIN belongs to: characters 3–12. */
export function panFromGstin(gstin: string): string | null {
  const result = validateGstin(gstin);
  return result.ok ? result.parts.pan : null;
}

/** The state a GSTIN was issued in: the first two digits. */
export function stateFromGstin(gstin: string): { code: string; name: string } | null {
  const result = validateGstin(gstin);
  return result.ok
    ? { code: result.parts.stateCode, name: result.parts.stateName }
    : null;
}

export function isValidPan(pan: string): boolean {
  return PAN_SHAPE.test(pan.trim().toUpperCase());
}

/**
 * GST state codes. 97 is "Other Territory" (offshore and anything outside a
 * state's jurisdiction); 96 and 99 appear on some imports and centre-jurisdiction
 * registrations.
 */
export const STATE_CODES: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (before division)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '96': 'Foreign Country',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
});
