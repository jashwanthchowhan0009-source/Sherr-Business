import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * The screen lock's six-digit PIN.
 *
 * A six-digit PIN has a million combinations, which is nothing — a machine
 * allowed to guess freely exhausts it in seconds. Everything that makes this
 * worth having is therefore about limiting guesses, not about the PIN itself:
 * the hash is deliberately slow, and five wrong answers stop it dead.
 *
 * On the hash: scrypt, from Node's own crypto. It is a memory-hard password
 * hash of the same family as argon2 and bcrypt, and OWASP lists all three as
 * acceptable. It is used here in preference to the other two only because it
 * needs no native module, which on a serverless deployment is one fewer thing
 * to break at build time. Swapping in argon2 would mean changing this file and
 * nothing else — the rest of the product only ever sees {@link hashPin} and
 * {@link verifyPin}.
 *
 * It is a second factor in front of a session that is already authenticated, not
 * a replacement for signing in. Someone who does not know the PIN and cannot
 * sign in sees nothing; someone who can sign in can always set a new one. That
 * is the same bargain a banking app's MPIN makes, and it is the right one: the
 * threat is a borrowed laptop or a shoulder, not a determined attacker who has
 * already taken the account.
 */

/** Exactly six digits. Nothing else is a PIN. */
export const PIN_PATTERN = /^[0-9]{6}$/;

/** Wrong guesses allowed before the PIN is locked outright. */
export const MAX_ATTEMPTS = 5;

/** An unlock dies this long after the last authenticated request. */
export const IDLE_TIMEOUT_SECONDS = 5 * 60;

/** And this long regardless, so a tab left open all night is not still open. */
export const ABSOLUTE_TIMEOUT_SECONDS = 12 * 60 * 60;

export interface StoredPin {
  hash: string;
  salt: string;
}

/**
 * PINs refused at the point of choosing.
 *
 * Not a blocklist of the "top N" — a short list of *shapes*. Every repeated
 * digit, every run of six consecutive digits in either direction, and the handful
 * of keypad patterns people reach for first. Between them these are a large
 * share of the PINs actually chosen, and each is among the first a person would
 * try on a borrowed laptop.
 */
const SHAPES: readonly RegExp[] = [
  /^(\d)\1{5}$/, // 000000, 111111 …
];

const SEQUENCES = new Set<string>();
for (let start = 0; start <= 4; start += 1) {
  const up = [0, 1, 2, 3, 4, 5].map((i) => (start + i) % 10).join('');
  SEQUENCES.add(up);
  SEQUENCES.add([...up].reverse().join(''));
}
// Keypad patterns and dates people reach for. Short on purpose: a long blocklist
// gives a false sense of having solved a problem that rate limiting solves.
for (const p of ['123456', '654321', '121212', '112233', '102030', '147258', '159753', '080808']) {
  SEQUENCES.add(p);
}

export type PinRejection =
  | { ok: true }
  | { ok: false; reason: 'format' | 'shape'; message: string };

export function checkPinStrength(pin: string): PinRejection {
  if (!PIN_PATTERN.test(pin)) {
    return { ok: false, reason: 'format', message: 'The PIN is six digits.' };
  }
  if (SHAPES.some((re) => re.test(pin)) || SEQUENCES.has(pin)) {
    return {
      ok: false,
      reason: 'shape',
      message: 'That PIN is among the first anybody would try. Choose another.',
    };
  }
  return { ok: true };
}

/**
 * Hashing, slowly and with a per-PIN salt.
 *
 * scrypt rather than a plain digest: a fast hash plus a million possible PINs is
 * a lookup table, and a per-user salt is what stops one table covering everybody.
 * Node ships it, so this adds no dependency to keep current.
 */
export async function hashPin(pin: string): Promise<StoredPin> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(pin.normalize('NFKC'), salt, 64)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

/** Constant-time comparison, so a wrong PIN takes as long as a right one. */
export async function verifyPin(pin: string, stored: StoredPin): Promise<boolean> {
  if (!PIN_PATTERN.test(pin)) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(stored.hash, 'hex');
  } catch {
    return false;
  }
  // A stored hash of the wrong length cannot be compared in constant time, and
  // treating it as a match would be the worst possible failure.
  if (expected.length !== 64) return false;

  const actual = (await scrypt(pin.normalize('NFKC'), stored.salt, 64)) as Buffer;
  return timingSafeEqual(actual, expected);
}

/**
 * Whether this many wrong guesses locks the PIN.
 *
 * A hard lock rather than a lengthening wait. A timed lockout only slows an
 * attacker down; five chances and then a stop means a million-guess search never
 * gets past its fifth guess, and the way back is re-verifying the second factor
 * rather than waiting. The cost is that a legitimate user who fumbles five times
 * has to re-verify — which is a worse day than a short wait, but a better one
 * than somebody else reading their books.
 */
export function isLockedOut(failures: number): boolean {
  return failures >= MAX_ATTEMPTS;
}

/** Guesses left before the lock. Zero means locked. */
export function attemptsLeft(failures: number): number {
  return Math.max(0, MAX_ATTEMPTS - failures);
}

/** A random, unguessable session token. Hashed before it is stored. */
export function newUnlockToken(): string {
  return randomBytes(32).toString('hex');
}
