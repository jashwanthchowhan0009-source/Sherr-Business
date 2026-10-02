import 'server-only';
import { auth } from '@clerk/nextjs/server';

/** How recently the second factor must have been proved to reset a PIN. */
export const REVERIFY_WITHIN_MINUTES = 10;

export type ReverifyState =
  /** A second factor was proved within the window. A reset may proceed. */
  | { fresh: true }
  /** The session is genuine but the verification is older than the window. */
  | { fresh: false; reason: 'stale' }
  /**
   * The session token carries no factor-verification age, so freshness cannot be
   * judged at all. Distinguished from `stale` because the remedy is different and
   * the user cannot act on it: signing in again produces the same empty claim, so
   * telling them to is a loop they can never leave.
   */
  | { fresh: false; reason: 'unavailable' };

/**
 * Reads how recently this session proved a second factor.
 *
 * Clerk puts a factor-verification age on the session token as `fva`: a pair of
 * minutes-since-verified, first factor then second, with -1 meaning "not verified
 * in this session".
 *
 * Two things make a session fresh. The direct signal is a recent `fva[1]`. The
 * second is a recent *first* factor on an account with two-factor enabled: this
 * app makes MFA compulsory in middleware, so a sign-in that completed minutes ago
 * on such an account cannot have happened without the second factor — Clerk will
 * not finish one. That covers the common case of a token template exposing the
 * ages but an older Clerk reporting -1 for the second slot.
 *
 * Everything else fails closed. Treating an unreadable signal as verified would
 * make the lock resettable by whoever holds the session it exists to protect.
 */
export async function reverifyState(): Promise<ReverifyState> {
  const { sessionClaims } = await auth();
  const claims = (sessionClaims ?? {}) as Record<string, unknown>;
  const fva = claims.fva;

  if (!Array.isArray(fva) || fva.length < 2) return { fresh: false, reason: 'unavailable' };

  const withinWindow = (slot: unknown): boolean => {
    const age = Number(slot);
    return Number.isFinite(age) && age >= 0 && age <= REVERIFY_WITHIN_MINUTES;
  };

  if (withinWindow(fva[1])) return { fresh: true };

  const twoFactorEnabled = claims.mfa === true || claims.mfa === 'true';
  if (twoFactorEnabled && withinWindow(fva[0])) return { fresh: true };

  return { fresh: false, reason: 'stale' };
}

/** Whether a PIN reset may proceed. */
export async function secondFactorIsFresh(): Promise<boolean> {
  return (await reverifyState()).fresh;
}
