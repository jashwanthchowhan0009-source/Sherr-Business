'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SignOutButton } from '@clerk/nextjs';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { createPin, resetPin, unlockScreen } from '@/server/screen-lock';
import { markTabUnlocked } from '@/lib/auth/tab-session';

const DIGITS = 6;

/**
 * Six boxes and a numeric keypad.
 *
 * One input per digit rather than a single field, because that is what every
 * banking app does and what a phone keyboard expects. `inputMode="numeric"`
 * brings up the number pad; `type="password"` keeps the digits off the screen
 * for whoever is standing behind.
 */
function Boxes({
  value,
  onChange,
  label,
  autoFocus,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  return (
    <div role="group" aria-label={label} className={ui.pinRow}>
      {Array.from({ length: DIGITS }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={ui.pinBox}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={`${label}, digit ${i + 1}`}
          maxLength={1}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          value={value[i] ?? ''}
          onChange={(e) => {
            const digit = e.target.value.replace(/\D/g, '').slice(-1);
            const next = (value.slice(0, i) + digit + value.slice(i + 1)).slice(0, DIGITS);
            onChange(next);
            if (digit) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            // Backspace on an empty box steps back, which is what everyone
            // expects and what nothing does by default.
            if (e.key === 'Backspace' && !value[i]) {
              refs.current[i - 1]?.focus();
              onChange(value.slice(0, Math.max(0, i - 1)));
            }
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, DIGITS);
            if (!pasted) return;
            e.preventDefault();
            onChange(pasted);
            refs.current[Math.min(pasted.length, DIGITS - 1)]?.focus();
          }}
        />
      ))}
    </div>
  );
}

export type LockMode = 'set' | 'enter' | 'reset';

/**
 * What the lock screen says, by mode. Kept as data so the three paths read side
 * by side — it was far too easy, with the copy inline, to tell somebody who is
 * locked out to "try again".
 */
const COPY: Record<LockMode, { title: string; body: string; cta: string }> = {
  set: {
    title: 'Create your PIN',
    body:
      'Six digits. You will be asked for it on a new tab and after five minutes of inactivity, ' +
      'so your books are not left open on an unattended screen.',
    cta: 'Set PIN',
  },
  enter: {
    title: 'Enter your PIN',
    body: 'Six digits, to open your books again.',
    cta: 'Unlock',
  },
  reset: {
    title: 'Set a new PIN',
    body:
      'Your authenticator decides this, not the old PIN — which is the point, since a forgotten ' +
      'or locked PIN cannot be typed in.',
    cta: 'Set new PIN',
  },
};

export function PinPad({
  mode,
  lockedOut = false,
  reverified = false,
  reverifyUnavailable = false,
}: {
  mode: LockMode;
  /** True when five wrong attempts have already closed it. */
  lockedOut?: boolean;
  /** True when Clerk reports a second factor verified in the last few minutes. */
  reverified?: boolean;
  /**
   * True when the session token carries no factor-verification age at all, so
   * freshness cannot be judged. Signing in again would not change it, so the
   * screen must not send the user round that loop.
   */
  reverifyUnavailable?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const needsTwo = mode === 'set' || mode === 'reset';
  const ready = needsTwo ? pin.length === DIGITS && confirm.length === DIGITS : pin.length === DIGITS;

  function submit() {
    if (!ready || pending) return;
    start(async () => {
      setError(null);
      const result =
        mode === 'set'
          ? await createPin({ pin, confirm })
          : mode === 'reset'
            ? await resetPin({ pin, confirm })
            : await unlockScreen({ pin });

      if (!result.ok) {
        setError(result.error);
        setPin('');
        setConfirm('');
        return;
      }
      // Before navigating, or the page we land on finds an unmarked tab and
      // sends us straight back here.
      markTabUnlocked();
      router.replace('/dashboard');
      router.refresh();
    });
  }

  // Entering the last digit submits, as a keypad should.
  useEffect(() => {
    if (mode === 'enter' && pin.length === DIGITS) submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, mode]);

  const copy = COPY[mode];

  // On the reset screen with a stale second factor there is nothing to type yet:
  // the way back is through the authenticator, so the screen says that and shows
  // no boxes rather than collecting six digits it will have to refuse.
  if (mode === 'reset' && !reverified) {
    return (
      <div className={ui.lockCard}>
        <LogoMark height={96} priority />
        <h1 className={ui.lockTitle}>
          {lockedOut ? 'PIN locked' : 'Verify your authenticator'}
        </h1>
        <p className={ui.lockBody}>
          {lockedOut
            ? 'Five wrong attempts closed it. Nothing is lost — your books are untouched — but ' +
              'only your authenticator can open it again.'
            : 'To set a new PIN, your second factor has to be verified first.'}
        </p>
        {reverifyUnavailable ? (
          <>
            <p className={ui.lockBody}>
              This deployment&apos;s session token does not report when the second factor was last
              verified, so signing in again will not help. Add{' '}
              <code>&quot;fva&quot;: &quot;{'{{'}session.factor_verification_age{'}}'}&quot;</code>{' '}
              to the Clerk session token, or ask whoever administers it to.
            </p>
            <p className={ui.lockBody}>
              Until then a locked PIN has to be cleared by an administrator. Nothing in your books
              is affected.
            </p>
          </>
        ) : (
          <p className={ui.lockBody}>
            Sign out, sign back in with your authenticator app, and this screen will let you choose a
            new PIN.
          </p>
        )}

        <div className={ui.actions} style={{ marginTop: 20, justifyContent: 'center' }}>
          <SignOutButton>
            <button type="button" className={ui.button}>
              {reverifyUnavailable ? 'Sign out' : 'Sign out and verify'}
            </button>
          </SignOutButton>
        </div>

        <p className={ui.hint} style={{ marginTop: 18, textAlign: 'center' }}>
          Deliberately the only way out. A reset that something else could reach would make the PIN
          worth nothing.
        </p>
      </div>
    );
  }

  return (
    <div className={ui.lockCard}>
      <LogoMark height={96} priority />
      <h1 className={ui.lockTitle}>{copy.title}</h1>
      <p className={ui.lockBody}>{copy.body}</p>

      <Boxes label="PIN" value={pin} onChange={setPin} autoFocus disabled={pending} />

      {needsTwo ? (
        <>
          <p className={ui.lockBody} style={{ marginTop: 18 }}>Once more, to be sure.</p>
          <Boxes label="Confirm PIN" value={confirm} onChange={setConfirm} disabled={pending} />
        </>
      ) : null}

      {error ? (
        <p className={ui.statusErr} aria-live="assertive" style={{ marginTop: 14 }}>{error}</p>
      ) : null}

      <div className={ui.actions} style={{ marginTop: 20, justifyContent: 'center' }}>
        <button type="button" className={ui.button} disabled={!ready || pending} onClick={submit}>
          {pending ? 'Checking…' : copy.cta}
        </button>
      </div>

      {mode === 'enter' ? (
        <p className={ui.hint} style={{ marginTop: 18, textAlign: 'center' }}>
          <Link href="/lock?reset=1">Forgotten your PIN?</Link>
        </p>
      ) : (
        <p className={ui.hint} style={{ marginTop: 18, textAlign: 'center' }}>
          This sits in front of a session you are already signed in to. It is not your password, and
          it is never stored — only a hash of it is.
        </p>
      )}
    </div>
  );
}
