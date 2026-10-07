'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { STATE_CODES } from '@/lib/india/gstin';
import { addRegistration, removeRegistration, updateRegistration } from '@/server/company';

const KIND_LABELS: Record<string, string> = {
  gstin: 'GSTIN', tan: 'TAN', iec: 'IEC', msme: 'MSME', cin: 'CIN',
};

export interface RegistrationRow {
  id: string;
  kind: string;
  number: string;
  stateCode: string | null;
}

type Message = { tone: 'ok' | 'err'; text: string } | null;

/**
 * Registrations: add, edit and remove, in one table.
 *
 * A GSTIN carries its own state in its first two digits, so the state is only
 * asked for on the other kinds.
 */
export function RegistrationsEditor({
  rows,
  readOnly,
}: {
  rows: RegistrationRow[];
  readOnly: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <>
      {rows.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr><th>Type</th><th>Number</th><th>State</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) =>
                editingId === r.id ? (
                  <tr key={r.id}>
                    <td colSpan={4}>
                      <RegistrationForm initial={r} onDone={() => setEditingId(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td>{KIND_LABELS[r.kind] ?? r.kind}</td>
                    <td className="tnum" style={{ fontFamily: 'ui-monospace, monospace' }}>
                      {r.number}
                    </td>
                    <td className="tnum">{r.stateCode ?? '—'}</td>
                    <td>
                      {readOnly ? null : (
                        <button type="button" className={ui.buttonGhost} onClick={() => setEditingId(r.id)}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {readOnly ? null : (
        <div style={{ marginTop: rows.length > 0 ? 18 : 0 }}>
          <RegistrationForm />
        </div>
      )}
    </>
  );
}

function RegistrationForm({
  initial,
  onDone,
}: {
  initial?: RegistrationRow;
  onDone?: () => void;
}) {
  const [pending, start] = useTransition();
  const [kind, setKind] = useState(initial?.kind ?? '');
  const [message, setMessage] = useState<Message>(null);
  const [formKey, setFormKey] = useState(0);
  const prefix = initial ? `reg-${initial.id}` : 'reg-new';

  return (
    <form
      key={formKey}
      action={(formData: FormData) => {
        setMessage(null);
        start(async () => {
          const fields = {
            kind,
            number: String(formData.get('number') ?? ''),
            stateCode: String(formData.get('stateCode') ?? ''),
          };
          if (initial) {
            const result = await updateRegistration({ id: initial.id, ...fields });
            if (result.ok) onDone?.();
            else setMessage({ tone: 'err', text: result.error });
            return;
          }
          const result = await addRegistration(fields);
          if (!result.ok) {
            setMessage({ tone: 'err', text: result.error });
          } else if (result.data.duplicate) {
            setMessage({ tone: 'err', text: `${fields.number} is already recorded.` });
          } else {
            setMessage({ tone: 'ok', text: `${fields.number} added.` });
            setKind('');
            setFormKey((k) => k + 1);
          }
        });
      }}
    >
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor={`${prefix}-kind`}>Type</label>
          <select
            className={ui.input}
            id={`${prefix}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            required
          >
            <option value="">Choose</option>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor={`${prefix}-number`}>Number</label>
          <input
            className={ui.input}
            id={`${prefix}-number`}
            name="number"
            required
            maxLength={32}
            autoComplete="off"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            defaultValue={initial?.number ?? ''}
          />
        </div>
        {kind && kind !== 'gstin' ? (
          <div className={ui.field}>
            <label className={ui.label} htmlFor={`${prefix}-state`}>State</label>
            <select
              className={ui.input}
              id={`${prefix}-state`}
              name="stateCode"
              defaultValue={initial?.stateCode ?? ''}
            >
              <option value="">Not state-specific</option>
              {Object.entries(STATE_CODES).map(([code, name]) => (
                <option key={code} value={code}>{name} ({code})</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending || !kind}>
          {pending ? 'Saving…' : initial ? 'Save' : 'Add registration'}
        </button>
        {initial ? (
          <>
            <button type="button" className={ui.buttonGhost} onClick={onDone}>
              Cancel
            </button>
            <button
              type="button"
              className={ui.buttonGhost}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await removeRegistration({ id: initial.id });
                  if (result.ok) onDone?.();
                  else setMessage({ tone: 'err', text: result.error });
                })
              }
            >
              Remove
            </button>
          </>
        ) : null}
        {message ? (
          <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
            {message.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
