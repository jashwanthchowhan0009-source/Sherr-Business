'use client';

import { useTransition, useState } from 'react';
import { ui } from '@/components/ui';
import { ITEM_KINDS } from '@/lib/db/schema';
import { createItem } from '@/server/ledger';

/** The GST slabs. Each is flagged as needing CA verification in tax_rules. */
const SLABS = [
  { bps: 0, label: 'Nil / exempt' },
  { bps: 25, label: '0.25%' },
  { bps: 300, label: '3%' },
  { bps: 500, label: '5%' },
  { bps: 1200, label: '12%' },
  { bps: 1800, label: '18%' },
  { bps: 2800, label: '28%' },
  { bps: 4000, label: '40%' },
] as const;

export function ItemForm() {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  function onSubmit(formData: FormData) {
    setMessage(null);
    start(async () => {
      const result = await createItem({
        code: String(formData.get('code') ?? ''),
        name: String(formData.get('name') ?? ''),
        kind: String(formData.get('kind') ?? 'goods'),
        hsnSac: String(formData.get('hsnSac') ?? ''),
        unit: String(formData.get('unit') ?? 'NOS'),
        gstRateBps: Number(formData.get('gstRateBps') ?? 0),
        salePriceRupees: String(formData.get('salePriceRupees') ?? ''),
      });
      setMessage(
        result.ok
          ? { tone: 'ok', text: `${result.data.name} added.` }
          : { tone: 'err', text: result.error },
      );
    });
  }

  return (
    <form action={onSubmit}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-name">Name</label>
          <input className={ui.input} id="item-name" name="name" required maxLength={200} />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-kind">Goods or service</label>
          <select className={ui.input} id="item-kind" name="kind" defaultValue="goods">
            {ITEM_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind === 'goods' ? 'Goods' : 'Service'}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-hsn">HSN or SAC</label>
          <input
            className={ui.input}
            id="item-hsn"
            name="hsnSac"
            maxLength={8}
            inputMode="numeric"
            placeholder="1006"
            style={{ fontFamily: 'ui-monospace, monospace' }}
          />
          <p className={ui.hint}>HSN for goods, SAC for a service. Four to eight digits.</p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-rate">GST rate</label>
          <select className={ui.input} id="item-rate" name="gstRateBps" defaultValue={1800}>
            {SLABS.map((slab) => (
              <option key={slab.bps} value={slab.bps}>{slab.label}</option>
            ))}
          </select>
          <p className={ui.hint}>
            Every rate is unverified until a CA signs it off. Confirm the slab for this item.
          </p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-unit">Unit</label>
          <input className={ui.input} id="item-unit" name="unit" defaultValue="NOS" maxLength={12} />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-price">Sale price (₹)</label>
          <input
            className={ui.input}
            id="item-price"
            name="salePriceRupees"
            inputMode="decimal"
            placeholder="0.00"
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-code">Code</label>
          <input className={ui.input} id="item-code" name="code" maxLength={32} />
        </div>
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add item'}
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
