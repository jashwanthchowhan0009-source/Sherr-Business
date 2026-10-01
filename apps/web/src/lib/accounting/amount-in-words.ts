/**
 * Amounts in words, in the Indian system.
 *
 * A tax invoice states the total in words, and it is the lakh/crore grouping
 * rather than the Western thousand/million one: 1,23,45,678 reads as "one crore
 * twenty three lakh forty five thousand six hundred seventy eight", not "twelve
 * million …".
 *
 * Integer arithmetic throughout, from paise. Taking a float here would make
 * the words disagree with the figures on the same page, at the worst possible
 * moment.
 */
import { PAISE_PER_RUPEE } from './units';

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
] as const;

const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
] as const;

/** 0–99. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const ones = ONES[n % 10] ?? '';
  return ones ? `${tens} ${ones}` : tens;
}

/** 0–999. */
function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return twoDigits(rest);
  const head = `${ONES[hundreds]} hundred`;
  return rest ? `${head} ${twoDigits(rest)}` : head;
}

/**
 * A whole number in Indian words. Groups are, from the right: hundreds, then
 * thousand, lakh, crore, and then crore again for anything larger — which is
 * how an arab is written on an invoice ("one thousand crore"), rather than
 * inventing a word most readers would not recognise.
 */
export function numberToIndianWords(value: bigint): string {
  if (value < 0n) return `minus ${numberToIndianWords(-value)}`;
  if (value === 0n) return 'zero';

  const parts: string[] = [];
  let rest = value;

  const lastThree = Number(rest % 1000n);
  rest /= 1000n;

  // Everything above a thousand goes in pairs of digits.
  const groups: { value: number; label: string }[] = [];
  const labels = ['thousand', 'lakh', 'crore'];
  for (const label of labels) {
    if (rest === 0n) break;
    groups.push({ value: Number(rest % 100n), label });
    rest /= 100n;
  }

  // Beyond a crore, keep counting in crore: 10,00,00,00,000 is "one thousand
  // crore", which is what an Indian reader expects rather than "one arab".
  //
  // The three groups above each consumed two digits, so what is left is in
  // units of a hundred crore, not of a crore. Scaling it back by 100 before
  // naming it is the whole of the correction: without it, 1,000 crore reads as
  // "ten crore", wrong by two orders of magnitude on the largest invoices.
  if (rest > 0n) {
    groups.push({ value: -1, label: `${numberToIndianWords(rest * 100n)} crore` });
  }

  for (const group of groups.reverse()) {
    if (group.value === -1) {
      parts.push(group.label);
    } else if (group.value !== 0) {
      parts.push(`${twoDigits(group.value)} ${group.label}`);
    }
  }

  if (lastThree !== 0) parts.push(threeDigits(lastThree));

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * The line an invoice prints: "Rupees One Lakh Eighteen Thousand Only".
 *
 * Paise are stated only when there are any, and "Only" closes the sentence —
 * both are the conventions a buyer's accounts department expects, and the
 * closing word is what stops anything being appended to a printed figure.
 */
export function amountInWords(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / PAISE_PER_RUPEE;
  const remainder = abs % PAISE_PER_RUPEE;

  const titled = (s: string) => s.split(' ').map(capitalise).join(' ');

  let text = `Rupees ${titled(numberToIndianWords(rupees))}`;
  if (remainder > 0n) {
    text += ` and ${titled(numberToIndianWords(remainder))} Paise`;
  }
  return `${negative ? 'Minus ' : ''}${text} Only`;
}
