'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ui } from '@/components/ui';
import { deleteDocument } from '@/server/documents';

/**
 * Removes a stored document, with one confirmation in between.
 *
 * Two clicks, not a dialog: the first turns the control into "Sure? / No", which
 * is enough to stop a mis-click and does not take over the screen. The server
 * refuses outright to delete a document a posted voucher was built from, so the
 * one deletion that would damage the books cannot happen here at all.
 *
 * Every deletion is written to the audit log with the file name and its content
 * hash, so what was removed, by whom and when stays answerable afterwards.
 */
export function DeleteDocumentButton({ id, filename }: { id: string; filename: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function remove() {
    start(async () => {
      const result = await deleteDocument({ id });
      if (!result.ok) {
        setError(result.error);
        setArming(false);
        return;
      }
      router.refresh();
    });
  }

  if (error) {
    return (
      <span className={ui.statusErr} role="alert">
        {error}
      </span>
    );
  }

  if (!arming) {
    return (
      <button
        type="button"
        className={ui.linkish}
        onClick={() => setArming(true)}
        aria-label={`Delete ${filename}`}
      >
        Delete
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button type="button" className={ui.linkish} disabled={pending} onClick={remove}>
        {pending ? 'Deleting…' : 'Sure?'}
      </button>
      <button type="button" className={ui.linkish} disabled={pending} onClick={() => setArming(false)}>
        No
      </button>
    </span>
  );
}
