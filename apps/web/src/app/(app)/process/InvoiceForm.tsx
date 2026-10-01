'use client';

import { useMemo, useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { calculateInvoice, determineSupplyType } from '@/lib/accounting/gst';
import { QTY_SCALE, parseQuantity, parseRupees } from '@/lib/accounting/units';
import { amountInWords } from '@/lib/accounting/amount-in-words';
import { formatRupees, paise } from '@/lib/money';
import { STATE_CODES } from '@/lib/india/gstin';
import { createSalesInvoice } from '@/server/ledger';

interface PartyOption {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  placeOfSupplyStateCode: string | null;
}

interface ItemOption {
  id: string;
  name: string;
  hsnSac: string | null;
  unit: string;
  gstRateBps: number;
  salePricePaise: bigint | null;
}

interface Line {
  itemId: string;
  description: string;
  hsnSac: string;
  unit: string;
  quantity: string;
  unitPriceRupees: string;
  gstRateBps: number;
}

const SLABS = [0, 25, 300, 500, 1200, 1800, 2800, 4000] as const;
const emptyLine = (): Line => ({
  itemId: '',
  description: '',
  hsnSac: '',
  unit: 'NOS',
  quantity: '1',
  unitPriceRupees: '',
  gstRateBps: 1800,
});

/**
 * Raising a sales invoice.
 *
 * The totals shown here come from the same `calculateInvoice` the server uses —
 * the engine is pure, so it runs in the browser for the preview and again on
 * the server for the posting. The browser's figures are never sent: only the
 * quantities, prices and rates go, and the server recalculates. A preview that
 * the server trusted would be a way to post any number at all.
 */
export function InvoiceForm({
  parties,
  items,
  supplierStateCode,
  today,
}: {
  parties: PartyOption[];
  items: ItemOption[];
  supplierStateCode: string | null;
  today: string;
}) {
  const [pending, start] = useTransition();
  const [partyId, setPartyId] = useState('');
  const [voucherDate, setVoucherDate] = useState(today);
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [message, setMessage] = useState<
    { tone: 'ok' | 'err'; text: string; href?: string } | null
  >(null);

  const party = parties.find((p) => p.id === partyId) ?? null;
  const effectivePlaceOfSupply =
    placeOfSupply || party?.placeOfSupplyStateCode || party?.stateCode || supplierStateCode || '';

  const preview = useMemo(() => {
    // No preview until a customer is chosen. Falling back to the supplier's own
    // state would show CGST and SGST for an invoice whose customer turns out to
    // be in another state, which is the one number on this form nobody should
    // see a wrong version of.
    if (!partyId || !supplierStateCode || !effectivePlaceOfSupply) return null;
    const usable = lines.filter((l) => l.unitPriceRupees.trim() !== '');
    if (usable.length === 0) return null;

    try {
      const supplyType = determineSupplyType({
        supplierStateCode,
        placeOfSupplyStateCode: effectivePlaceOfSupply,
      });
      return {
        supplyType,
        result: calculateInvoice(
          usable.map((l) => ({
            quantity: l.quantity.trim() === '' ? QTY_SCALE : parseQuantity(l.quantity),
            unitPricePaise: parseRupees(l.unitPriceRupees),
            gstRateBps: l.gstRateBps,
          })),
          supplyType,
        ),
      };
    } catch {
      // A half-typed amount is not an error worth shouting about; the preview
      // simply waits until the figures parse.
      return null;
    }
  }, [partyId, lines, supplierStateCode, effectivePlaceOfSupply]);

  const setLine = (index: number, patch: Partial<Line>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const chooseItem = (index: number, itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    setLine(index, {
      itemId,
      ...(item
        ? {
            description: item.name,
            hsnSac: item.hsnSac ?? '',
            unit: item.unit,
            gstRateBps: item.gstRateBps,
            unitPriceRupees:
              item.salePricePaise !== null
                ? formatRupees(paise(item.salePricePaise), { symbol: false })
                : '',
          }
        : {}),
    });
  };

  function submit(post: boolean) {
    setMessage(null);
    start(async () => {
      const result = await createSalesInvoice({
        partyId,
        voucherDate,
        placeOfSupplyStateCode: placeOfSupply,
        reference,
        post,
        lines: lines
          .filter((l) => l.unitPriceRupees.trim() !== '')
          .map((l) => ({
            ...(l.itemId ? { itemId: l.itemId } : {}),
            description: l.description || 'Item',
            hsnSac: l.hsnSac,
            unit: l.unit,
            quantity: l.quantity || '1',
            unitPriceRupees: l.unitPriceRupees,
            gstRateBps: l.gstRateBps,
          })),
      });

      if (result.ok) {
        setMessage({
          tone: 'ok',
          text: `${result.data.voucherNo} ${result.data.posted ? 'posted' : 'saved as a draft'} — ${formatRupees(
            paise(BigInt(result.data.totalPaise)),
          )}`,
          href: `/api/invoices/${result.data.id}/pdf`,
        });
        setLines([emptyLine()]);
        setReference('');
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
            required
          />
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
            placeholder="Their PO number"
          />
        </div>
      </div>

      <div className={ui.tableWrap} style={{ marginTop: 18 }}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Item</th>
              <th>Description</th>
              <th>HSN/SAC</th>
              <th>Qty</th>
              <th>Rate (₹)</th>
              <th>GST</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>
                  <select
                    className={ui.input}
                    value={line.itemId}
                    onChange={(e) => chooseItem(index, e.target.value)}
                    aria-label={`Item on line ${index + 1}`}
                  >
                    <option value="">Free text</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className={ui.input}
                    value={line.description}
                    onChange={(e) => setLine(index, { description: e.target.value })}
                    aria-label={`Description on line ${index + 1}`}
                  />
                </td>
                <td>
                  <input
                    className={ui.input}
                    value={line.hsnSac}
                    onChange={(e) => setLine(index, { hsnSac: e.target.value })}
                    style={{ width: 90, fontFamily: 'ui-monospace, monospace' }}
                    aria-label={`HSN or SAC on line ${index + 1}`}
                  />
                </td>
                <td>
                  <input
                    className={ui.input}
                    value={line.quantity}
                    onChange={(e) => setLine(index, { quantity: e.target.value })}
                    inputMode="decimal"
                    style={{ width: 80 }}
                    aria-label={`Quantity on line ${index + 1}`}
                  />
                </td>
                <td>
                  <input
                    className={ui.input}
                    value={line.unitPriceRupees}
                    onChange={(e) => setLine(index, { unitPriceRupees: e.target.value })}
                    inputMode="decimal"
                    style={{ width: 110 }}
                    aria-label={`Rate on line ${index + 1}`}
                  />
                </td>
                <td>
                  <select
                    className={ui.input}
                    value={line.gstRateBps}
                    onChange={(e) => setLine(index, { gstRateBps: Number(e.target.value) })}
                    style={{ width: 90 }}
                    aria-label={`GST rate on line ${index + 1}`}
                  >
                    {SLABS.map((bps) => (
                      <option key={bps} value={bps}>{bps / 100}%</option>
                    ))}
                  </select>
                </td>
                <td>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      className={ui.buttonGhost}
                      onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={ui.actions}>
        <button
          type="button"
          className={ui.buttonGhost}
          onClick={() => setLines((c) => [...c, emptyLine()])}
        >
          Add a line
        </button>
      </div>

      {/* The working, shown before anything is posted. Produced by the same
          engine the server runs, so what is previewed is what will be
          recorded — but the server recalculates rather than trusting it. */}
      {preview ? (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--sb-hairline)', paddingTop: 14 }}>
          <p className={ui.hint}>
            {preview.supplyType === 'intra_state'
              ? `Within ${STATE_CODES[effectivePlaceOfSupply] ?? effectivePlaceOfSupply} — CGST and SGST, half the rate each.`
              : preview.supplyType === 'inter_state'
                ? `${STATE_CODES[supplierStateCode ?? ''] ?? 'Your state'} to ${
                    STATE_CODES[effectivePlaceOfSupply] ?? effectivePlaceOfSupply
                  } — IGST at the full rate.`
                : preview.supplyType === 'zero_rated'
                  ? 'Zero-rated supply.'
                  : 'Exempt supply.'}
          </p>
          <dl className={ui.formGrid} style={{ marginTop: 10 }}>
            <Figure label="Taxable value" value={preview.result.taxablePaise} />
            {preview.result.cgstPaise > 0n ? (
              <Figure label="CGST" value={preview.result.cgstPaise} />
            ) : null}
            {preview.result.sgstPaise > 0n ? (
              <Figure label="SGST" value={preview.result.sgstPaise} />
            ) : null}
            {preview.result.igstPaise > 0n ? (
              <Figure label="IGST" value={preview.result.igstPaise} />
            ) : null}
            {preview.result.roundOffPaise !== 0n ? (
              <Figure label="Round off" value={preview.result.roundOffPaise} />
            ) : null}
            <Figure label="Total" value={preview.result.totalPaise} strong />
          </dl>
          <p className={ui.hint} style={{ marginTop: 8 }}>
            {amountInWords(preview.result.totalPaise)}
          </p>
        </div>
      ) : null}

      <div className={ui.actions} style={{ marginTop: 16 }}>
        <button className={ui.button} type="submit" disabled={pending || !partyId}>
          {pending ? 'Posting…' : 'Post invoice'}
        </button>
        <button
          className={ui.buttonGhost}
          type="button"
          disabled={pending || !partyId}
          onClick={() => submit(false)}
        >
          Save as draft
        </button>
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
        Posting is final. A posted invoice cannot be edited or deleted — a correction is a
        reversal plus a fresh invoice, so both stay visible in the audit trail.
      </p>
    </form>
  );
}

function Figure({ label, value, strong }: { label: string; value: bigint; strong?: boolean }) {
  return (
    <div className={ui.field}>
      <dt className={ui.label}>{label}</dt>
      <dd
        className="tnum"
        style={{ margin: 0, fontSize: strong ? 20 : 15, fontWeight: strong ? 500 : 400 }}
      >
        {formatRupees(paise(value))}
      </dd>
    </div>
  );
}
