'use client';

import { useRef, useState, useTransition } from 'react';
import { StatusPill, ui } from '@/components/ui';
import { formatRupees, paise } from '@/lib/money';
import { MATCH_TIER_LABELS, type MatchTier } from '@/lib/banking/matching';
import {
  acceptMatch,
  addBankAccount,
  ignoreStatementLine,
  importStatement,
  rejectMatch,
  rematchStatement,
} from '@/server/banking';

export interface BankAccountOption {
  id: string;
  label: string;
}

export interface ReviewRow {
  lineId: string;
  lineDate: string;
  narration: string;
  reference: string | null;
  amountPaise: string;
  status: string;
  suggestion: {
    id: string;
    voucherId: string;
    voucherNo: string;
    voucherType: string;
    voucherDate: string;
    partyName: string | null;
    tier: MatchTier;
    confidence: number;
    reasons: string[];
    dayDifference: number;
  } | null;
}

type Message = { tone: 'ok' | 'err'; text: string } | null;

const TIER_STATUS: Record<MatchTier, 'verified' | 'provisional' | 'draft'> = {
  exact: 'verified',
  strong: 'verified',
  probable: 'provisional',
  weak: 'draft',
};

/**
 * Importing a bank statement and reviewing what it matched.
 *
 * Nothing on this screen posts a voucher. Importing records what the bank says
 * happened; accepting a match records that the bank and the books agree about a
 * transaction the books already carry. A screen that posted on import would make
 * the same money appear twice.
 */
