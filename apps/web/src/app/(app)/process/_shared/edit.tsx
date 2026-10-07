'use client';

import { ui } from '@/components/ui';

/**
 * What every voucher form needs to know when it is editing rather than adding.
 *
 * `posted` changes what "save" means. A draft is rewritten under its own
 * number. A posted voucher is corrected: the server reverses it and posts the
 * edited version as a replacement, so the form asks why, and the reason goes
 * into the books with the reversal.
 */
export interface EditTarget {
  voucherId: string;
  voucherNo: string;
  posted: boolean;
}

/** The "why is this changing" field, shown only when editing a posted voucher. */
export function ReasonField({
  edit,
  value,
  onChange,
}: {
  edit: EditTarget | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  if (!edit?.posted) return null;
  const id = `reason-${edit.voucherId}`;
  return (
    <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
      <label className={ui.label} htmlFor={id}>
        Reason for the change
      </label>
      <input
        className={ui.input}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        minLength={3}
        maxLength={300}
        aria-describedby={`${id}-hint`}
      />
      <p className={ui.hint} id={`${id}-hint`}>
        {edit.voucherNo} is posted, so saving reverses it and posts the corrected entry in its
        place. Both stay in the books, with this reason against them.
      </p>
    </div>
  );
}

/** True when the form has what it needs to submit an edit. */
export function reasonReady(edit: EditTarget | undefined, reason: string): boolean {
  return !edit?.posted || reason.trim().length >= 3;
}

/**
 * The message shown after an edit is saved, from the server's reply.
 *
 * Spelled out because the two kinds of edit leave the books in different
 * states, and the person should know which one just happened.
 */
export function editedMessage(data: {
  voucherNo: string;
  mode: 'draft' | 'posted';
  originalVoucherNo: string;
  reversalVoucherNo: string | null;
}): string {
  return data.mode === 'posted'
    ? `${data.originalVoucherNo} reversed by ${data.reversalVoucherNo ?? 'a reversal'}; corrected entry posted as ${data.voucherNo}.`
    : `${data.voucherNo} saved.`;
}

/** After an edit, back to the list the edit was opened from. */
export function returnToProcess(): void {
  window.setTimeout(() => window.location.assign('/process#vouchers'), 1200);
}
