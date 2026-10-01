'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { createPin, unlockScreen } from '@/server/screen-lock';

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

export function PinPad({ mode }: { mode: 'set' | 'enter' }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const ready = mode === 'set' ? pin.length === DIGITS && confirm.length === DIGITS : pin.length === DIGITS;

  function submit() {
    if (!ready || pending) return;
    start(async () => {
      setError(null);
      const result =
        mode === 'set' ? await createPin({ pin, confirm }) : await unlockScreen({ pin });

      if (!result.ok) {
        setError(result.error);
        setPin('');
        setConfirm('');
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    });
  }

  // Entering the last digit submits, as a keypad should.
  useEffect(() => {
    if (mode === 'enter' && pin.length === DIGITS) submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, mode]);

  return (
    <div className={ui.lockCard}>
      <LogoMark height={96} priority />
      <h1 className={ui.lockTitle}>
        {mode === 'set' ? 'Create your PIN' : 'Enter your PIN'}
      </h1>
      <p className={ui.lockBody}>
        {mode === 'set'
          ? 'Six digits. You will be asked for it whenever you come back to this tab, so your books are not left open on an unattended screen.'
          : 'Six digits, to open your books again.'}
      </p>

      <Boxes label="PIN" value={pin} onChange={setPin} autoFocus disabled={pending} />

      {mode === 'set' ? (
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
          {pending ? 'Checking…' : mode === 'set' ? 'Set PIN' : 'Unlock'}
        </button>
      </div>

      <p className={ui.hint} style={{ marginTop: 18, textAlign: 'center' }}>
        {mode === 'set'
          ? 'This sits in front of a session you are already signed in to. It is not your password.'
          : 'Forgotten it? Sign out and back in, and you can set a new one.'}
      </p>
    </div>
  );
}
