'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { PARTY_KINDS } from '@/lib/db/schema';
import { STATE_CODES } from '@/lib/india/gstin';
import { validateGstin } from '@/lib/india/gstin';
import { archiveParty, createParty, restoreParty, updateParty } from '@/server/ledger';

export interface PartyInitial {
  id: string;
  kind: string;
  name: string;
  legalName: string;
  gstin: string;
  pan: string;
  stateCode: string;
  email: string;
  phone: string;
  billingAddress: string;
  creditDays: number;
  notes: string;
  isActive: boolean;
}

/**
 * Adding a customer or supplier, or editing one.
 *
 * The GSTIN is checked as it is typed — the checksum is a pure function, so the
 * derived PAN and state can be shown before anything is submitted. The server
 * validates again; this is about telling someone they mistyped while they can
 * still see the document they are copying from.
 */
export function PartyForm({ initial }: { initial?: PartyInitial } = {}) {
  const editing = Boolean(initial);
  const [pending, start] = useTransition();
  const [gstin, setGstin] = useState(initial?.gstin ?? '');
  const [active, setActive] = useState(initial?.isActive ?? true);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  // Bumped after a successful add, so the uncontrolled fields clear.
  const [formKey, setFormKey] = useState(0);

  const checked = gstin.length === 15 ? validateGstin(gstin.toUpperCase()) : null;

  function onSubmit(formData: FormData) {
    setMessage(null);
    start(async () => {
      const fields = {
        kind: String(formData.get('kind') ?? ''),
        name: String(formData.get('name') ?? ''),
        legalName: String(formData.get('legalName') ?? ''),
        gstin: String(formData.get('gstin') ?? ''),
        pan: String(formData.get('pan') ?? ''),
        stateCode: String(formData.get('stateCode') ?? ''),
        email: String(formData.get('email') ?? ''),
        phone: String(formData.get('phone') ?? ''),
        billingAddress: String(formData.get('billingAddress') ?? ''),
        creditDays: Number(formData.get('creditDays') || 0),
        notes: String(formData.get('notes') ?? ''),
      };
      const result = initial
        ? await updateParty({ id: initial.id, ...fields })
        : await createParty(fields);
      setMessage(
        result.ok
          ? { tone: 'ok', text: `${result.data.name} ${initial ? 'saved' : 'added'}.` }
          : { tone: 'err', text: result.error },
      );
      if (result.ok && !initial) {
        setGstin('');
        setFormKey((k) => k + 1);
      }
    });
  }

  function toggleActive() {
    if (!initial) return;
    setMessage(null);
    start(async () => {
      const result = active
        ? await archiveParty({ id: initial.id })
        : await restoreParty({ id: initial.id });
      if (result.ok) {
        setActive(!active);
        setMessage({
          tone: 'ok',
          text: active
            ? 'Archived. It no longer appears on new entries; existing ones keep it.'
            : 'Restored.',
        });
      } else {
        setMessage({ tone: 'err', text: result.error });
      }
    });
  }

  return (
    <form action={onSubmit} key={formKey}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-name">Name</label>
          <input
            className={ui.input}
            id="party-name"
            name="name"
            required
            maxLength={200}
            defaultValue={initial?.name ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-kind">They are a</label>
          <select
            className={ui.input}
            id="party-kind"
            name="kind"
            required
            defaultValue={initial?.kind ?? ''}
          >
            <option value="">Choose</option>
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
            defaultValue={checked?.ok ? '' : initial?.stateCode ?? ''}
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
          <label className={ui.label} htmlFor="party-legal">Legal name</label>
          <input
            className={ui.input}
            id="party-legal"
            name="legalName"
            maxLength={200}
            defaultValue={initial?.legalName ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-pan">PAN</label>
          <input
            className={ui.input}
            id="party-pan"
            name="pan"
            maxLength={10}
            autoComplete="off"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            defaultValue={initial?.pan ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-email">Email</label>
          <input
            className={ui.input}
            id="party-email"
            name="email"
            type="email"
            autoComplete="off"
            defaultValue={initial?.email ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="party-phone">Phone</label>
          <input
            className={ui.input}
            id="party-phone"
            name="phone"
            type="tel"
            maxLength={20}
            defaultValue={initial?.phone ?? ''}
          />
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
            defaultValue={initial ? initial.creditDays : ''}
          />
        </div>

        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="party-address">Billing address</label>
          <input
            className={ui.input}
            id="party-address"
            name="billingAddress"
            maxLength={500}
            defaultValue={initial?.billingAddress ?? ''}
          />
        </div>

        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="party-notes">Notes</label>
          <input
            className={ui.input}
            id="party-notes"
            name="notes"
            maxLength={1000}
            defaultValue={initial?.notes ?? ''}
          />
        </div>
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Add party'}
        </button>
        {editing ? (
          <button className={ui.buttonGhost} type="button" disabled={pending} onClick={toggleActive}>
            {active ? 'Archive' : 'Restore'}
          </button>
        ) : null}
        {message ? (
          <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
            {message.text}
          </span>
        ) : null}
      </div>

      {editing ? (
        <p className={ui.hint} style={{ marginTop: 12 }}>
          Changes apply to entries made from now on. Invoices and bills already raised keep the
          details they were raised with.
        </p>
      ) : null}
    </form>
  );
}
