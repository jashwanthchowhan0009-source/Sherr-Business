import { redirect } from 'next/navigation';
import { requireAccountContext } from '@/lib/auth/context';
import { screenUnlocked } from '@/lib/auth/unlock';
import { hasPin, isPinLocked } from '@/lib/db/screen-lock';
import { reverifyState } from '@/lib/auth/reverify';
import { PinPad } from './PinPad';

export const dynamic = 'force-dynamic';

/**
 * The screen lock.
 *
 * Outside the app layout on purpose: it has no dock and no top bar, so there is
 * nothing to look at and nothing to click while it is up.
 */
export default async function LockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAccountContext();

  // Already open — nothing to ask.
  if (await screenUnlocked(ctx.userId)) redirect('/dashboard');

  const [exists, locked] = await Promise.all([hasPin(ctx.userId), isPinLocked(ctx.userId)]);
  const askedToReset = (await searchParams).reset === '1';

  // Read from the database, not from the query string, so a guessed URL cannot
  // offer to replace somebody's PIN. `?reset=1` only reaches the reset screen,
  // where the second factor still has to be fresh before anything is written.
  const mode = !exists ? 'set' : locked || askedToReset ? 'reset' : 'enter';

  // Checked on the server so the screen can say which of the two steps is left
  // — re-verify, or choose the new PIN — instead of failing on submit.
  const reverify = mode === 'reset' ? await reverifyState() : ({ fresh: false, reason: 'stale' } as const);

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '40px 16px' }}>
      <PinPad
        mode={mode}
        lockedOut={locked}
        reverified={reverify.fresh}
        reverifyUnavailable={!reverify.fresh && reverify.reason === 'unavailable'}
      />
    </main>
  );
}
