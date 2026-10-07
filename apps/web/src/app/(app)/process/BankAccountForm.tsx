'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { addBankAccount, updateBankAccount } from '@/server/banking';

export interface BankAccountInitial {
  id: string;
  ledgerAccountId: string;
  bankName: string;
  accountLabel: string;
  accountNumberLast4: string;
  ifsc: string;
  isActive: boolean;
}

/**
 * Adding a bank account, or editing one.
 *
 * Only the last four digits of the account number are stored — the full number
 * is not needed to reconcile and is not worth holding.
 */
export function BankAccountForm({
  ledgerAccounts,
  initial,
}: {
  ledgerAccounts: { id: string; name: string }[];
  initial?: BankAccountInitial;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  return (
    <form
      action={(formData: FormData) => {
        setMessage(null);
        start(async () => {
          const fields = {
            ledgerAccountId: String(formData.get('ledgerAccountId') ?? ''),
            bankName: String(formData.get('bankName') ?? ''),
            accountLabel: String(formData.get('accountLabel') ?? ''),
            accountNumberLast4: String(formData.get('accountNumberLast4') ?? ''),
            ifsc: String(formData.get('ifsc') ?? ''),
          };
          const result = initial
            ? await updateBankAccount({
                id: initial.id,
                ...fields,
                isActive: formData.get('isActive') === 'on',
              })
            : await addBankAccount(fields);
          setMessage(
            result.ok
              ? { tone: 'ok', text: `${result.data.label} ${initial ? 'saved' : 'added'}.` }
              : { tone: 'err', text: result.error },
          );
        });
      }}
    >
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ba-bank">Bank</label>
          <input
            className={ui.input}
            id="ba-bank"
            name="bankName"
            required
            maxLength={100}
            defaultValue={initial?.bankName ?? ''}
          />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ba-label">Name it</label>
          <input
            className={ui.input}
            id="ba-label"
            name="accountLabel"
            required
            maxLength={100}
            defaultValue={initial?.accountLabel ?? ''}
          />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ba-ledger">Posts to</label>
          <select
            className={ui.input}
            id="ba-ledger"
            name="ledgerAccountId"
            required
            defaultValue={initial?.ledgerAccountId ?? ''}
          >
            <option value="">Choose a ledger account</option>
            {ledgerAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ba-last4">Last four digits</label>
          <input
            className={ui.input}
            id="ba-last4"
            name="accountNumberLast4"
            maxLength={4}
            inputMode="numeric"
            defaultValue={initial?.accountNumberLast4 ?? ''}
          />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ba-ifsc">IFSC</label>
          <input
            className={ui.input}
            id="ba-ifsc"
            name="ifsc"
            maxLength={11}
            style={{ fontFamily: 'ui-monospace, monospace' }}
            defaultValue={initial?.ifsc ?? ''}
          />
        </div>
        {initial ? (
          <div className={ui.field}>
            <label className={ui.label} htmlFor="ba-active">In use</label>
            <input id="ba-active" name="isActive" type="checkbox" defaultChecked={initial.isActive} />
          </div>
        ) : null}
      </div>
      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Save changes' : 'Add bank account'}
        </button>
        {message ? (
          <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
            {message.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
