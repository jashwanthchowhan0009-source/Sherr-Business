'use client';

import { useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { enterClosingStock, lockPeriod, unlockPeriod } from '@/server/closing';

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
 * Entering closing stock.
 *
 * The value is typed by a person, not computed. Stock valuation is a judgement —
 * lower of cost and net realisable value, which cost formula, what to do with
 * obsolete lines — and a figure invented here would be the clearest possible case
 * of the app making up a number. The basis is required for the same reason: a
 * valuation nobody can explain is one an auditor will ask about.
 */
export function ClosingStockForm({
  fyEndDate,
  alreadyEntered,
  readOnly,
}: {
  fyEndDate: string;
  alreadyEntered: boolean;
  readOnly: boolean;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<Message>(null);

  if (readOnly) {
    return (
      <p className={ui.hint}>
        Your role can read the statements but not enter closing stock.
      </p>
    );
  }

  if (alreadyEntered) {
    return (
      <p className={ui.hint}>
        Closing stock has been entered for this year. To change it, reverse that entry on Process
        and enter a new one — a second entry would double-count the stock.
      </p>
    );
  }

  return (
    <form
      action={(formData: FormData) => {
        setMessage(null);
        start(async () => {
          const result = await enterClosingStock({
            asOfDate: String(formData.get('asOfDate') ?? fyEndDate),
            valueRupees: String(formData.get('valueRupees') ?? ''),
            basis: String(formData.get('basis') ?? ''),
          });
          setMessage(
            result.ok
              ? { tone: 'ok', text: `${result.data.voucherNo} posted. Gross profit is now meaningful.` }
              : { tone: 'err', text: result.error },
          );
        });
      }}
    >
      <p className={ui.hint} style={{ marginTop: 0 }}>
        Purchases are expensed as they are made, so a trading company shows a loss until the stock
        it still holds is recognised. Until this is entered, gross profit is wrong by the value of
        the warehouse.
      </p>

      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="cs-date">As at</label>
          <input className={ui.input} id="cs-date" name="asOfDate" type="date" defaultValue={fyEndDate} required />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="cs-value">Value (₹)</label>
          <input className={ui.input} id="cs-value" name="valueRupees" inputMode="decimal" required />
        </div>
        <div className={ui.field} style={{ gridColumn: '1 / -1' }}>
          <label className={ui.label} htmlFor="cs-basis">How it was valued</label>
          <input
            className={ui.input}
            id="cs-basis"
            name="basis"
            required
            maxLength={300}
            aria-describedby="cs-basis-hint"
          />
          <p className={ui.hint} id="cs-basis-hint">
            Required. A valuation nobody can explain is one an auditor will ask about.
          </p>
        </div>
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Posting…' : 'Enter closing stock'}
        </button>
        <Status message={message} />
      </div>
    </form>
  );
}

/**
 * Closing and reopening a period.
 *
 * Locking is what turns a provisional figure into a settled one: nothing dated on
 * or before the lock can be posted afterwards. Unlocking is deliberately
 * awkward — it changes figures that have been reported, so it needs a full
 * explanation and leaves a record of who did it.
 */
export function PeriodLockForm({
  lockedUpto,
  suggestedDate,
  mayLock,
  mayUnlock,
}: {
  lockedUpto: string | null;
  suggestedDate: string;
  mayLock: boolean;
  mayUnlock: boolean;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<Message>(null);
  const [unlocking, setUnlocking] = useState(false);

  if (!mayLock && !mayUnlock) {
    return (
      <p className={ui.hint}>
        Closing the books is the owner&rsquo;s decision. Your role maintains them but does not
        settle them.
      </p>
    );
  }

  return (
    <>
      <p className={ui.hint} style={{ marginTop: 0 }}>
        {lockedUpto ? (
          <>
            The books are closed to <b>{lockedUpto}</b>. Nothing dated on or before that can be
            posted, which is what lets these figures stop being called provisional.
          </>
        ) : (
          <>
            The books are open. Every figure here can still change, so the dashboard reports them
            as provisional however correct they are today.
          </>
        )}
      </p>

      {mayLock ? (
        <form
          action={(formData: FormData) => {
            setMessage(null);
            start(async () => {
              const result = await lockPeriod({
                lockedUpto: String(formData.get('lockedUpto') ?? suggestedDate),
                reason: String(formData.get('reason') ?? ''),
              });
              setMessage(
                result.ok
                  ? { tone: 'ok', text: `Closed to ${result.data.lockedUpto}.` }
                  : { tone: 'err', text: result.error },
              );
            });
          }}
        >
          <div className={ui.formGrid}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="pl-date">Close the books to</label>
              <input
                className={ui.input}
                id="pl-date"
                name="lockedUpto"
                type="date"
                defaultValue={suggestedDate}
                {...(lockedUpto ? { min: lockedUpto } : {})}
                required
              />
            </div>
            <div className={ui.field} style={{ gridColumn: '2 / -1' }}>
              <label className={ui.label} htmlFor="pl-reason">Why</label>
              <input
                className={ui.input}
                id="pl-reason"
                name="reason"
                required
                maxLength={300}
              />
            </div>
          </div>
          <div className={ui.actions}>
            <button className={ui.button} type="submit" disabled={pending}>
              {pending ? 'Closing…' : lockedUpto ? 'Move the lock forward' : 'Close the books'}
            </button>
            <Status message={message} />
          </div>
          <p className={ui.hint} style={{ marginTop: 10 }}>
            A draft dated inside the period being closed would never be postable, so closing is
            refused while any remain. Post or delete them first.
          </p>
        </form>
      ) : null}

      {lockedUpto && mayUnlock ? (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--sb-hairline)', paddingTop: 14 }}>
          {!unlocking ? (
            <button type="button" className={ui.buttonGhost} onClick={() => setUnlocking(true)}>
              Reopen the books
            </button>
          ) : (
            <form
              action={(formData: FormData) => {
                setMessage(null);
                start(async () => {
                  const result = await unlockPeriod({
                    reason: String(formData.get('reason') ?? ''),
                  });
                  setMessage(
                    result.ok
                      ? { tone: 'ok', text: `Reopened from ${result.data.reopenedFrom}.` }
                      : { tone: 'err', text: result.error },
                  );
                  if (result.ok) setUnlocking(false);
                });
              }}
            >
              <div className={ui.field}>
                <label className={ui.label} htmlFor="pu-reason">
                  Why the books are being reopened
                </label>
                <input
                  className={ui.input}
                  id="pu-reason"
                  name="reason"
                  required
                  minLength={10}
                  maxLength={500}
                />
              </div>
              <div className={ui.actions}>
                <button className={ui.button} type="submit" disabled={pending}>
                  {pending ? 'Reopening…' : 'Confirm reopening'}
                </button>
                <button type="button" className={ui.buttonGhost} onClick={() => setUnlocking(false)}>
                  Cancel
                </button>
                <Status message={message} />
              </div>
              <p className={ui.hint} style={{ marginTop: 10 }}>
                This is recorded against your name in the audit history, with the reason you give.
              </p>
            </form>
          )}
        </div>
      ) : null}
    </>
  );
}