export function BankPanel({
  accounts,
  ledgerAccounts,
  selectedAccountId,
  queue,
  readOnly,
}: {
  accounts: BankAccountOption[];
  ledgerAccounts: { id: string; name: string }[];
  selectedAccountId: string | null;
  queue: ReviewRow[];
  readOnly: boolean;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const [problems, setProblems] = useState<{ rowNumber: number; reason: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  if (accounts.length === 0) {
    return (
      <>
        <p className={ui.hint}>
          Add the bank account a statement belongs to. Only the last four digits of the account
          number are stored — the full number is not needed to reconcile and is not worth holding.
        </p>
        {readOnly ? null : (
          <form
            action={(formData: FormData) => {
              setMessage(null);
              start(async () => {
                const result = await addBankAccount({
                  ledgerAccountId: String(formData.get('ledgerAccountId') ?? ''),
                  bankName: String(formData.get('bankName') ?? ''),
                  accountLabel: String(formData.get('accountLabel') ?? ''),
                  accountNumberLast4: String(formData.get('accountNumberLast4') ?? ''),
                  ifsc: String(formData.get('ifsc') ?? ''),
                });
                setMessage(
                  result.ok
                    ? { tone: 'ok', text: `${result.data.label} added.` }
                    : { tone: 'err', text: result.error },
                );
              });
            }}
          >
            <div className={ui.formGrid}>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="ba-bank">Bank</label>
                <input className={ui.input} id="ba-bank" name="bankName" required maxLength={100} placeholder="HDFC Bank" />
              </div>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="ba-label">Name it</label>
                <input className={ui.input} id="ba-label" name="accountLabel" required maxLength={100} placeholder="Current account" />
              </div>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="ba-ledger">Posts to</label>
                <select className={ui.input} id="ba-ledger" name="ledgerAccountId" required defaultValue="">
                  <option value="">Choose a ledger account</option>
                  {ledgerAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="ba-last4">Last four digits</label>
                <input className={ui.input} id="ba-last4" name="accountNumberLast4" maxLength={4} inputMode="numeric" />
              </div>
              <div className={ui.field}>
                <label className={ui.label} htmlFor="ba-ifsc">IFSC</label>
                <input className={ui.input} id="ba-ifsc" name="ifsc" maxLength={11} placeholder="HDFC0001234" style={{ fontFamily: 'ui-monospace, monospace' }} />
              </div>
            </div>
            <div className={ui.actions}>
              <button className={ui.button} type="submit" disabled={pending}>
                {pending ? 'Adding…' : 'Add bank account'}
              </button>
              <Status message={message} />
            </div>
          </form>
        )}
      </>
    );
  }

  const accountId = selectedAccountId ?? accounts[0]!.id;

  const upload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0]!;
    setMessage(null);
    setProblems([]);
    start(async () => {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }

      const result = await importStatement({
        bankAccountId: accountId,
        contentBase64: btoa(binary),
      });

      if (result.ok) {
        const d = result.data;
        setProblems(d.problems);
        setMessage({
          tone: 'ok',
          text:
            `${d.inserted} of ${d.linesRead} transactions imported` +
            (d.duplicates > 0 ? `, ${d.duplicates} already present` : '') +
            `. ${d.suggested} matched, ${d.unmatched} need a decision.` +
            (d.balanceConsistent
              ? ''
              : ` The statement's own running balance stops adding up at row ${d.firstBalanceBreakRow} — check the file is complete.`),
        });
      } else {
        setMessage({ tone: 'err', text: result.error });
      }
      if (fileRef.current) fileRef.current.value = '';
    });
  };

  const decide = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setMessage(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) setMessage({ tone: 'err', text: result.error ?? 'That did not work.' });
    });
  };

  return (
    <>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="bank-file">Statement file</label>
          <input
            ref={fileRef}
            className={ui.input}
            id="bank-file"
            type="file"
            accept=".csv,.txt,text/csv"
            disabled={readOnly || pending}
            onChange={(e) => upload(e.target.files)}
          />
          <p className={ui.hint}>
            A CSV export from your bank. Importing posts nothing — it records what the bank says
            happened, then proposes matches against what the books already say.
          </p>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="bank-account">Account</label>
          <select className={ui.input} id="bank-account" defaultValue={accountId} disabled>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={ui.actions}>
        {readOnly ? null : (
          <button
            type="button"
            className={ui.buttonGhost}
            disabled={pending}
            onClick={() => decide(() => rematchStatement({ bankAccountId: accountId }))}
          >
            {pending ? 'Matching…' : 'Match again'}
          </button>
        )}
        <Status message={message} />
      </div>

      {problems.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <p className={ui.hint}>
            {problems.length} {problems.length === 1 ? 'row' : 'rows'} could not be read. Nothing
            was guessed — these were left out rather than imported with an assumed amount.
          </p>
          <ul className={ui.hint} style={{ marginTop: 6 }}>
            {problems.slice(0, 10).map((p) => (
              <li key={p.rowNumber}>Row {p.rowNumber}: {p.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {queue.length === 0 ? (
        <p className={ui.hint} style={{ marginTop: 18 }}>
          Nothing is waiting for a decision on this account.
        </p>
      ) : (
        <div className={ui.tableWrap} style={{ marginTop: 18 }}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>What the bank says</th>
                <th className={ui.right}>Amount</th>
                <th>Proposed match</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={row.lineId}>
                  <td className="tnum">{row.lineDate}</td>
                  <td>
                    {row.narration || <span className={ui.hint}>No narration</span>}
                    {row.reference ? <div className={ui.hint}>Ref {row.reference}</div> : null}
                  </td>
                  <td className={`${ui.right} tnum`}>
                    {formatRupees(paise(BigInt(row.amountPaise)))}
                  </td>
                  <td>
                    {row.suggestion ? (
                      <>
                        <div>
                          <b>{row.suggestion.voucherNo}</b>{' '}
                          <StatusPill status={TIER_STATUS[row.suggestion.tier]}>
                            {row.suggestion.confidence}%
                          </StatusPill>
                        </div>
                        <div className={ui.hint}>
                          {row.suggestion.partyName ?? 'No party'} · {row.suggestion.voucherDate}
                        </div>
                        <div className={ui.hint}>{MATCH_TIER_LABELS[row.suggestion.tier]}</div>
                        <ul className={ui.hint} style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                          {row.suggestion.reasons.map((reason, i) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <span className={ui.hint}>
                        Nothing in the books matches this. Enter the voucher it belongs to, or mark
                        it as needing none.
                      </span>
                    )}
                  </td>
                  <td>
                    {readOnly ? null : (
                      <div style={{ display: 'grid', gap: 6 }}>
                        {row.suggestion ? (
                          <>
                            <button
                              type="button"
                              className={ui.button}
                              disabled={pending}
                              onClick={() =>
                                decide(() => acceptMatch({ suggestionId: row.suggestion!.id }))
                              }
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              className={ui.buttonGhost}
                              disabled={pending}
                              onClick={() =>
                                decide(() => rejectMatch({ suggestionId: row.suggestion!.id }))
                              }
                            >
                              Not this one
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className={ui.buttonGhost}
                          disabled={pending}
                          onClick={() =>
                            decide(() =>
                              ignoreStatementLine({
                                statementLineId: row.lineId,
                                reason: 'Needs no voucher',
                              }),
                            )
                          }
                        >
                          Needs no voucher
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={ui.hint} style={{ marginTop: 14 }}>
        A match is a suggestion with its reasons, never an automatic posting. Confidence is derived
        from which rules agreed, and never reaches 100: two invoices to the same customer for the
        same amount in the same week are indistinguishable to any rule.
      </p>
    </>
  );
}

function Status({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <span className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
      {message.text}
    </span>
  );
}
