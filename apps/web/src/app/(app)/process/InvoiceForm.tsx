'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { determineSupplyType } from '@/lib/accounting/gst';
import { formatRupees, paise } from '@/lib/money';
import { STATE_CODES } from '@/lib/india/gstin';
import { createSalesInvoice, editSalesInvoice } from '@/server/ledger';
import {
  GstWorking,
  TaxLinesEditor,
  emptyTaxLine,
  linesComplete,
  usableLines,
  useGstPreview,
  type ItemOption,
  type TaxLine,
} from './_shared/TaxLines';
import { ReasonField, editedMessage, reasonReady, returnToProcess, type EditTarget } from './_shared/edit';

export interface PartyOption {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  placeOfSupplyStateCode: string | null;
}

export interface InvoiceInitial {
  partyId: string;
  voucherDate: string;
  placeOfSupplyStateCode: string;
  reference: string;
  narration: string;
  lines: TaxLine[];
}

/**
 * Raising a sales invoice, or editing one.
 *
 * The working shown comes from the same engine the server runs. The browser's
 * figures are never sent: only quantities, prices and rates go, and the server
 * recalculates. A preview the server trusted would be a way to post any number
 * at all.
 */
export function InvoiceForm({
  parties,
  items,
  supplierStateCode,
  today,
  lockedUpto,
  initial,
  edit,
}: {
  parties: PartyOption[];
  items: ItemOption[];
  supplierStateCode: string | null;
  today: string;
  lockedUpto: string | null;
  initial?: InvoiceInitial;
  edit?: EditTarget;
}) {
  const [pending, start] = useTransition();
  const [partyId, setPartyId] = useState(initial?.partyId ?? '');
  const [voucherDate, setVoucherDate] = useState(initial?.voucherDate ?? today);
  const [placeOfSupply, setPlaceOfSupply] = useState(initial?.placeOfSupplyStateCode ?? '');
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [narration, setNarration] = useState(initial?.narration ?? '');
  const [lines, setLines] = useState<TaxLine[]>(initial?.lines ?? [emptyTaxLine()]);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<
    { tone: 'ok' | 'err'; text: string; href?: string } | null
  >(null);

  const party = parties.find((p) => p.id === partyId) ?? null;
  const effectivePlaceOfSupply =
    placeOfSupply || party?.placeOfSupplyStateCode || party?.stateCode || supplierStateCode || '';

  // No preview until a customer is chosen. Falling back to the supplier's own
  // state would show CGST and SGST for an invoice whose customer turns out to be
  // in another state, which is the one figure on this form nobody should see a
  // wrong version of.
  const supplyType =
    partyId && supplierStateCode && effectivePlaceOfSupply
      ? determineSupplyType({
          supplierStateCode,
          placeOfSupplyStateCode: effectivePlaceOfSupply,
        })
      : null;
  const preview = useGstPreview(lines, supplyType);
  const ready = Boolean(partyId) && linesComplete(lines) && reasonReady(edit, reason);

  function submit(post: boolean) {
    setMessage(null);
    start(async () => {
      const data = {
        partyId,
        voucherDate,
        placeOfSupplyStateCode: placeOfSupply,
        reference,
        narration,
        post,
        lines: usableLines(lines),
      };

      if (edit) {
        const result = await editSalesInvoice({ id: edit.voucherId, reason, data });
        if (result.ok) {
          setMessage({ tone: 'ok', text: editedMessage(result.data) });
          returnToProcess();
        } else {
          setMessage({ tone: 'err', text: result.error });
        }
        return;
      }

      const result = await createSalesInvoice(data);
      if (result.ok) {
        setMessage({
          tone: 'ok',
          text: `${result.data.voucherNo} ${
            result.data.posted ? 'posted' : 'saved as a draft'
          } — ${formatRupees(paise(BigInt(result.data.totalPaise)))}`,
          href: `/api/invoices/${result.data.id}/pdf`,
        });
        setLines([emptyTaxLine()]);
        setReference('');
        setNarration('');
      } else {
        setMessage({ tone: 'err', text: result.error });
      }
    });
  }

  if (parties.length === 0) {
    return (
      <p className={ui.hint}>
        Add a customer first. An invoice names who it is addressed to, and the state they are in
        decides whether it carries CGST and SGST or IGST.
      </p>
    );
  }

  return (
    <form action={() => submit(true)}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-party">Customer</label>
          <select
            className={ui.input}
            id="inv-party"
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
            required
          >
            <option value="">Choose a customer</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.gstin ? ` · ${p.gstin}` : ' · unregistered'}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-date">Invoice date</label>
          <input
            className={ui.input}
            id="inv-date"
            type="date"
            value={voucherDate}
            onChange={(e) => setVoucherDate(e.target.value)}
            {...(lockedUpto ? { min: nextDay(lockedUpto) } : {})}
            required
          />
          {lockedUpto ? (
            <p className={ui.hint}>The books are closed to {lockedUpto}.</p>
          ) : null}
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-pos">Place of supply</label>
          <select
            className={ui.input}
            id="inv-pos"
            value={placeOfSupply}
            onChange={(e) => setPlaceOfSupply(e.target.value)}
          >
            <option value="">
              {party
                ? `From the customer — ${
                    STATE_CODES[effectivePlaceOfSupply] ?? effectivePlaceOfSupply
                  }`
                : 'From the customer'}
            </option>
            {Object.entries(STATE_CODES).map(([code, name]) => (
              <option key={code} value={code}>{name} ({code})</option>
            ))}
          </select>
          <p className={ui.hint}>
            Override only when the supply is taxed somewhere other than the customer&rsquo;s own
            state. This, not the billing address, decides the tax.
          </p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-ref">Reference</label>
          <input
            className={ui.input}
            id="inv-ref"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={100}
          />
        </div>

        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="inv-narration">Narration</label>
          <input
            className={ui.input}
            id="inv-narration"
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            maxLength={500}
          />
        </div>

        <ReasonField edit={edit} value={reason} onChange={setReason} />
      </div>

      <TaxLinesEditor lines={lines} items={items} onChange={setLines} />

      {preview && supplyType ? (
        <GstWorking
          result={preview}
          supplyType={supplyType}
          supplierStateCode={supplierStateCode}
          placeOfSupplyStateCode={effectivePlaceOfSupply}
        />
      ) : null}

      <div className={ui.actions} style={{ marginTop: 16 }}>
        <button className={ui.button} type="submit" disabled={pending || !ready}>
          {pending
            ? 'Saving…'
            : edit?.posted
              ? 'Post correction'
              : edit
                ? 'Save and post'
                : 'Post invoice'}
        </button>
        {edit?.posted ? null : (
          <button
            className={ui.buttonGhost}
            type="button"
            disabled={pending || !ready}
            onClick={() => submit(false)}
          >
            {edit ? 'Save draft' : 'Save as draft'}
          </button>
        )}
        {message ? (
          <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
            {message.text}
            {message.href ? (
              <>
                {' · '}
                <a href={message.href}>Open the PDF</a>
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      <p className={ui.hint} style={{ marginTop: 12 }}>
        Posting puts the invoice in the books. It can still be edited afterwards: the edit
        reverses the original and posts the corrected invoice, so both stay visible in the audit
        trail.
      </p>
    </form>
  );
}

/** The day after a lock date, for a date input's `min`. */
export function nextDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1));
  return date.toISOString().slice(0, 10);
}
