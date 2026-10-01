'use client';

import { useMemo } from 'react';
import { ui } from '@/components/ui';
import { calculateInvoice, type GstInvoiceResult, type SupplyType } from '@/lib/accounting/gst';
import { QTY_SCALE, parseQuantity, parseRupees } from '@/lib/accounting/units';
import { amountInWords } from '@/lib/accounting/amount-in-words';
import { formatRupees, paise } from '@/lib/money';
import { STATE_CODES } from '@/lib/india/gstin';

/**
 * The tax-line table and the working beneath it, shared by every voucher that
 * carries GST: sales invoices, purchase bills, credit notes and debit notes.
 *
 * One component rather than four copies, because the arithmetic shown here is
 * the thing a person checks before posting, and four copies would be four
 * chances for one of them to drift.
 */

export const GST_SLABS = [0, 25, 300, 500, 1200, 1800, 2800, 4000] as const;

export interface TaxLine {
  itemId: string;
  description: string;
  hsnSac: string;
  unit: string;
  quantity: string;
  unitPriceRupees: string;
  gstRateBps: number;
  reverseCharge: boolean;
}

export interface ItemOption {
  id: string;
  name: string;
  hsnSac: string | null;
  unit: string;
  gstRateBps: number;
  salePricePaise: bigint | null;
  purchasePricePaise?: bigint | null;
}

export const emptyTaxLine = (): TaxLine => ({
  itemId: '',
  description: '',
  hsnSac: '',
  unit: 'NOS',
  quantity: '1',
  unitPriceRupees: '',
  gstRateBps: 1800,
  reverseCharge: false,
});

/** The lines that carry a figure, in the shape a server action expects. */
export function usableLines(lines: readonly TaxLine[]) {
  return lines
    .filter((l) => l.unitPriceRupees.trim() !== '')
    .map((l) => ({
      ...(l.itemId ? { itemId: l.itemId } : {}),
      description: l.description || 'Item',
      hsnSac: l.hsnSac,
      unit: l.unit,
      quantity: l.quantity || '1',
      unitPriceRupees: l.unitPriceRupees,
      gstRateBps: l.gstRateBps,
      reverseCharge: l.reverseCharge,
    }));
}

/**
 * Runs the same engine the server runs, over whatever currently parses.
 *
 * Returns null while a figure is half-typed, so the working waits rather than
 * flashing an error over an incomplete amount. The result is never sent: it is
 * shown, and the server recalculates from the raw inputs.
 */
export function useGstPreview(
  lines: readonly TaxLine[],
  supplyType: SupplyType | null,
): GstInvoiceResult | null {
  return useMemo(() => {
    if (!supplyType) return null;
    const usable = lines.filter((l) => l.unitPriceRupees.trim() !== '');
    if (usable.length === 0) return null;
    try {
      return calculateInvoice(
        usable.map((l) => ({
          quantity: l.quantity.trim() === '' ? QTY_SCALE : parseQuantity(l.quantity),
          unitPricePaise: parseRupees(l.unitPriceRupees),
          gstRateBps: l.gstRateBps,
          reverseCharge: l.reverseCharge,
        })),
        supplyType,
      );
    } catch {
      return null;
    }
  }, [lines, supplyType]);
}

export function TaxLinesEditor({
  lines,
  items,
  onChange,
  priceOf = (item) => item.salePricePaise,
  allowReverseCharge = false,
}: {
  lines: TaxLine[];
  items: readonly ItemOption[];
  onChange: (lines: TaxLine[]) => void;
  priceOf?: (item: ItemOption) => bigint | null | undefined;
  allowReverseCharge?: boolean;
}) {
  const setLine = (index: number, patch: Partial<TaxLine>) =>
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const chooseItem = (index: number, itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    const price = item ? priceOf(item) : null;
    setLine(index, {
      itemId,
      ...(item
        ? {
            description: item.name,
            hsnSac: item.hsnSac ?? '',
            unit: item.unit,
            gstRateBps: item.gstRateBps,
            unitPriceRupees:
              price !== null && price !== undefined
                ? formatRupees(paise(price), { symbol: false })
                : '',
          }
        : {}),
    });
  };

  return (
    <>
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
              {allowReverseCharge ? <th>RCM</th> : null}
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
                    {GST_SLABS.map((bps) => (
                      <option key={bps} value={bps}>{bps / 100}%</option>
                    ))}
                  </select>
                </td>
                {allowReverseCharge ? (
                  <td>
                    <input
                      type="checkbox"
                      checked={line.reverseCharge}
                      onChange={(e) => setLine(index, { reverseCharge: e.target.checked })}
                      aria-label={`Reverse charge on line ${index + 1}`}
                    />
                  </td>
                ) : null}
                <td>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      className={ui.buttonGhost}
                      onClick={() => onChange(lines.filter((_, i) => i !== index))}
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
          onClick={() => onChange([...lines, emptyTaxLine()])}
        >
          Add a line
        </button>
      </div>
    </>
  );
}

/**
 * The working: what the engine makes of the lines, before anything is posted.
 *
 * `taxDirection` only changes the wording — "we charge" against "we can claim"
 * — because the figures are the same calculation either way and only their
 * meaning differs.
 */
export function GstWorking({
  result,
  supplyType,
  supplierStateCode,
  placeOfSupplyStateCode,
  taxDirection = 'output',
}: {
  result: GstInvoiceResult;
  supplyType: SupplyType;
  supplierStateCode: string | null;
  placeOfSupplyStateCode: string;
  taxDirection?: 'output' | 'input';
}) {
  const name = (code: string | null) => (code ? STATE_CODES[code] ?? code : 'Unknown');

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--sb-hairline)', paddingTop: 14 }}>
      <p className={ui.hint}>
        {supplyType === 'intra_state'
          ? `Within ${name(placeOfSupplyStateCode)} — CGST and SGST, half the rate each.`
          : supplyType === 'inter_state'
            ? `${name(supplierStateCode)} to ${name(placeOfSupplyStateCode)} — IGST at the full rate.`
            : supplyType === 'zero_rated'
              ? 'Zero-rated supply.'
              : 'Exempt supply.'}
        {taxDirection === 'input'
          ? ' Tax here is input credit: an asset, not a liability.'
          : ''}
      </p>
      <dl className={ui.formGrid} style={{ marginTop: 10 }}>
        <Figure label="Taxable value" value={result.taxablePaise} />
        {result.cgstPaise > 0n ? <Figure label="CGST" value={result.cgstPaise} /> : null}
        {result.sgstPaise > 0n ? <Figure label="SGST" value={result.sgstPaise} /> : null}
        {result.igstPaise > 0n ? <Figure label="IGST" value={result.igstPaise} /> : null}
        {result.cessPaise > 0n ? <Figure label="Cess" value={result.cessPaise} /> : null}
        {result.roundOffPaise !== 0n ? (
          <Figure label="Round off" value={result.roundOffPaise} />
        ) : null}
        <Figure label="Total" value={result.totalPaise} strong />
      </dl>
      <p className={ui.hint} style={{ marginTop: 8 }}>
        {amountInWords(result.totalPaise)}
      </p>
      {result.totalTaxPaise === 0n && result.taxablePaise > 0n ? (
        <p className={ui.hint}>
          No tax on these lines. That is correct for an exempt or reverse-charge supply, and
          wrong for anything else — check the rate before posting.
        </p>
      ) : null}
    </div>
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
