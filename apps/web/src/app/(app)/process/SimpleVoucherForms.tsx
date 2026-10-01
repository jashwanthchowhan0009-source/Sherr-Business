'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { parseRupees } from '@/lib/accounting/units';
import { formatRupees, paise } from '@/lib/money';
import { createPayment, createJournal, createContra, reverseVoucher } from '@/server/purchases';
import { nextDay } from './InvoiceForm';

interface Named { id: string; name: string }
interface AccountOption { code: string; name: string }

type Message = { tone: 'ok' | 'err'; text: string } | null;

/**
 * The closed-period note, shown under every date field.
 *
 * Uniform across all the voucher forms: someone in the journal form is as
 * entitled to know the books are shut as someone raising an invoice, and a
 * message that appears on only some of them reads like a bug.
 */
function LockNote({ lockedUpto }: { lockedUpto: string | null }) {
  if (!lockedUpto) return null;
  return <p className={ui.hint}>The books are closed to {lockedUpto}.</p>;
}

function Status({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
      {message.text}
    </span>
  );
}

/** Paying a supplier: the mirror of a receipt. */
export function PaymentForm({
  parties,
  today,
  lockedUpto,
}: {
  parties: Named[];
  today: string;
  lockedUpto: string | null;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<Message>(null);

  if (parties.length === 0) {
    return <p className={ui.hint}>Add a supplier before recording a payment to one.</p>;
  }

  return (
    <form
      action={(formData: FormData) => {
        setMessage(null);
        start(async () => {
          const result = await createPayment({
            partyId: String(formData.get('partyId') ?? ''),
            voucherDate: String(formData.get('voucherDate') ?? today),
            amountRupees: String(formData.get('amountRupees') ?? ''),
            fromAccountCode: String(formData.get('fromAccountCode') ?? 'BANK'),
            reference: String(formData.get('reference') ?? ''),
          });
          setMessage(
            result.ok
              ? { tone: 'ok', text: `${result.data.voucherNo} posted.` }
              : { tone: 'err', text: result.error },
          );
        });
      }}
    >
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="pmt-party">To</label>
          <select className={ui.input} id="pmt-party" name="partyId" required defaultValue="">
            <option value="">Choose a supplier</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="pmt-date">Date</label>
          <input
            className={ui.input} id="pmt-date" name="voucherDate" type="date"
            defaultValue={today} required {...(lockedUpto ? { min: nextDay(lockedUpto) } : {})}
          />
          <LockNote lockedUpto={lockedUpto} />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="pmt-amount">Amount (₹)</label>
          <input className={ui.input} id="pmt-amount" name="amountRupees" inputMode="decimal" required placeholder="0.00" />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="pmt-from">Paid from</label>
          <select className={ui.input} id="pmt-from" name="fromAccountCode" defaultValue="BANK">
            <option value="BANK">Bank</option>
            <option value="CASH">Cash</option>
          </select>
        </div>
        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="pmt-ref">Reference</label>
          <input className={ui.input} id="pmt-ref" name="reference" maxLength={100} placeholder="UTR or cheque number" />
        </div>
      </div>
      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record payment'}
        </button>
        <Status message={message} />
      </div>
    </form>
  );
}

interface JournalLine { accountCode: string; debitRupees: string; creditRupees: string }
const emptyJournalLine = (): JournalLine => ({ accountCode: '', debitRupees: '', creditRupees: '' });

/**
 * A journal: the only voucher where the accounts are chosen by hand.
 *
 * The running difference is shown rather than hidden until submission, because
 * an unbalanced journal is the single most common mistake here and the person
 * making it can fix it in a second if they can see it.
 */
export function JournalForm({
  accounts,
  today,
  lockedUpto,
}: {
  accounts: AccountOption[];
  today: string;
  lockedUpto: string | null;
}) {
  const [pending, start] = useTransition();
  const [lines, setLines] = useState<JournalLine[]>([emptyJournalLine(), emptyJournalLine()]);
  const [narration, setNarration] = useState('');
  const [voucherDate, setVoucherDate] = useState(today);
  const [message, setMessage] = useState<Message>(null);

  const totals = lines.reduce(
    (acc, l) => {
      try {
        return {
          debit: acc.debit + parseRupees(l.debitRupees || '0'),
          credit: acc.credit + parseRupees(l.creditRupees || '0'),
          parsed: acc.parsed,
        };
      } catch {
        return { ...acc, parsed: false };
      }
    },
    { debit: 0n, credit: 0n, parsed: true },
  );
  const difference = totals.debit - totals.credit;
  const balanced = totals.parsed && difference === 0n && totals.debit > 0n;

  const setLine = (index: number, patch: Partial<JournalLine>) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <form
      action={() => {
        setMessage(null);
        start(async () => {
          const result = await createJournal({
            voucherDate,
            narration,
            lines: lines.filter((l) => l.accountCode),
          });
          if (result.ok) {
            setMessage({ tone: 'ok', text: `${result.data.voucherNo} posted.` });
            setLines([emptyJournalLine(), emptyJournalLine()]);
            setNarration('');
          } else {
            setMessage({ tone: 'err', text: result.error });
          }
        });
      }}
    >
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="jv-date">Date</label>
          <input
            className={ui.input} id="jv-date" type="date" value={voucherDate}
            onChange={(e) => setVoucherDate(e.target.value)} required
            {...(lockedUpto ? { min: nextDay(lockedUpto) } : {})}
          />
          <LockNote lockedUpto={lockedUpto} />
        </div>
        <div className={ui.field} style={{ gridColumn: '2 / -1' }}>
          <label className={ui.label} htmlFor="jv-narration">Narration</label>
          <input
            className={ui.input} id="jv-narration" value={narration} required
            onChange={(e) => setNarration(e.target.value)} maxLength={500}
            placeholder="Why this entry is being made"
            aria-describedby="jv-narration-hint"
          />
          <p className={ui.hint} id="jv-narration-hint">
            Required. A journal nobody can explain six months later is the entry an auditor asks
            about, and the one nobody can answer for.
          </p>
        </div>
      </div>

      <div className={ui.tableWrap} style={{ marginTop: 18 }}>
        <table className={ui.table}>
          <thead>
            <tr><th>Account</th><th className={ui.right}>Debit (₹)</th><th className={ui.right}>Credit (₹)</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>
                  <select
                    className={ui.input} value={line.accountCode}
                    onChange={(e) => setLine(index, { accountCode: e.target.value })}
                    aria-label={`Account on line ${index + 1}`}
                  >
                    <option value="">Choose an account</option>
                    {accounts.map((a) => (
                      <option key={a.code} value={a.code}>{a.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className={ui.input} value={line.debitRupees} inputMode="decimal"
                    onChange={(e) => setLine(index, { debitRupees: e.target.value, creditRupees: '' })}
                    aria-label={`Debit on line ${index + 1}`} style={{ textAlign: 'right' }}
                  />
                </td>
                <td>
                  <input
                    className={ui.input} value={line.creditRupees} inputMode="decimal"
                    onChange={(e) => setLine(index, { creditRupees: e.target.value, debitRupees: '' })}
                    aria-label={`Credit on line ${index + 1}`} style={{ textAlign: 'right' }}
                  />
                </td>
                <td>
                  {lines.length > 2 ? (
                    <button
                      type="button" className={ui.buttonGhost}
                      onClick={() => setLines(lines.filter((_, i) => i !== index))}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            <tr>
              <td className={ui.hint}>Total</td>
              <td className={`${ui.right} tnum`}>{formatRupees(paise(totals.debit))}</td>
              <td className={`${ui.right} tnum`}>{formatRupees(paise(totals.credit))}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className={ui.actions}>
        <button type="button" className={ui.buttonGhost} onClick={() => setLines([...lines, emptyJournalLine()])}>
          Add a line
        </button>
        <span className={balanced ? ui.statusOk : ui.hint} aria-live="polite">
          {!totals.parsed
            ? 'Checking the figures…'
            : difference === 0n
              ? totals.debit === 0n
                ? 'Nothing entered yet.'
                : 'Balanced.'
              : `Out by ${formatRupees(paise(difference > 0n ? difference : -difference))} — ${
                  difference > 0n ? 'credit' : 'debit'
                } side is short.`}
        </span>
      </div>

      <div className={ui.actions} style={{ marginTop: 12 }}>
        <button className={ui.button} type="submit" disabled={pending || !balanced || !narration}>
          {pending ? 'Posting…' : 'Post journal'}
        </button>
        <Status message={message} />
      </div>
    </form>
  );
}

/** Moving money between the company's own cash and bank. */
export function ContraForm({ today, lockedUpto }: { today: string; lockedUpto: string | null }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const [from, setFrom] = useState('BANK');

  return (
    <form
      action={(formData: FormData) => {
        setMessage(null);
        start(async () => {
          const result = await createContra({
            voucherDate: String(formData.get('voucherDate') ?? today),
            fromAccountCode: from,
            toAccountCode: from === 'BANK' ? 'CASH' : 'BANK',
            amountRupees: String(formData.get('amountRupees') ?? ''),
            narration: String(formData.get('narration') ?? ''),
          });
          setMessage(
            result.ok
              ? { tone: 'ok', text: `${result.data.voucherNo} posted.` }
              : { tone: 'err', text: result.error },
          );
        });
      }}
    >
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ctr-from">Move money</label>
          <select className={ui.input} id="ctr-from" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="BANK">From bank to cash</option>
            <option value="CASH">From cash to bank</option>
          </select>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ctr-date">Date</label>
          <input
            className={ui.input} id="ctr-date" name="voucherDate" type="date" defaultValue={today}
            required {...(lockedUpto ? { min: nextDay(lockedUpto) } : {})}
          />
          <LockNote lockedUpto={lockedUpto} />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ctr-amount">Amount (₹)</label>
          <input className={ui.input} id="ctr-amount" name="amountRupees" inputMode="decimal" required placeholder="0.00" />
        </div>
        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="ctr-narration">Narration</label>
          <input className={ui.input} id="ctr-narration" name="narration" maxLength={500} />
        </div>
      </div>
      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record contra'}
        </button>
        <Status message={message} />
      </div>
      <p className={ui.hint} style={{ marginTop: 12 }}>
        A contra only ever moves money between your own cash and bank accounts. The database
        refuses one that touches any other account, because a contra against a revenue ledger
        would be a disguised sale.
      </p>
    </form>
  );
}

/**
 * Reversing a posted voucher: the only way to correct one.
 *
 * The reason is required and goes into the reversal's narration, so the books
 * carry why as well as what. Dated today by default rather than on the
 * original's date, because back-dating a correction into a filed period changes
 * figures that have already been reported.
 */
export function ReverseButton({
  voucherId,
  voucherNo,
  today,
}: {
  voucherId: string;
  voucherNo: string;
  today: string;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<Message>(null);

  if (!open) {
    return (
      <button type="button" className={ui.buttonGhost} onClick={() => setOpen(true)}>
        Reverse
      </button>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 220 }}>
      <label className="sr-only" htmlFor={`rev-${voucherId}`}>
        Why {voucherNo} is being reversed
      </label>
      <input
        className={ui.input}
        id={`rev-${voucherId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why — e.g. entered in error"
        maxLength={300}
      />
      <div className={ui.actions}>
        <button
          type="button"
          className={ui.button}
          disabled={pending || reason.trim().length < 3}
          onClick={() =>
            start(async () => {
              const result = await reverseVoucher({ id: voucherId, voucherDate: today, reason });
              setMessage(
                result.ok
                  ? { tone: 'ok', text: `Reversed by ${result.data.voucherNo}.` }
                  : { tone: 'err', text: result.error },
              );
              if (result.ok) setOpen(false);
            })
          }
        >
          {pending ? 'Reversing…' : 'Confirm'}
        </button>
        <button type="button" className={ui.buttonGhost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Status message={message} />
    </div>
  );
}
