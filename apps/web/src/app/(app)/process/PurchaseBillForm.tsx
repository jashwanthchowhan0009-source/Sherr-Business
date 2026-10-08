'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { determineSupplyType } from '@/lib/accounting/gst';
import { formatRupees, paise } from '@/lib/money';
import { STATE_CODES } from '@/lib/india/gstin';
import { createPurchaseBill, editPurchaseBill } from '@/server/purchases';
import { nextDay, type PartyOption } from './InvoiceForm';
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

export interface PurchaseBillInitial {
  partyId: string;
  voucherDate: string;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  narration: string;
  lines: TaxLine[];
}

/**
 * Entering a purchase bill, or editing one.
 *
 * The supplier's own invoice number is required, not optional, and it is the
 * reason this form exists separately from the invoice form. The same bill
 * entered twice is the most expensive data-entry error in payables — it gets
 * paid twice — and that number is the only thing that can detect it. A unique
 * index enforces it; the form asks for it and explains why.
 */
export function PurchaseBillForm({
  parties,
  items,
  companyStateCode,
  today,
  lockedUpto,
  initial,
  edit,
}: {
  parties: PartyOption[];
  items: ItemOption[];
  companyStateCode: string | null;
  today: string;
  lockedUpto: string | null;
  initial?: PurchaseBillInitial;
  edit?: EditTarget;
}) {
  const [pending, start] = useTransition();
  const [partyId, setPartyId] = useState(initial?.partyId ?? '');
  const [voucherDate, setVoucherDate] = useState(initial?.voucherDate ?? today);
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState(initial?.supplierInvoiceNo ?? '');
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState(
    initial?.supplierInvoiceDate ?? '',
  );
  const [narration, setNarration] = useState(initial?.narration ?? '');
  const [lines, setLines] = useState<TaxLine[]>(initial?.lines ?? [emptyTaxLine()]);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const party = parties.find((p) => p.id === partyId) ?? null;
  // On a purchase we are the recipient, so the supply is taxed where we are.
  const placeOfSupply = companyStateCode ?? '';
  const supplyType =
    partyId && placeOfSupply
      ? determineSupplyType({
          supplierStateCode: party?.stateCode ?? placeOfSupply,
          placeOfSupplyStateCode: placeOfSupply,
        })
      : null;
  const preview = useGstPreview(lines, supplyType);
  const ready =
    Boolean(partyId && supplierInvoiceNo && supplierInvoiceDate) &&
    linesComplete(lines) &&
    reasonReady(edit, reason);

  function submit(post: boolean) {
    setMessage(null);
    start(async () => {
      const data = {
        partyId,
        voucherDate,
        supplierInvoiceNo,
        supplierInvoiceDate,
        narration,
        post,
        lines: usableLines(lines),
      };

      if (edit) {
        const result = await editPurchaseBill({ id: edit.voucherId, reason, data });
        if (result.ok) {
          setMessage({ tone: 'ok', text: editedMessage(result.data) });
          returnToProcess();
        } else {
          setMessage({ tone: 'err', text: result.error });
        }
        return;
      }

      const result = await createPurchaseBill(data);
      if (result.ok) {
        setMessage({
          tone: 'ok',
          text:
            `${result.data.voucherNo} ${result.data.posted ? 'posted' : 'saved as a draft'} — ` +
            formatRupees(paise(BigInt(result.data.totalPaise))) +
            (result.data.reverseChargeVoucherNo
              ? `. Reverse-charge liability raised as ${result.data.reverseChargeVoucherNo}.`
              : ''),
        });
        setLines([emptyTaxLine()]);
        setSupplierInvoiceNo('');
        setSupplierInvoiceDate('');
        setNarration('');
      } else {
        setMessage({ tone: 'err', text: result.error });
      }
    });
  }

  if (parties.length === 0) {
    return <p className={ui.hint}>Add a supplier first, then their bills can be entered here.</p>;
  }

  return (
    <form action={() => submit(true)}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="bill-party">Supplier</label>
          <select
            className={ui.input}
            id="bill-party"
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
            required
          >
            <option value="">Choose a supplier</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.gstin ? ` · ${p.gstin}` : ' · unregistered'}
              </option>
            ))}
          </select>
          {party && !party.gstin ? (
            <p className={ui.hint}>
              This supplier is unregistered, so there is no input tax credit to claim on their
              bills. The supply may also fall under reverse charge — mark the lines if it does.
            </p>
          ) : null}
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="bill-supno">Their invoice number</label>
          <input
            className={ui.input}
            id="bill-supno"
            value={supplierInvoiceNo}
            onChange={(e) => setSupplierInvoiceNo(e.target.value)}
            required
            maxLength={60}
            autoComplete="off"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            aria-describedby="bill-supno-hint"
          />
          <p className={ui.hint} id="bill-supno-hint">
            From their document, exactly as printed. This is what stops the same bill being
            entered — and paid — twice.
          </p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="bill-supdate">Their invoice date</label>
          <input
            className={ui.input}
            id="bill-supdate"
            type="date"
            value={supplierInvoiceDate}
            onChange={(e) => setSupplierInvoiceDate(e.target.value)}
            required
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="bill-date">Date in our books</label>
          <input
            className={ui.input}
            id="bill-date"
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
          <label className={ui.label}>Place of supply</label>
          <p className={ui.hint} style={{ marginTop: 6 }}>
            {placeOfSupply
              ? `${STATE_CODES[placeOfSupply] ?? placeOfSupply} — you are the recipient, so the supply is taxed where you are.`
              : 'Set your state on the Data tab first.'}
          </p>
        </div>

        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="bill-narration">Narration</label>
          <input
            className={ui.input}
            id="bill-narration"
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            maxLength={500}
          />
        </div>

        <ReasonField edit={edit} value={reason} onChange={setReason} />
      </div>

      <TaxLinesEditor lines={lines} items={items} onChange={setLines} allowReverseCharge priceOf={(i) => i.purchasePricePaise ?? i.salePricePaise} />

      {preview && supplyType ? (
        <GstWorking
          result={preview}
          supplyType={supplyType}
          supplierStateCode={party?.stateCode ?? null}
          placeOfSupplyStateCode={placeOfSupply}
          taxDirection="input"
        />
      ) : null}

      {lines.some((l) => l.reverseCharge) ? (
        <p className={ui.hint} style={{ marginTop: 10 }}>
          Reverse charge: the supplier charges no tax and you owe it instead. Posting this bill
          also raises that liability as a separate journal, with the matching input credit, so the
          bill keeps showing exactly what their document shows.
        </p>
      ) : null}

      <div className={ui.actions} style={{ marginTop: 16 }}>
        <button className={ui.button} type="submit" disabled={pending || !ready}>
          {pending
            ? 'Saving…'
            : edit?.posted
              ? 'Post correction'
              : edit
                ? 'Save and post'
                : 'Post bill'}
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
          </span>
        ) : null}
      </div>
    </form>
  );
}
