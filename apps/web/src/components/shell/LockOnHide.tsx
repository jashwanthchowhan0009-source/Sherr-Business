'use client';

import { useCallback, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { lockScreen } from '@/server/screen-lock';
import { claimTabUnlocked, clearTabUnlocked } from '@/lib/auth/tab-session';

/** Matches IDLE_TIMEOUT_SECONDS on the server, which is the authority. */
const IDLE_MS = 5 * 60 * 1000;

/**
 * Locks the app when it is left alone, and when it is opened somewhere new.
 *
 * Deliberately **not** on every tab switch. An accountant works with the books
 * beside a bank statement, a spreadsheet and three supplier emails, and a lock
 * that fires on every alt-tab would be turned off within a day — which protects
 * nothing at all. The two events worth locking on are a tab that has not been
 * touched for five minutes, and a tab that has not been unlocked at all.
 *
 * The timer here is a convenience: it ends the session promptly rather than
 * leaving it to die on its own. The server expires an unlock five minutes after
 * the last authenticated request regardless, so a tab with JavaScript disabled,
 * a crashed renderer or a machine put to sleep is covered without this
 * component's help.
 */
export function LockOnHide() {
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lockNow = useCallback(async () => {
    clearTabUnlocked();
    await lockScreen({});
    router.replace('/lock');
  }, [router]);

  useEffect(() => {
    // The lock screen itself must not lock, or it would clear the session the
    // user is in the middle of re-establishing.
    if (pathname?.startsWith('/lock')) return;

    // A tab reached without unlocking in *this* tab is a new tab or a restored
    // one. The server cookie is shared across tabs, so this is the only thing
    // that can tell them apart.
    // The PIN screen marks the tab on a successful unlock, so arriving here
    // unmarked means this tab has not been through it.
    if (!claimTabUnlocked()) {
      void lockNow();
      return;
    }

    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void lockNow(), IDLE_MS);
    };

    // Any of these means somebody is still there.
    const events = ['pointerdown', 'keydown', 'scroll', 'focus'] as const;
    for (const name of events) window.addEventListener(name, reset, { passive: true });
    reset();

    return () => {
      for (const name of events) window.removeEventListener(name, reset);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pathname, lockNow]);

  return null;
}
