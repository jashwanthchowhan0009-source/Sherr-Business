'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { createReceipt, editReceipt } from '@/server/ledger';
import { ReasonField, editedMessage, reasonReady, returnToProcess, type EditTarget } from './_shared/edit';

export interface MoneyInitial {
  partyId: string;
  voucherDate: string;
  amountRupees: string;
  accountCode: 'BANK' | 'CASH';
  reference: string;
  narration: string;
}

/**
 * Recording money received, or editing a receipt.
 *
 * Allocation is left to the server, which applies it to the oldest open invoice
 * first. A receipt larger than what is outstanding is accepted and the
 * remainder left unallocated — an advance is a real thing, and refusing one
 * would make the app unable to record a deposit.
 */
export function ReceiptForm({
  parties,
  today,
  initial,
  edit,
}: {
  parties: { id: string; name: string }[];
  today: string;
  initial?: MoneyInitial;
  edit?: EditTarget;
}) {
  const [pending, start] = useTransition();
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  function onSubmit(formData: FormData) {
    setMessage(null);
    start(async () => {
      const data = {
        partyId: String(formData.get('partyId') ?? ''),
        voucherDate: String(formData.get('voucherDate') ?? today),
        amountRupees: String(formData.get('amountRupees') ?? ''),
        intoAccountCode: String(formData.get('intoAccountCode') ?? ''),
        reference: String(formData.get('reference') ?? ''),
        narration: String(formData.get('narration') ?? ''),
      };

      if (edit) {
        const result = await editReceipt({ id: edit.voucherId, reason, data });
        setMessage(
          result.ok
            ? { tone: 'ok', text: editedMessage(result.data) }
            : { tone: 'err', text: result.error },
        );
        if (result.ok) returnToProcess();
        return;
      }

      const result = await createReceipt(data);
      setMessage(
        result.ok
          ? { tone: 'ok', text: `${result.data.voucherNo} posted.` }
          : { tone: 'err', text: result.error },
      );
    });
  }

  if (parties.length === 0) {
    return <p className={ui.hint}>Add a customer before recording a receipt against one.</p>;
  }

  return (
    <form action={onSubmit}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="rcpt-party">From</label>
          <select
            className={ui.input}
            id="rcpt-party"
            name="partyId"
            required
            defaultValue={initial?.partyId ?? ''}
          >
            <option value="">Choose a customer</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="rcpt-date">Date</label>
          <input
            className={ui.input}
            id="rcpt-date"
            name="voucherDate"
            type="date"
            defaultValue={initial?.voucherDate ?? today}
            required
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="rcpt-amount">Amount (₹)</label>
          <input
            className={ui.input}
            id="rcpt-amount"
            name="amountRupees"
            inputMode="decimal"
            required
            defaultValue={initial?.amountRupees ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="rcpt-into">Received into</label>
          <select
            className={ui.input}
            id="rcpt-into"
            name="intoAccountCode"
            required
            defaultValue={initial?.accountCode ?? ''}
          >
            <option value="">Choose</option>
            <option value="BANK">Bank</option>
            <option value="CASH">Cash</option>
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="rcpt-ref">Reference</label>
          <input
            className={ui.input}
            id="rcpt-ref"
            name="reference"
            maxLength={100}
            defaultValue={initial?.reference ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="rcpt-narration">Narration</label>
          <input
            className={ui.input}
            id="rcpt-narration"
            name="narration"
            maxLength={500}
            defaultValue={initial?.narration ?? ''}
          />
        </div>

        <ReasonField edit={edit} value={reason} onChange={setReason} />
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending || !reasonReady(edit, reason)}>
          {pending ? 'Saving…' : edit ? 'Post correction' : 'Record receipt'}
        </button>
        {message ? (
          <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
            {message.text}
          </span>
        ) : null}
      </div>

      <p className={ui.hint} style={{ marginTop: 12 }}>
        Applied to the oldest open invoice first. Anything beyond what is outstanding stays
        unallocated as an advance.
      </p>
    </form>
  );
}
