'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { updateAccount } from '@/server/company';

/**
 * One row of the chart of accounts, renamable in place.
 *
 * The code never changes: it is what the engines post to. Only the name and
 * the note a person reads are editable, and every entry already in the
 * account stays where it is.
 */
export function AccountRow({
  account,
  origin,
  editable,
}: {
  account: { id: string; code: string; name: string; note: string | null; nature: string };
  origin: string;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [note, setNote] = useState(account.note ?? '');
  const [shown, setShown] = useState({ name: account.name, note: account.note });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <tr>
      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>{account.code}</td>
      <td>
        {editing ? (
          <div style={{ display: 'grid', gap: 6 }}>
            <label className={ui.label} htmlFor={`acc-${account.id}-name`}>Name</label>
            <input
              className={ui.input}
              id={`acc-${account.id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
            <label className={ui.label} htmlFor={`acc-${account.id}-note`}>Note</label>
            <input
              className={ui.input}
              id={`acc-${account.id}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
            />
            {error ? <span className={ui.statusErr}>{error}</span> : null}
          </div>
        ) : (
          <>
            {shown.name}
            {shown.note ? <div className={ui.hint}>{shown.note}</div> : null}
          </>
        )}
      </td>
      <td>{account.nature}</td>
      <td className={ui.hint}>{origin}</td>
      <td>
        {!editable ? null : editing ? (
          <div className={ui.actions} style={{ marginTop: 0 }}>
            <button
              type="button"
              className={ui.button}
              disabled={pending || name.trim().length < 2}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const result = await updateAccount({ id: account.id, name, note });
                  if (result.ok) {
                    setShown({ name: name.trim(), note: note.trim() || null });
                    setEditing(false);
                  } else {
                    setError(result.error);
                  }
                })
              }
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className={ui.buttonGhost} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className={ui.buttonGhost} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </td>
    </tr>
  );
}
