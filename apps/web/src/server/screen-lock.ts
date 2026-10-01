'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAccountAction } from '@/lib/auth/action';
import { checkPinStrength, PIN_PATTERN } from '@/lib/auth/pin';
import { attemptUnlock, hasPin, savePin } from '@/lib/db/screen-lock';
import { clearUnlockCookie, setUnlockCookie, unlockToken } from '@/lib/auth/unlock';
import { revokeUnlock } from '@/lib/db/screen-lock';
import { conflict, invalidInput } from '@/lib/errors';

const pinField = z.string().trim().regex(PIN_PATTERN, 'The PIN is six digits.');

/**
 * Creates the screen-lock PIN, once.
 *
 * Replacing one is deliberately not offered here: somebody who already knows the
 * PIN gains nothing from changing it through a form that does not ask for the
 * old one, and somebody who does not know it must go back through sign-in. A
 * change flow that asks for the current PIN belongs with the rest of account
 * settings, not on the lock screen.
 */
const createPinAction = defineAccountAction({
  name: 'screenlock.pin.created',
  input: z.object({ pin: pinField, confirm: pinField }),
  rateLimit: { limit: 10, windowSeconds: 3600 },
  handler: async ({ userId, input }) => {
    if (input.pin !== input.confirm) throw invalidInput('The two PINs do not match.');

    const strength = checkPinStrength(input.pin);
    if (!strength.ok) throw invalidInput(strength.message);

    if (await hasPin(userId)) {
      throw conflict('A PIN is already set for this account.');
    }

    await savePin(userId, input.pin);

    // Setting it also opens the app, so nobody has to type it twice in a row.
    const opened = await attemptUnlock(userId, input.pin);
    if (opened.ok) await setUnlockCookie(opened.token);

    revalidatePath('/', 'layout');
    return { created: true as const };
  },
});

/** Checks the PIN and opens the app. */
const unlockAction = defineAccountAction({
  name: 'screenlock.unlocked',
  input: z.object({ pin: pinField }),
  // The real limit is the per-user lockout in the database, which survives a
  // restart and cannot be sidestepped by coming from another address. This is a
  // second wall in front of it.
  rateLimit: { limit: 30, windowSeconds: 300 },
  handler: async ({ userId, input }) => {
    const result = await attemptUnlock(userId, input.pin);

    if (!result.ok) {
      if (result.reason === 'no_pin') throw conflict('No PIN is set for this account yet.');
      throw invalidInput(
        result.retryAfterSeconds > 0
          ? `Wrong PIN. Try again in ${describeWait(result.retryAfterSeconds)}.`
          : `Wrong PIN. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} before a wait.`,
      );
    }

    await setUnlockCookie(result.token);
    revalidatePath('/', 'layout');
    return { unlocked: true as const };
  },
});

/** Ends the unlock. Called when the tab is hidden, and from a Lock control. */
const lockAction = defineAccountAction({
  name: 'screenlock.locked',
  input: z.object({}).optional().default({}),
  rateLimit: { limit: 200, windowSeconds: 300 },
  handler: async ({ userId }) => {
    await revokeUnlock(userId, await unlockToken());
    await clearUnlockCookie();
    return { locked: true as const };
  },
});

function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// ─── exported entry points ──────────────────────────────────────────────────

export async function createPin(input: unknown) {
  return createPinAction(input);
}

export async function unlockScreen(input: unknown) {
  return unlockAction(input);
}

export async function lockScreen(input: unknown) {
  return lockAction(input);
}
