import { redirect } from 'next/navigation';
import { requireAccountContext } from '@/lib/auth/context';
import { screenUnlocked } from '@/lib/auth/unlock';
import { hasPin } from '@/lib/db/screen-lock';
import { PinPad } from './PinPad';

export const dynamic = 'force-dynamic';

/**
 * The screen lock.
 *
 * Outside the app layout on purpose: it has no dock and no top bar, so there is
 * nothing to look at and nothing to click while it is up.
 */
export default async function LockPage() {
  const ctx = await requireAccountContext();

  // Already open — nothing to ask.
  if (await screenUnlocked(ctx.userId)) redirect('/dashboard');

  // Whether it is a first PIN or a return is read from the database, not from
  // the query string, so a guessed URL cannot offer to replace somebody's PIN.
  const mode = (await hasPin(ctx.userId)) ? 'enter' : 'set';

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '40px 16px' }}>
      <PinPad mode={mode} />
    </main>
  );
}
