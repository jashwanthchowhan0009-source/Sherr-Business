'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { lockScreen } from '@/server/screen-lock';

/**
 * Locks the app the moment the tab stops being looked at.
 *
 * `visibilitychange` fires when the tab is switched away from, the window is
 * minimised, or the phone is locked — which is the whole list of ways a screen
 * full of somebody's books gets left in front of somebody else. On the way out
 * the unlock is revoked server-side; on the way back the page is pushed to the
 * lock screen.
 *
 * Revoking on the way out rather than only redirecting on the way back is the
 * part that matters: by the time the tab is visible again the session is already
 * dead, so a tab restored from history, a bfcache resume, or a request fired by
 * something other than this component all meet a locked app.
 *
 * `pagehide` is there for the cases `visibilitychange` misses — Safari's
 * back-forward cache among them — and `keepalive` lets the request outlive the
 * page it was fired from.
 */
export function LockOnHide() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // The lock screen itself must not lock, or returning to the tab would
    // cancel the PIN being typed into it.
    if (pathname?.startsWith('/lock')) return;

    let locked = false;

    const lock = () => {
      if (locked) return;
      locked = true;
      void lockScreen({});
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        lock();
      } else if (locked) {
        // Back in the tab, and the session was ended on the way out.
        router.replace('/lock');
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', lock);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', lock);
    };
  }, [pathname, router]);

  return null;
}
