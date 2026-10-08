'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import type { ExtractedDocument, ExtractedField } from '@/lib/ai/contract';
import { approveExtraction, rejectExtraction, saveExtractionReview } from '@/server/inbox';

interface Party {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
}

interface LineDraft {
  description: string;
  hsnSac: string;
  unit: string;
  quantity: string;
  unitPriceRupees: string;
  discountRupees: string;
  gstRateBps: string;
  reverseCharge: boolean;
}

/**
 * The fields, as a person will leave them.
 *
 * Every value is editable and every value starts from what the model read — but the
 * model's reading stays visible beside the field it filled, so a reviewer can see at
 * a glance what was changed and what was accepted. A form that silently adopted the
 * model's values would make "approved" mean nothing.
 *
 * A field the model was unsure of is marked. That marking is the whole purpose of
 * per-field confidence: it points at the two fields worth re-reading instead of
 * asking someone to re-read twenty.
 */
export function ReviewForm({
  extractionId,
  extracted,
  reviewed,
  parties,
  suggestedParty,
  companyStateCode,
  lockedUpto,
  confidenceFloor,
  readOnly,
}: {
  extractionId: string;
  extracted: ExtractedDocument;
  reviewed: unknown;
  parties: Party[];
  suggestedParty: { id: string; name: string; matchedOn: string } | null;
  companyStateCode: string | null;
  lockedUpto: string | null;
  confidenceFloor: number;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // A part-finished review resumes from what was saved; otherwise the model's
  // reading is the starting point.
  const saved = (reviewed ?? null) as Record<string, unknown> | null;

  const [partyId, setPartyId] = useState<string>(
    (saved?.partyId as string) ?? suggestedParty?.id ?? '',
  );
  const [voucherDate, setVoucherDate] = useState(
    (saved?.voucherDate as string) ?? isoOrEmpty(extracted.invoiceDate.value),
  );
  const [invoiceNo, setInvoiceNo] = useState(
    (saved?.supplierInvoiceNo as string) ?? extracted.invoiceNumber.value ?? '',
  );
  const [placeOfSupply, setPlaceOfSupply] = useState(
    (saved?.placeOfSupplyStateCode as string) ??
      extracted.placeOfSupplyStateCode.value ??
      companyStateCode ??
      '',
  );
  const [narration, setNarration] = useState((saved?.narration as string) ?? '');

  const [lines, setLines] = useState<LineDraft[]>(() => {
    const savedLines = saved?.lines as Record<string, unknown>[] | undefined;
    if (savedLines && savedLines.length > 0) {
      return savedLines.map((l) => ({
        description: String(l.description ?? ''),
        hsnSac: String(l.hsnSac ?? ''),
        unit: String(l.unit ?? ''),
        quantity: String(l.quantity ?? ''),
        unitPriceRupees: String(l.unitPriceRupees ?? ''),
        discountRupees: String(l.discountRupees ?? ''),
        gstRateBps: String(l.gstRateBps ?? ''),
        reverseCharge: l.reverseCharge === true,
      }));
    }
    return extracted.lines.length > 0
      ? extracted.lines.map(lineFromExtraction)
      : [blankLine()];
  });

  const party = useMemo(() => parties.find((p) => p.id === partyId) ?? null, [parties, partyId]);

  const payload = () => ({
    extractionId,
    partyId,
    voucherDate,
    supplierInvoiceNo: invoiceNo,
    // The supplier's own invoice date is the voucher date on a purchase: the bill
    // is dated when they raised it, not when it reached us.
    supplierInvoiceDate: voucherDate,
    placeOfSupplyStateCode: placeOfSupply,
    narration,
    lines: lines.map((l) => ({
      description: l.description,
      hsnSac: l.hsnSac,
      unit: l.unit,
      quantity: l.quantity,
      unitPriceRupees: l.unitPriceRupees,
      discountRupees: l.discountRupees || '0',
      gstRateBps: Number(l.gstRateBps || '0'),
      cessRateBps: 0,
      reverseCharge: l.reverseCharge,
    })),
  });

  const run = (
    action: (input: unknown) => Promise<{ ok: boolean; error?: string; data?: unknown }>,
    onOk: (data: unknown) => string,
  ) =>
    start(async () => {
      setMessage(null);
      const result = await action(payload());
      if (!result.ok) {
        setMessage({ tone: 'err', text: result.error ?? 'Something went wrong.' });
        return;
      }
      setMessage({ tone: 'ok', text: onOk(result.data) });
      router.refresh();
    });

  const update = (index: number, patch: Partial<LineDraft>) =>
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  if (readOnly) {
    return (
      <div className={ui.panel}>
        <div className={ui.panelBody}>
          <p className={ui.hint}>
            Your role can read this document and what was extracted from it, but cannot create a
            voucher from it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={ui.panel}>
      <div className={ui.panelHead}>
        <h2 className={ui.panelTitle}>What this will become</h2>
        <p className={ui.panelNote}>
          Edit anything. What you leave here is what the draft voucher is built from — the model&apos;s
          reading is shown beneath each field, not used.
        </p>
      </div>

      <div className={ui.panelBody}>
        {lockedUpto ? (
          <p className={ui.hint}>
            The books are closed to {lockedUpto}. A bill dated on or before that cannot be entered.
          </p>
        ) : null}

        <div className={ui.formGrid}>
          <div className={ui.field}>
            <label className={ui.label} htmlFor="r-party">Supplier</label>
            <select
              className={ui.input}
              id="r-party"
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
            >
              <option value="">Choose the supplier…</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.gstin ? ` — ${p.gstin}` : ''}
                </option>
              ))}
            </select>
            <Read field={extracted.supplierName} floor={confidenceFloor} label="Read as" />
            <Read field={extracted.supplierGstin} floor={confidenceFloor} label="GSTIN read as" />
            {suggestedParty ? (
              <p className={ui.hint}>
                Matched to {suggestedParty.name} on{' '}
                {suggestedParty.matchedOn === 'gstin' ? 'GSTIN, which identifies a business exactly' : 'an exact name match'}.
              </p>
            ) : (
              <p className={ui.hint}>
                No supplier matched. Add them on the Process page first if they are new — picking
                the wrong one puts the bill on the wrong account.
              </p>
            )}
          </div>

          <div className={ui.field}>
            <label className={ui.label} htmlFor="r-date">Invoice date</label>
            <input
              className={ui.input}
              id="r-date"
              type="date"
              value={voucherDate}
              onChange={(e) => setVoucherDate(e.target.value)}
            />
            <Read field={extracted.invoiceDate} floor={confidenceFloor} label="Printed as" />
          </div>

          <div className={ui.field}>
            <label className={ui.label} htmlFor="r-invno">Supplier&apos;s invoice number</label>
            <input
              className={ui.input}
              id="r-invno"
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              maxLength={60}
            />
            <Read field={extracted.invoiceNumber} floor={confidenceFloor} label="Read as" />
          </div>

          <div className={ui.field}>
            <label className={ui.label} htmlFor="r-pos">Place of supply</label>
            <input
              className={ui.input}
              id="r-pos"
              value={placeOfSupply}
              onChange={(e) => setPlaceOfSupply(e.target.value.replace(/\D/g, '').slice(0, 2))}
              inputMode="numeric"
            />
            <p className={ui.hint}>
              On a purchase this is your own state — you are the recipient.
              {party?.stateCode && placeOfSupply && party.stateCode !== placeOfSupply
                ? ` The supplier is in ${party.stateCode}, so this is an inter-state supply and IGST applies.`
                : ''}
            </p>
          </div>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="r-narration">Note (optional)</label>
          <input
            className={ui.input}
            id="r-narration"
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            maxLength={500}
          />
        </div>

        <h3 className={ui.label} style={{ marginTop: 20 }}>Lines</h3>
        {lines.map((line, i) => (
          <div key={i} className={ui.formGrid} style={{ marginBottom: 14 }}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`l-desc-${i}`}>Description on line {i + 1}</label>
              <input
                className={ui.input}
                id={`l-desc-${i}`}
                value={line.description}
                onChange={(e) => update(i, { description: e.target.value })}
                maxLength={300}
              />
              {extracted.lines[i] ? (
                <Read field={extracted.lines[i]!.description} floor={confidenceFloor} label="Read as" />
              ) : null}
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`l-hsn-${i}`}>HSN or SAC on line {i + 1}</label>
              <input
                className={ui.input}
                id={`l-hsn-${i}`}
                value={line.hsnSac}
                onChange={(e) => update(i, { hsnSac: e.target.value })}
                maxLength={20}
              />
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`l-qty-${i}`}>Quantity on line {i + 1}</label>
              <input
                className={ui.input}
                id={`l-qty-${i}`}
                value={line.quantity}
                onChange={(e) => update(i, { quantity: e.target.value })}
                inputMode="decimal"
              />
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`l-unit-${i}`}>Unit on line {i + 1}</label>
              <input
                className={ui.input}
                id={`l-unit-${i}`}
                value={line.unit}
                onChange={(e) => update(i, { unit: e.target.value })}
                maxLength={20}
              />
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`l-rate-${i}`}>Rate on line {i + 1}</label>
              <input
                className={ui.input}
                id={`l-rate-${i}`}
                value={line.unitPriceRupees}
                onChange={(e) => update(i, { unitPriceRupees: e.target.value })}
                inputMode="decimal"
              />
              {extracted.lines[i] ? (
                <Read
                  field={extracted.lines[i]!.taxableAmount}
                  floor={confidenceFloor}
                  label="Line amount printed as"
                />
              ) : null}
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`l-gst-${i}`}>GST rate on line {i + 1}</label>
              <select
                className={ui.input}
                id={`l-gst-${i}`}
                value={line.gstRateBps}
                onChange={(e) => update(i, { gstRateBps: e.target.value })}
              >
                <option value="">Choose…</option>
                {[0, 25, 50, 100, 300, 500, 600, 1200, 1400, 1800, 2800].map((bps) => (
                  <option key={bps} value={bps}>
                    {bps / 100}%
                  </option>
                ))}
              </select>
              {extracted.lines[i] ? (
                <Read
                  field={extracted.lines[i]!.gstRatePercent}
                  floor={confidenceFloor}
                  label="Read as"
                />
              ) : null}
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={`l-rc-${i}`}>
                Reverse charge on line {i + 1}
              </label>
              <select
                className={ui.input}
                id={`l-rc-${i}`}
                value={line.reverseCharge ? 'yes' : 'no'}
                onChange={(e) => update(i, { reverseCharge: e.target.value === 'yes' })}
              >
                <option value="no">No</option>
                <option value="yes">Yes — we pay the tax</option>
              </select>
            </div>
            {lines.length > 1 ? (
              <div className={ui.field} style={{ justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className={ui.buttonGhost}
                  onClick={() => setLines((c) => c.filter((_, j) => j !== i))}
                >
                  Remove line {i + 1}
                </button>
              </div>
            ) : null}
          </div>
        ))}

        <button
          type="button"
          className={ui.buttonGhost}
          onClick={() => setLines((c) => [...c, blankLine()])}
        >
          Add a line
        </button>

        <div className={ui.actions} style={{ marginTop: 20 }}>
          <button
            type="button"
            className={ui.button}
            disabled={pending}
            onClick={() =>
              run(approveExtraction, (data) => {
                const d = data as { voucherNo: string };
                return `Created draft ${d.voucherNo}. It is not in the books — post it from the Process page.`;
              })
            }
          >
            {pending ? 'Working…' : 'Approve as a draft voucher'}
          </button>
          <button
            type="button"
            className={ui.buttonGhost}
            disabled={pending}
            onClick={() => run(saveExtractionReview, () => 'Saved. Nothing has been created yet.')}
          >
            Save without creating
          </button>
          <button
            type="button"
            className={ui.buttonGhost}
            disabled={pending}
            onClick={() => setRejecting((v) => !v)}
          >
            Reject this reading
          </button>
        </div>

        <p className={ui.hint}>
          Approving creates a <b>draft</b>. Nothing here can post a voucher, so no figure reaches
          the books until a person opens the draft and posts it.
        </p>

        {rejecting ? (
          <div className={ui.field} style={{ marginTop: 12 }}>
            <label className={ui.label} htmlFor="r-reject">Why is this being rejected?</label>
            <input
              className={ui.input}
              id="r-reject"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              maxLength={500}
            />
            <div className={ui.actions}>
              <button
                type="button"
                className={ui.button}
                disabled={pending || rejectReason.trim().length < 3}
                onClick={() =>
                  start(async () => {
                    const result = await rejectExtraction({ extractionId, reason: rejectReason });
                    setMessage(
                      result.ok
                        ? { tone: 'ok', text: 'Rejected. The document stays in the inbox.' }
                        : { tone: 'err', text: result.error },
                    );
                    if (result.ok) router.refresh();
                  })
                }
              >
                Confirm rejection
              </button>
            </div>
          </div>
        ) : null}

        {message ? (
          <p className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the model read, beneath the field it filled.
 *
 * Shown always, not only when uncertain: a reviewer needs to see that a field was
 * accepted as read, not just that it was flagged. Below the floor it is marked, and
 * the percentage is given — "72%" tells someone where to look in a way "uncertain"
 * does not.
 */
function Read({
  field,
  floor,
  label,
}: {
  field: ExtractedField;
  floor: number;
  label: string;
}) {
  if (field.value === null) {
    return <p className={ui.readValue}>{label}: nothing found on the document.</p>;
  }
  const low = field.confidence < floor;
  return (
    <p className={low ? ui.statusErr : ui.readValue}>
      {label}: &ldquo;{field.value}&rdquo;
      {low ? ` — only ${Math.round(field.confidence * 100)}% confident, check this` : ''}
    </p>
  );
}

function blankLine(): LineDraft {
  return {
    description: '',
    hsnSac: '',
    unit: '',
    quantity: '1',
    unitPriceRupees: '',
    discountRupees: '0',
    gstRateBps: '',
    reverseCharge: false,
  };
}

/**
 * A line, from what the model read.
 *
 * The printed line amount becomes the rate against a quantity of one, rather than
 * the quantity and rate the model also read. The reason is that the line amount is
 * the figure the tax was charged on: a quantity × rate that does not reproduce it
 * means one of the three was misread, and starting from the amount keeps the tax
 * right while the reviewer sorts the rest out.
 */
function lineFromExtraction(line: {
  description: ExtractedField;
  hsnSac: ExtractedField;
  unit: ExtractedField;
  quantity: ExtractedField;
  rate: ExtractedField;
  taxableAmount: ExtractedField;
  gstRatePercent: ExtractedField;
}): LineDraft {
  return {
    description: line.description.value ?? '',
    hsnSac: line.hsnSac.value ?? '',
    unit: line.unit.value ?? '',
    quantity: '1',
    unitPriceRupees: (line.taxableAmount.value ?? '').replace(/[₹,\s]/g, ''),
    discountRupees: '0',
    gstRateBps: percentToBpsOrEmpty(line.gstRatePercent.value),
    reverseCharge: false,
  };
}

function percentToBpsOrEmpty(value: string | null): string {
  if (value === null) return '';
  const cleaned = value.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return '';
  return String(Math.round(Number(cleaned) * 100));
}

/** A printed date to the ISO value a date input needs, or empty. */
function isoOrEmpty(printed: string | null): string {
  if (printed === null) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(printed)) return printed;
  const dmy = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(printed.trim());
  if (!dmy) return '';
  const year = Number(dmy[3]);
  const full = year < 100 ? 2000 + year : year;
  return `${full}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
}
