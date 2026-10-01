'use client';

import { useEffect, useState } from 'react';
import { StatusPill, ui, type MetricStatus } from '@/components/ui';
import { formatCompact, formatRupees, paise } from '@/lib/money';

export interface TraceRow {
  voucherId: string;
  voucherNo: string;
  voucherType: string;
  voucherDate: string;
  partyName: string | null;
  amountPaise: string;
  hasDocument: boolean;
}

export interface Metric {
  key: string;
  label: string;
  valuePaise: string;
  caption: string;
  status: MetricStatus;
  statusReason: string;
  trace: TraceRow[];
}

/**
 * The dashboard cards, and the drawer that opens behind them.
 *
 * Clicking a card shows the vouchers the figure is made of. That is the whole
 * claim of this product — a number you can follow back to the document it came
 * from — so the drawer is not a convenience, it is the feature. A figure with no
 * trace says so plainly rather than opening an empty panel.
 *
 * Amounts arrive as strings because a bigint cannot cross the server/client
 * boundary, and are parsed back before any arithmetic or formatting.
 */
export function MetricCards({ metrics }: { metrics: Metric[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = metrics.find((m) => m.key === openKey) ?? null;

  // Escape closes the drawer: a panel that covers the page and traps the reader
  // is worse than no panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenKey(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <div className={ui.cards}>
        {metrics.map((metric) => {
          const value = paise(BigInt(metric.valuePaise));
          const traceable = metric.trace.length > 0;
          return (
            <button
              key={metric.key}
              type="button"
              className={`${ui.card} ${ui.cardButton}`}
              onClick={() => setOpenKey(metric.key)}
              aria-label={`${metric.label}: ${formatRupees(value)}. ${
                traceable
                  ? `Show the ${metric.trace.length} vouchers behind it.`
                  : 'Show how this is worked out.'
              }`}
            >
              <div className={ui.cardHead}>
                <StatusPill status={metric.status}>{metric.status}</StatusPill>
              </div>
              <div className={ui.cardBody}>
                <div className={ui.cardLabel}>{metric.label}</div>
                <div className={ui.cardValue}>{formatCompact(value)}</div>
                <div className={ui.cardCaption}>{metric.caption}</div>
              </div>
            </button>
          );
        })}
      </div>

      {open ? (
        <>
          {/* Clickable for the mouse, but hidden from assistive technology:
              announcing a second "Close" alongside the real button gives a
              screen-reader user two identical controls and no way to tell them
              apart. Escape and the Close button are the accessible paths. */}
          <button
            type="button"
            className={ui.drawerBackdrop}
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpenKey(null)}
          />
          <aside className={ui.drawer} aria-label={`${open.label} — where this comes from`}>
            <header className={ui.drawerHead}>
              <div>
                <div className={ui.drawerTitle}>{open.label}</div>
                <div className={`${ui.drawerValue} tnum`}>
                  {formatRupees(paise(BigInt(open.valuePaise)))}
                </div>
                <div style={{ marginTop: 8 }}>
                  <StatusPill status={open.status}>{open.status}</StatusPill>
                </div>
              </div>
              <button type="button" className={ui.drawerClose} onClick={() => setOpenKey(null)}>
                Close
              </button>
            </header>

            <div className={ui.drawerBody}>
              <p className={ui.hint}>{open.statusReason}</p>

              {open.trace.length === 0 ? (
                <p className={ui.hint} style={{ marginTop: 16 }}>
                  This figure is a balance drawn from the ledger rather than a list of
                  documents. Open the account in Output to see every entry behind it.
                </p>
              ) : (
                <>
                  <p className={ui.hint} style={{ marginTop: 16 }}>
                    {open.trace.length} {open.trace.length === 1 ? 'voucher' : 'vouchers'} make
                    up this figure.
                  </p>
                  <div className={ui.tableWrap} style={{ marginTop: 10 }}>
                    <table className={ui.table}>
                      <thead>
                        <tr>
                          <th>Voucher</th>
                          <th>Date</th>
                          <th>Party</th>
                          <th className={ui.right}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {open.trace.map((row) => (
                          <tr key={row.voucherId}>
                            <td>
                              {row.voucherType === 'sales' ? (
                                <a href={`/api/invoices/${row.voucherId}/pdf`}>{row.voucherNo}</a>
                              ) : (
                                row.voucherNo
                              )}
                              {row.hasDocument ? (
                                <div className={ui.hint}>Source document attached</div>
                              ) : null}
                            </td>
                            <td className="tnum">{row.voucherDate}</td>
                            <td>{row.partyName ?? '—'}</td>
                            <td className={`${ui.right} tnum`}>
                              {formatRupees(paise(BigInt(row.amountPaise)))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <p className={ui.hint} style={{ marginTop: 20 }}>
                Prepared by SherrByte — review by a qualified professional.
              </p>
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}
