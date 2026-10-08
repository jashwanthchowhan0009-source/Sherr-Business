'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { createGoodsReceipt, createPurchaseOrder, updatePurchaseOrder } from '@/server/procurement';

interface Named { id: string; name: string }
interface ItemNamed { id: string; name: string; unit: string }
interface PoOption { id: string; poNo: string; partyId: string }

export interface Line {
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPriceRupees: string;
}

const emptyLine = (): Line => ({
  itemId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPriceRupees: '',
});

type Message = { tone: 'ok' | 'err'; text: string } | null;

function Status({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
      {message.text}
    </span>
  );
}

/**
 * A shared line editor for orders and receipts.
 *
 * A receipt has no price — what a delivery cost is the bill's business, and
 * asking for it here would invite someone to enter the price they expected
 * rather than the one they were charged, which would defeat the match.
 */
function LineEditor({
  lines,
  items,
  onChange,
  withPrice,
  idPrefix,
}: {
  lines: Line[];
  items: readonly ItemNamed[];
  onChange: (lines: Line[]) => void;
  withPrice: boolean;
  idPrefix: string;
}) {
  const setLine = (index: number, patch: Partial<Line>) =>
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <>
      <div className={ui.tableWrap} style={{ marginTop: 14 }}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Item</th>
              <th>Description</th>
              <th>Quantity</th>
              <th>Unit</th>
              {withPrice ? <th>Rate (₹)</th> : null}
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
                    aria-label={`${idPrefix} item on line ${index + 1}`}
                    onChange={(e) => {
                      const item = items.find((i) => i.id === e.target.value);
                      setLine(index, {
                        itemId: e.target.value,
                        ...(item ? { description: item.name, unit: item.unit } : {}),
                      });
                    }}
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
                    aria-label={`${idPrefix} description on line ${index + 1}`}
                    onChange={(e) => setLine(index, { description: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className={ui.input}
                    value={line.quantity}
                    inputMode="decimal"
                    style={{ width: 90 }}
                    aria-label={`${idPrefix} quantity on line ${index + 1}`}
                    onChange={(e) => setLine(index, { quantity: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className={ui.input}
                    value={line.unit}
                    style={{ width: 80 }}
                    aria-label={`${idPrefix} unit on line ${index + 1}`}
                    onChange={(e) => setLine(index, { unit: e.target.value })}
                  />
                </td>
                {withPrice ? (
                  <td>
                    <input
                      className={ui.input}
                      value={line.unitPriceRupees}
                      inputMode="decimal"
                      style={{ width: 110 }}
                      aria-label={`${idPrefix} rate on line ${index + 1}`}
                      onChange={(e) => setLine(index, { unitPriceRupees: e.target.value })}
                    />
                  </td>
                ) : null}
                <td>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      className={ui.buttonGhost}
                      aria-label={`Remove ${idPrefix} line ${index + 1}`}
                      onClick={() => onChange(lines.filter((_, i) => i !== index))}
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
        <button type="button" className={ui.buttonGhost} onClick={() => onChange([...lines, emptyLine()])}>
          Add a line
        </button>
      </div>
    </>
  );
}

export interface PurchaseOrderInitial {
  id: string;
  poNo: string;
  partyId: string;
  poDate: string;
  expectedDate: string;
  narration: string;
  lines: Line[];
}

export function PurchaseOrderForm({
  suppliers,
  items,
  today,
  initial,
}: {
  suppliers: Named[];
  items: ItemNamed[];
  today: string;
  initial?: PurchaseOrderInitial;
}) {
  const [pending, start] = useTransition();
  const [lines, setLines] = useState<Line[]>(initial?.lines.length ? initial.lines : [emptyLine()]);
  const [message, setMessage] = useState<Message>(null);

  if (suppliers.length === 0) {
    return <p className={ui.hint}>Add a supplier before raising an order with one.</p>;
  }

  return (
    <form
      action={(formData: FormData) => {
        setMessage(null);
        start(async () => {
          const fields = {
            partyId: String(formData.get('partyId') ?? ''),
            poDate: String(formData.get('poDate') ?? today),
            expectedDate: String(formData.get('expectedDate') ?? ''),
            narration: String(formData.get('narration') ?? ''),
            lines: lines
              .filter((l) => l.quantity.trim() !== '')
              .map((l) => ({
                ...(l.itemId ? { itemId: l.itemId } : {}),
                description: l.description,
                quantity: l.quantity,
                unit: l.unit,
                unitPriceRupees: l.unitPriceRupees || '0',
              })),
          };
          const result = initial
            ? await updatePurchaseOrder({ id: initial.id, ...fields })
            : await createPurchaseOrder(fields);
          if (result.ok) {
            setMessage({
              tone: 'ok',
              text: `${result.data.poNo} ${initial ? 'saved' : 'raised'}.`,
            });
            if (!initial) setLines([emptyLine()]);
          } else {
            setMessage({ tone: 'err', text: result.error });
          }
        });
      }}
    >
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-party">Supplier</label>
          <select className={ui.input} id="po-party" name="partyId" required defaultValue={initial?.partyId ?? ''}>
            <option value="">Choose a supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-date">Order date</label>
          <input className={ui.input} id="po-date" name="poDate" type="date" defaultValue={initial?.poDate ?? today} required />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-expected">Expected by</label>
          <input className={ui.input} id="po-expected" name="expectedDate" type="date" defaultValue={initial?.expectedDate ?? ''} />
        </div>
        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="po-narration">Note</label>
          <input className={ui.input} id="po-narration" name="narration" maxLength={500} defaultValue={initial?.narration ?? ''} />
        </div>
      </div>

      <LineEditor lines={lines} items={items} onChange={setLines} withPrice idPrefix="Order" />

      <div className={ui.actions} style={{ marginTop: 12 }}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Save changes' : 'Raise order'}
        </button>
        <Status message={message} />
      </div>
      <p className={ui.hint} style={{ marginTop: 10 }}>
        An order is not an accounting entry: nothing is posted and no balance changes. It exists so
        the bill can be checked against what was agreed.
      </p>
    </form>
  );
}

export function GoodsReceiptForm({
  suppliers,
  items,
  orders,
  today,
}: {
  suppliers: Named[];
  items: ItemNamed[];
  orders: PoOption[];
  today: string;
}) {
  const [pending, start] = useTransition();
  const [partyId, setPartyId] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [message, setMessage] = useState<Message>(null);

  if (suppliers.length === 0) {
    return <p className={ui.hint}>Add a supplier before recording a delivery from one.</p>;
  }

  // Only that supplier's orders: a receipt against another supplier's order is a
  // data-entry error that would make the match meaningless.
  const theirOrders = orders.filter((o) => !partyId || o.partyId === partyId);

  return (
    <form
      action={(formData: FormData) => {
        setMessage(null);
        start(async () => {
          const result = await createGoodsReceipt({
            partyId,
            poId: String(formData.get('poId') ?? ''),
            receiptDate: String(formData.get('receiptDate') ?? today),
            challanNo: String(formData.get('challanNo') ?? ''),
            challanDate: String(formData.get('challanDate') ?? ''),
            narration: String(formData.get('narration') ?? ''),
            lines: lines
              .filter((l) => l.quantity.trim() !== '')
              .map((l) => ({
                ...(l.itemId ? { itemId: l.itemId } : {}),
                description: l.description,
                quantity: l.quantity,
                unit: l.unit,
              })),
          });
          if (result.ok) {
            setMessage({ tone: 'ok', text: `${result.data.grnNo} recorded.` });
            setLines([emptyLine()]);
          } else {
            setMessage({ tone: 'err', text: result.error });
          }
        });
      }}
    >
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="grn-party">Supplier</label>
          <select
            className={ui.input}
            id="grn-party"
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
            required
          >
            <option value="">Choose a supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="grn-po">Against order</label>
          <select className={ui.input} id="grn-po" name="poId" defaultValue="">
            <option value="">No order</option>
            {theirOrders.map((o) => <option key={o.id} value={o.id}>{o.poNo}</option>)}
          </select>
          <p className={ui.hint}>
            Naming the order is what makes the three-way match possible.
          </p>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="grn-date">Received on</label>
          <input className={ui.input} id="grn-date" name="receiptDate" type="date" defaultValue={today} required />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="grn-challan">Their challan number</label>
          <input className={ui.input} id="grn-challan" name="challanNo" maxLength={60} style={{ fontFamily: 'ui-monospace, monospace' }} />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="grn-challan-date">Challan date</label>
          <input className={ui.input} id="grn-challan-date" name="challanDate" type="date" />
        </div>
        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="grn-narration">Note</label>
          <input className={ui.input} id="grn-narration" name="narration" maxLength={500} />
        </div>
      </div>

      <LineEditor lines={lines} items={items} onChange={setLines} withPrice={false} idPrefix="Receipt" />

      <div className={ui.actions} style={{ marginTop: 12 }}>
        <button className={ui.button} type="submit" disabled={pending || !partyId}>
          {pending ? 'Recording…' : 'Record what arrived'}
        </button>
        <Status message={message} />
      </div>
      <p className={ui.hint} style={{ marginTop: 10 }}>
        Record what actually arrived, not what was expected. The difference is the thing the match
        exists to find.
      </p>
    </form>
  );
}
