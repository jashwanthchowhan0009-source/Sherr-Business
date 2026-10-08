'use client';

import { useTransition, useState } from 'react';
import { ui } from '@/components/ui';
import { ITEM_KINDS } from '@/lib/db/schema';
import { createItem, updateItem } from '@/server/ledger';

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

export interface ItemInitial {
  id: string;
  code: string;
  name: string;
  kind: string;
  hsnSac: string;
  unit: string;
  gstRateBps: number;
  salePriceRupees: string;
  purchasePriceRupees: string;
  isActive: boolean;
}

/** Adding an item, or editing one. Nothing is pre-filled for a new item. */
export function ItemForm({ initial }: { initial?: ItemInitial } = {}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);

  function onSubmit(formData: FormData) {
    setMessage(null);
    start(async () => {
      const fields = {
        code: String(formData.get('code') ?? ''),
        name: String(formData.get('name') ?? ''),
        kind: String(formData.get('kind') ?? ''),
        hsnSac: String(formData.get('hsnSac') ?? ''),
        unit: String(formData.get('unit') ?? ''),
        gstRateBps: String(formData.get('gstRateBps') ?? ''),
        salePriceRupees: String(formData.get('salePriceRupees') ?? ''),
        purchasePriceRupees: String(formData.get('purchasePriceRupees') ?? ''),
      };
      const result = initial
        ? await updateItem({
            id: initial.id,
            ...fields,
            isActive: formData.get('isActive') === 'on',
          })
        : await createItem(fields);
      setMessage(
        result.ok
          ? { tone: 'ok', text: `${result.data.name} ${initial ? 'saved' : 'added'}.` }
          : { tone: 'err', text: result.error },
      );
      if (result.ok && !initial) setFormKey((k) => k + 1);
    });
  }

  return (
    <form action={onSubmit} key={formKey}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-name">Name</label>
          <input
            className={ui.input}
            id="item-name"
            name="name"
            required
            maxLength={200}
            defaultValue={initial?.name ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-kind">Goods or service</label>
          <select
            className={ui.input}
            id="item-kind"
            name="kind"
            required
            defaultValue={initial?.kind ?? ''}
          >
            <option value="">Choose</option>
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
            style={{ fontFamily: 'ui-monospace, monospace' }}
            defaultValue={initial?.hsnSac ?? ''}
          />
          <p className={ui.hint}>HSN for goods, SAC for a service. Four to eight digits.</p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-rate">GST rate</label>
          <select
            className={ui.input}
            id="item-rate"
            name="gstRateBps"
            required
            defaultValue={initial ? initial.gstRateBps : ''}
          >
            <option value="">Choose</option>
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
          <input
            className={ui.input}
            id="item-unit"
            name="unit"
            required
            maxLength={12}
            defaultValue={initial?.unit ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-price">Sale price (₹)</label>
          <input
            className={ui.input}
            id="item-price"
            name="salePriceRupees"
            inputMode="decimal"
            defaultValue={initial?.salePriceRupees ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-buy-price">Purchase price (₹)</label>
          <input
            className={ui.input}
            id="item-buy-price"
            name="purchasePriceRupees"
            inputMode="decimal"
            defaultValue={initial?.purchasePriceRupees ?? ''}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="item-code">Code</label>
          <input
            className={ui.input}
            id="item-code"
            name="code"
            maxLength={32}
            defaultValue={initial?.code ?? ''}
          />
        </div>

        {initial ? (
          <div className={ui.field}>
            <label className={ui.label} htmlFor="item-active">In use</label>
            <input
              id="item-active"
              name="isActive"
              type="checkbox"
              defaultChecked={initial.isActive}
            />
            <p className={ui.hint}>Untick to hide it from new entries.</p>
          </div>
        ) : null}
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Save changes' : 'Add item'}
        </button>
        {message ? (
          <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
            {message.text}
          </span>
        ) : null}
      </div>

      {initial ? (
        <p className={ui.hint} style={{ marginTop: 12 }}>
          A new rate or price applies to entries made from now on. Posted invoices keep the
          figures they were calculated with.
        </p>
      ) : null}
    </form>
  );
}
