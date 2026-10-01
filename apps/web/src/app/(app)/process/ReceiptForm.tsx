'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { createReceipt } from '@/server/ledger';

/**
 * Recording money received.
 *
 * Allocation is left to the server, which applies it to the oldest open invoice
 * first. A receipt larger than what is outstanding is accepted and the
 * remainder left unallocated — an advance is a real thing, and refusing one
 * would make the app unable to record a deposit.
 */
export function ReceiptForm({
  parties,
  today,
}: {
  parties: { id: string; name: string }[];
  today: string;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  function onSubmit(formData: FormData) {
    setMessage(null);
    start(async () => {
      const result = await createReceipt({
        partyId: String(formData.get('partyId') ?? ''),
        voucherDate: String(formData.get('voucherDate') ?? today),
        amountRupees: String(formData.get('amountRupees') ?? ''),
        intoAccountCode: String(formData.get('intoAccountCode') ?? 'BANK'),
        reference: String(formData.get('reference') ?? ''),
      });
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
          <select className={ui.input} id="rcpt-party" name="partyId" required defaultValue="">
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
            defaultValue={today}
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
            placeholder="0.00"
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="rcpt-into">Received into</label>
          <select className={ui.input} id="rcpt-into" name="intoAccountCode" defaultValue="BANK">
            <option value="BANK">Bank</option>
            <option value="CASH">Cash</option>
          </select>
        </div>

        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="rcpt-ref">Reference</label>
          <input
            className={ui.input}
            id="rcpt-ref"
            name="reference"
            maxLength={100}
            placeholder="UTR or cheque number"
          />
        </div>
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record receipt'}
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
