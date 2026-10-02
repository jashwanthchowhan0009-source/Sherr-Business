import 'server-only';
import { cookies } from 'next/headers';
import { isUnlocked, UNLOCK_TTL_SECONDS } from '@/lib/db/screen-lock';

export const UNLOCK_COOKIE = 'sb_unlock';

/** The token this browser holds, if any. */
export async function unlockToken(): Promise<string | undefined> {
  return (await cookies()).get(UNLOCK_COOKIE)?.value;
}

export async function setUnlockCookie(token: string): Promise<void> {
  (await cookies()).set(UNLOCK_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: UNLOCK_TTL_SECONDS,
  });
}

export async function clearUnlockCookie(): Promise<void> {
  (await cookies()).delete(UNLOCK_COOKIE);
}

/**
 * Whether this request may see company data.
 *
 * Checked against the database, not against the cookie's existence: a revoked
 * unlock has to stop working immediately, which a self-describing cookie could
 * not do without a key rotation.
 */
export async function screenUnlocked(userId: string): Promise<boolean> {
  return isUnlocked(userId, await unlockToken());
}
