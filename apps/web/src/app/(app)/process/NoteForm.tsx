'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { determineSupplyType } from '@/lib/accounting/gst';
import { editCreditNote, editDebitNote } from '@/server/purchases';
import { nextDay, type PartyOption } from './InvoiceForm';
import {
  GstWorking,
  TaxLinesEditor,
  linesComplete,
  usableLines,
  useGstPreview,
  type ItemOption,
  type TaxLine,
} from './_shared/TaxLines';
import { ReasonField, editedMessage, reasonReady, returnToProcess, type EditTarget } from './_shared/edit';

export interface NoteInitial {
  partyId: string;
  voucherDate: string;
  againstVoucherId: string;
  supplierInvoiceNo: string;
  noteReason: string;
  lines: TaxLine[];
}

/**
 * Editing a credit note (to a customer) or a debit note (to a supplier).
 *
 * Notes are posted when they are raised, so editing one is always a
 * correction: the original is reversed and the edited note posted in its place.
 */
export function NoteForm({
  kind,
  parties,
  items,
  companyStateCode,
  lockedUpto,
  initial,
  edit,
}: {
  kind: 'credit_note' | 'debit_note';
  parties: PartyOption[];
  items: ItemOption[];
  companyStateCode: string | null;
  lockedUpto: string | null;
  initial: NoteInitial;
  edit: EditTarget;
}) {
  const [pending, start] = useTransition();
  const [partyId, setPartyId] = useState(initial.partyId);
  const [voucherDate, setVoucherDate] = useState(initial.voucherDate);
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState(initial.supplierInvoiceNo);
  const [noteReason, setNoteReason] = useState(initial.noteReason);
  const [lines, setLines] = useState<TaxLine[]>(initial.lines);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const party = parties.find((p) => p.id === partyId) ?? null;
  const isCredit = kind === 'credit_note';
  // A credit note follows the invoice (the customer's place of supply); a debit
  // note follows the bill (taxed where we are, the recipient).
  const placeOfSupply = isCredit
    ? party?.placeOfSupplyStateCode || party?.stateCode || companyStateCode || ''
    : companyStateCode || '';
  const supplierState = isCredit ? companyStateCode : party?.stateCode ?? companyStateCode;
  const supplyType =
    partyId && placeOfSupply && supplierState
      ? determineSupplyType({ supplierStateCode: supplierState, placeOfSupplyStateCode: placeOfSupply })
      : null;
  const preview = useGstPreview(lines, supplyType);
  const ready =
    Boolean(partyId) &&
    noteReason.trim().length >= 3 &&
    linesComplete(lines) &&
    reasonReady(edit, reason);

  function submit() {
    setMessage(null);
    start(async () => {
      const data = {
        partyId,
        voucherDate,
        againstVoucherId: initial.againstVoucherId,
        supplierInvoiceNo,
        reason: noteReason,
        lines: usableLines(lines),
      };
      const payload = { id: edit.voucherId, reason, data };
      const result = isCredit ? await editCreditNote(payload) : await editDebitNote(payload);
      if (result.ok) {
        setMessage({ tone: 'ok', text: editedMessage(result.data) });
        returnToProcess();
      } else {
        setMessage({ tone: 'err', text: result.error });
      }
    });
  }

  return (
    <form action={submit}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="note-party">{isCredit ? 'Customer' : 'Supplier'}</label>
          <select
            className={ui.input}
            id="note-party"
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
            required
          >
            <option value="">Choose</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="note-date">Date</label>
          <input
            className={ui.input}
            id="note-date"
            type="date"
            value={voucherDate}
            onChange={(e) => setVoucherDate(e.target.value)}
            {...(lockedUpto ? { min: nextDay(lockedUpto) } : {})}
            required
          />
        </div>

        {isCredit ? null : (
          <div className={ui.field}>
            <label className={ui.label} htmlFor="note-supno">Their note number</label>
            <input
              className={ui.input}
              id="note-supno"
              value={supplierInvoiceNo}
              onChange={(e) => setSupplierInvoiceNo(e.target.value)}
              maxLength={60}
            />
          </div>
        )}

        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="note-why">Why the note is raised</label>
          <input
            className={ui.input}
            id="note-why"
            value={noteReason}
            onChange={(e) => setNoteReason(e.target.value)}
            required
            minLength={3}
            maxLength={300}
          />
        </div>

        <ReasonField edit={edit} value={reason} onChange={setReason} />
      </div>

      <TaxLinesEditor lines={lines} items={items} onChange={setLines} />

      {preview && supplyType ? (
        <GstWorking
          result={preview}
          supplyType={supplyType}
          supplierStateCode={supplierState}
          placeOfSupplyStateCode={placeOfSupply}
          taxDirection={isCredit ? 'output' : 'input'}
        />
      ) : null}

      <div className={ui.actions} style={{ marginTop: 16 }}>
        <button className={ui.button} type="submit" disabled={pending || !ready}>
          {pending ? 'Saving…' : 'Post correction'}
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
