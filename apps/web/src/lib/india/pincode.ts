import { STATE_CODES } from './gstin';

/**
 * Which state a postal PIN code is in — as a suggestion, never as a decision.
 *
 * Asking "which state?" from a dropdown of thirty-eight is a worse question than
 * "what is your PIN code?", which is six digits every business knows and which
 * is printed on its letterhead. Browser geolocation would be worse again: it
 * needs a permission prompt, a network round trip to a geocoder, and it reports
 * where the laptop is rather than where the business is registered.
 *
 * The important part is what this does NOT do. The state decides whether a sale
 * is CGST and SGST or IGST, so getting it wrong makes the tax on every invoice
 * wrong, quietly. India's PIN prefixes do not map cleanly onto GST states: a
 * prefix can span two (Bihar and Jharkhand, Telangana and Andhra Pradesh, Uttar
 * Pradesh and Uttarakhand), and several small states and union territories sit
 * inside a neighbour's range. So this returns **candidates**, the form shows
 * them, and what the person picks is what is stored. A single candidate is
 * preselected for them; it is still theirs to change.
 *
 * Where a prefix is not recognised the answer is an empty list, which the form
 * reads as "ask normally". Guessing would be worse than not knowing.
 */

/** GST state codes, from {@link STATE_CODES}. */
const DELHI = '07', HARYANA = '06', PUNJAB = '03', CHANDIGARH = '04';
const HIMACHAL = '02', JK = '01', LADAKH = '38', UP = '09', UTTARAKHAND = '05';
const RAJASTHAN = '08', GUJARAT = '24', DNH_DD = '26', MAHARASHTRA = '27', GOA = '30';
const MP = '23', CHHATTISGARH = '22', TELANGANA = '36', AP = '37', KARNATAKA = '29';
const TAMIL_NADU = '33', PUDUCHERRY = '34', KERALA = '32', LAKSHADWEEP = '31';
const WEST_BENGAL = '19', SIKKIM = '11', ODISHA = '21', ASSAM = '18', ANDAMAN = '35';
const BIHAR = '10', JHARKHAND = '20';
const ARUNACHAL = '12', NAGALAND = '13', MANIPUR = '14', MIZORAM = '15';
const TRIPURA = '16', MEGHALAYA = '17';

/**
 * Three-digit prefixes that sit inside another state's two-digit range.
 *
 * Checked first, because the two-digit table would otherwise put Goa in
 * Maharashtra and the Andamans in West Bengal.
 */
const BY_THREE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '403': [GOA],
  '396': [DNH_DD, GUJARAT],
  '737': [SIKKIM],
  '744': [ANDAMAN],
  '682': [KERALA, LAKSHADWEEP],
});

/** Two-digit postal circles. Several are genuinely ambiguous; those list both. */
const BY_TWO: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '11': [DELHI],
  '12': [HARYANA],
  '13': [HARYANA, PUNJAB],
  '14': [PUNJAB],
  '15': [PUNJAB],
  '16': [CHANDIGARH, PUNJAB, HARYANA],
  '17': [HIMACHAL],
  '18': [JK, LADAKH],
  '19': [JK, LADAKH],
  '20': [UP], '21': [UP], '22': [UP], '23': [UP],
  '24': [UP, UTTARAKHAND],
  '25': [UP],
  '26': [UP, UTTARAKHAND],
  '27': [UP], '28': [UP],
  '30': [RAJASTHAN], '31': [RAJASTHAN], '32': [RAJASTHAN],
  '33': [RAJASTHAN], '34': [RAJASTHAN],
  '36': [GUJARAT], '37': [GUJARAT], '38': [GUJARAT], '39': [GUJARAT],
  '40': [MAHARASHTRA], '41': [MAHARASHTRA], '42': [MAHARASHTRA],
  '43': [MAHARASHTRA], '44': [MAHARASHTRA],
  '45': [MP], '46': [MP], '47': [MP], '48': [MP],
  '49': [CHHATTISGARH],
  // Hyderabad and the districts around it are Telangana; the rest of the range
  // is Andhra Pradesh. Both are offered because the boundary does not follow
  // the prefix, and putting a sale in the wrong one makes it inter-state.
  '50': [TELANGANA, AP],
  '51': [AP, TELANGANA],
  '52': [AP, TELANGANA],
  '53': [AP, TELANGANA],
  '56': [KARNATAKA], '57': [KARNATAKA], '58': [KARNATAKA], '59': [KARNATAKA],
  '60': [TAMIL_NADU, PUDUCHERRY],
  '61': [TAMIL_NADU], '62': [TAMIL_NADU], '63': [TAMIL_NADU], '64': [TAMIL_NADU],
  '67': [KERALA], '68': [KERALA], '69': [KERALA],
  '70': [WEST_BENGAL], '71': [WEST_BENGAL], '72': [WEST_BENGAL],
  '73': [WEST_BENGAL], '74': [WEST_BENGAL],
  '75': [ODISHA], '76': [ODISHA], '77': [ODISHA],
  '78': [ASSAM],
  // One range for seven states. Offering all of them is still a far shorter
  // list than the full thirty-eight.
  '79': [ARUNACHAL, NAGALAND, MANIPUR, MIZORAM, TRIPURA, MEGHALAYA, ASSAM],
  '80': [BIHAR], '81': [BIHAR], '82': [BIHAR],
  '83': [JHARKHAND], '84': [BIHAR, JHARKHAND], '85': [BIHAR],
});

export interface PincodeSuggestion {
  /** Candidate GST state codes, best first. Empty when the prefix is unknown. */
  stateCodes: string[];
  /** The same, with names, for the form to render. */
  states: { code: string; name: string }[];
  /** True when one state fits and the form may preselect it. */
  certain: boolean;
}

const EMPTY: PincodeSuggestion = { stateCodes: [], states: [], certain: false };

/** True for the six digits a PIN code is, and nothing else. */
export function isPincode(value: string): boolean {
  // A PIN code never starts with zero, which also rejects a stray leading
  // character pasted in front of a real one.
  return /^[1-9][0-9]{5}$/.test(value.trim());
}

export function stateFromPincode(value: string): PincodeSuggestion {
  const pin = value.trim();
  if (!isPincode(pin)) return EMPTY;

  const codes = BY_THREE[pin.slice(0, 3)] ?? BY_TWO[pin.slice(0, 2)];
  if (!codes || codes.length === 0) return EMPTY;

  return {
    stateCodes: [...codes],
    states: codes.map((code) => ({ code, name: STATE_CODES[code] ?? code })),
    certain: codes.length === 1,
  };
}
