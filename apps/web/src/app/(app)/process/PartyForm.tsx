'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { PARTY_KINDS } from '@/lib/db/schema';
import { STATE_CODES } from '@/lib/india/gstin';
import { validateGstin } from '@/lib/india/gstin';
import { createParty } from '@/server/ledger';

/**
 * Adding a customer or supplier.
 *
 * The GSTIN is checked as it is typed — the checksum is a pure function, so the
 * derived PAN and state can be shown before anything is submitted. The server
 * validates again; this is about telling someone they mistyped while they can
 * still see the document they are copying from.
 */
export function PartyForm() {
  const [pending, start] = useTransition();
  const [gstin, setGstin] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const checked = gstin.length === 15 ? validateGstin(gstin.toUpperCase()) : null;

  function onSubmit(formData: FormData) {
    setMessage(null);
    start(async () => {
      const result = await createParty({
        kind: String(formData.get('kind') ?? 'customer'),
        name: String(formData.get('name') ?? ''),
        gstin: String(formData.get('gstin') ?? ''),
        stateCode: String(formData.get('stateCode') ?? ''),
        email: String(formData.get('email') ?? ''),
        billingAddress: String(formData.get('billingAddress') ?? ''),
        creditDays: Number(formData.get('creditDays') ?? 0),
      });
      setMessage(
        result.ok
          ? { tone: 'ok', text: `${result.data.name} added.` }
          : { tone: 'err', text: result.error },
      );
      if (result.ok) setGstin('');
    });
  }

  return (
    <form action={onSubmit}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-name">Name</label>
          <input className={ui.input} id="party-name" name="name" required maxLength={200} />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-kind">They are a</label>
          <select className={ui.input} id="party-kind" name="kind" defaultValue="customer">
            {PARTY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind === 'both' ? 'Customer and supplier' : kind === 'customer' ? 'Customer' : 'Supplier'}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-gstin">GSTIN</label>
          <input
            className={ui.input}
            id="party-gstin"
            name="gstin"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            maxLength={15}
            autoComplete="off"
            placeholder="29AABCS1234A1ZX"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            aria-describedby="party-gstin-hint"
          />
          <p className={ui.hint} id="party-gstin-hint">
            {checked === null
              ? 'Leave blank for an unregistered party, then give the state below.'
              : checked.ok
                ? `PAN ${checked.parts.pan} · ${STATE_CODES[checked.parts.stateCode] ?? 'Unknown state'}`
                : checked.message}
          </p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-state">State</label>
          <select
            className={ui.input}
            id="party-state"
            name="stateCode"
            defaultValue=""
            key={checked?.ok ? checked.parts.stateCode : 'none'}
          >
            <option value="">
              {checked?.ok ? 'Taken from the GSTIN' : 'Choose a state'}
            </option>
            {Object.entries(STATE_CODES).map(([code, name]) => (
              <option key={code} value={code}>
                {name} ({code})
              </option>
            ))}
          </select>
          <p className={ui.hint}>
            This decides CGST+SGST against IGST, so it is not optional for an unregistered party.
          </p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-email">Email</label>
          <input className={ui.input} id="party-email" name="email" type="email" autoComplete="off" />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-credit">Credit days</label>
          <input
            className={ui.input}
            id="party-credit"
            name="creditDays"
            type="number"
            min={0}
            max={365}
            defaultValue={0}
          />
        </div>

        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="party-address">Billing address</label>
          <input className={ui.input} id="party-address" name="billingAddress" maxLength={500} />
        </div>
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add party'}
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
