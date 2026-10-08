'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { verifyTaxRule } from '@/server/gst';

/**
 * A CA signing a tax rule off.
 *
 * The name and membership number are required, because "a professional approved
 * this rate" is a claim that needs an owner. A rule shipped with the product
 * cannot be signed off by one company: whoever maintains the product ships those
 * verified or not at all, and the button is absent for them.
 */
export function VerifyRuleForm({
  ruleId,
  ruleLabel,
  isOwnRule,
}: {
  ruleId: string;
  ruleLabel: string;
  isOwnRule: boolean;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  if (!isOwnRule) {
    return (
      <span className={ui.hint}>
        Shipped with the product. It cannot be signed off for one company only.
      </span>
    );
  }

  if (!open) {
    return (
      <>
        <button type="button" className={ui.buttonGhost} onClick={() => setOpen(true)}>
          Sign off
        </button>
        {message ? (
          <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr}>{message.text}</span>
        ) : null}
      </>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 260 }}>
      <label className={ui.label} htmlFor={`verify-${ruleId}`}>
        Who is signing off {ruleLabel} — name and membership number
      </label>
      <input
        className={ui.input}
        id={`verify-${ruleId}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={200}
      />
      <div className={ui.actions}>
        <button
          type="button"
          className={ui.button}
          disabled={pending || name.trim().length < 3}
          onClick={() =>
            start(async () => {
              const result = await verifyTaxRule({ ruleId, verifiedBy: name });
              setMessage(
                result.ok
                  ? { tone: 'ok', text: 'Signed off.' }
                  : { tone: 'err', text: result.error },
              );
              if (result.ok) setOpen(false);
            })
          }
        >
          {pending ? 'Recording…' : 'Confirm'}
        </button>
        <button type="button" className={ui.buttonGhost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {message ? (
        <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
          {message.text}
        </span>
      ) : null}
    </div>
  );
}
