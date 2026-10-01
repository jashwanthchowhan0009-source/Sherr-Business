'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { extractDocument } from '@/server/inbox';

/**
 * Asking the model to read one document.
 *
 * Deliberately one document at a time and never automatic on upload. Reading sends
 * the file to a third party and costs money, so it is something a person asks for.
 */
export function ExtractButton({
  documentId,
  label,
  disabled,
  disabledReason,
}: {
  documentId: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (disabled) {
    return <span className={ui.hint}>{disabledReason ?? '—'}</span>;
  }

  return (
    <>
      <button
        type="button"
        className={ui.buttonGhost}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await extractDocument({ documentId });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            // A reading that the model itself could not complete is reported here
            // rather than silently leaving the row looking unread.
            if (!result.data.ok) {
              setError(result.data.reason);
            }
            router.refresh();
          })
        }
      >
        {pending ? 'Reading…' : label}
      </button>
      {error ? (
        <div className={ui.statusErr} aria-live="polite" style={{ marginTop: 4 }}>
          {error}
        </div>
      ) : null}
    </>
  );
}
