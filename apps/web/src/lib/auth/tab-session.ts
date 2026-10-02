/**
 * The per-tab record of having unlocked.
 *
 * The unlock cookie is shared by every tab in the browser, which is right — a
 * PIN entered once should open the app, not one tab of it. But the lock is also
 * meant to fire on a *new* tab, and nothing the server sees distinguishes a new
 * tab from the one that just unlocked: same cookie, same user, same session.
 * `sessionStorage` is the one thing scoped to a single tab, so a marker here is
 * what tells them apart.
 *
 * It is a hint, never an authority. Deleting it locks the tab; forging it does
 * not unlock anything, because every request still carries the cookie the server
 * checks against `pin_unlocks`.
 *
 * One known gap: a tab duplicated through the browser's own Duplicate command
 * inherits `sessionStorage`, so it is not asked again. That is the same person
 * at the same machine a second later, and the idle timer still applies to both.
 */
const TAB_KEY = 'sb.unlocked-tab';

/** Records that the PIN was entered in this tab. */
export function markTabUnlocked(): void {
  try {
    sessionStorage.setItem(TAB_KEY, '1');
  } catch {
    // Private mode or blocked storage. `tabHasUnlocked` fails open to match, so
    // the app stays usable rather than locking on every navigation.
  }
}

/** Forgets it, so this tab is asked again. */
export function clearTabUnlocked(): void {
  try {
    sessionStorage.removeItem(TAB_KEY);
  } catch {
    // A browser refusing storage is not a reason to skip the lock.
  }
}

/**
 * Whether this tab has unlocked. Marks it on the way past, so the check is only
 * ever false once per tab.
 */
export function claimTabUnlocked(): boolean {
  try {
    const seen = sessionStorage.getItem(TAB_KEY) === '1';
    if (!seen) sessionStorage.setItem(TAB_KEY, '1');
    return seen;
  } catch {
    // Treat blocked storage as a tab already seen. The alternative is a lock
    // screen on every navigation in private mode, which is unusable, and the
    // five-minute idle expiry on the server still holds.
    return true;
  }
}
