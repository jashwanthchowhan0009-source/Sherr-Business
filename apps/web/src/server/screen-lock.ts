'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAccountAction } from '@/lib/auth/action';
import { checkPinStrength, PIN_PATTERN } from '@/lib/auth/pin';
import { attemptUnlock, hasPin, isPinLocked, resetPinAfterReverification, savePin } from '@/lib/db/screen-lock';
import { secondFactorIsFresh } from '@/lib/auth/reverify';
import { auditSecurityEvent } from '@/lib/audit/security';
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
    await auditSecurityEvent({ action: 'screenlock.pin.created', subjectId: userId });

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

      if (result.reason === 'locked') {
        // Recorded without the attempt count or anything about the PIN: the
        // fact of a lock is the security event, the digits never are.
        await auditSecurityEvent({ action: 'screenlock.locked_out', subjectId: userId });
        throw conflict(
          'Too many wrong attempts, so the PIN is locked. Verify your second factor to set a ' +
            'new one.',
        );
      }

      await auditSecurityEvent({
        action: 'screenlock.failed',
        subjectId: userId,
        after: { attemptsLeft: result.attemptsLeft },
      });
      throw invalidInput(
        `Wrong PIN. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} left ` +
          'before it locks.',
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

/**
 * Sets a new PIN after the second factor has been re-verified.
 *
 * The only way out of a lock, and the only way to change a PIN you have
 * forgotten. It deliberately does not ask for the old one — somebody who is
 * locked out cannot supply it — so the whole weight rests on Clerk having
 * verified the second factor within the last few minutes.
 */
const resetPinAction = defineAccountAction({
  name: 'screenlock.pin.reset',
  input: z.object({ pin: pinField, confirm: pinField }),
  rateLimit: { limit: 5, windowSeconds: 3600 },
  handler: async ({ userId, input }) => {
    if (input.pin !== input.confirm) throw invalidInput('The two PINs do not match.');

    const strength = checkPinStrength(input.pin);
    if (!strength.ok) throw invalidInput(strength.message);

    if (!(await secondFactorIsFresh())) {
      throw conflict(
        'Verify your second factor first. Sign out and back in with your authenticator, then ' +
          'set the new PIN.',
      );
    }

    const wasLocked = await isPinLocked(userId);
    await resetPinAfterReverification(userId, input.pin);
    await auditSecurityEvent({
      action: 'screenlock.pin.reset',
      subjectId: userId,
      after: { clearedLockout: wasLocked },
    });

    const opened = await attemptUnlock(userId, input.pin);
    if (opened.ok) await setUnlockCookie(opened.token);

    revalidatePath('/', 'layout');
    return { reset: true as const };
  },
});

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

export async function resetPin(input: unknown) {
  return resetPinAction(input);
}
