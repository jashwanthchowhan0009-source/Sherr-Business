import { PageHeader } from '@/components/shell/PageHeader';
import { Band, EmptyState, Panel, StatusPill, Table, ui } from '@/components/ui';
import { fiscalYearOf } from '@/lib/accounting/fiscal-year';
import { formatRupees, paise } from '@/lib/money';
import { STATE_CODES } from '@/lib/india/gstin';
import { getCompany } from '@/server/queries';
import { getDayBook, getRegister, getTrialBalance } from '@/server/reports';
import { getBankAccounts, getReconciliation } from '@/server/banking-queries';
import { getThreeWayMatches } from '@/server/procurement-queries';
import { EXCEPTION_LABELS } from '@/lib/banking/three-way-match';
import { withContext } from '../_guard';

export const dynamic = 'force-dynamic';

/**
 * The reports.
 *
 * Every figure is a query over posted ledger entries. Nothing is cached and no
 * report recomputes tax, so a number here is what the books say and traces back
 * to the voucher that produced it.
 *
 * Reversed vouchers are shown rather than filtered out: a reversal posts its own
 * opposite entries, so both appear and net to nothing. Hiding them would make a
 * report disagree with the ledger it is drawn from, which is the opposite of
 * what an audit trail is for.
 */
export default async function OutputPage() {
  return withContext(async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const { org } = await getCompany(ctx);
    const fy = fiscalYearOf(today, org?.fyStartMonth ?? 4);

    const [trialBalance, dayBook, sales, purchases, banks] = await Promise.all([
      getTrialBalance(ctx, today),
      getDayBook(ctx, { from: fy.startDate, to: today, limit: 40 }),
      getRegister(ctx, { kind: 'sales', from: fy.startDate, to: today }),
      getRegister(ctx, { kind: 'purchase', from: fy.startDate, to: today }),
      getBankAccounts(ctx),
    ]);

    const threeWay = await getThreeWayMatches(ctx, 20);

    const reconciliations = await Promise.all(
      banks.map(async (bank) => ({
        bank,
        rec: await getReconciliation(ctx, { bankAccountId: bank.id, asOf: today }),
      })),
    );

    const balanced = trialBalance.differencePaise === 0n;
    const moved = trialBalance.rows.filter(
      (r) => r.debitPaise !== 0n || r.creditPaise !== 0n,
    );

    return (
      <>
        <PageHeader
          title="Output"
          subtitle={`Reports for ${fy.longLabel}, as at ${today}. Every figure traces to a voucher.`}
        />

        <Band>Trial balance</Band>
        <Panel
          title={`As at ${today}`}
          note={
            balanced
              ? 'Debits equal credits.'
              : `Out by ${formatRupees(paise(trialBalance.differencePaise))} — investigate before relying on anything below.`
          }
          bodyless={moved.length > 0}
        >
          {moved.length === 0 ? (
            <EmptyState title="Nothing posted yet">
              The trial balance fills as vouchers are posted. An empty one is correct for a
              company that has not started trading.
            </EmptyState>
          ) : (
            <Table
              head={
                <tr>
                  <th>Account</th>
                  <th>Group</th>
                  <th className={ui.right}>Debit</th>
                  <th className={ui.right}>Credit</th>
                  <th className={ui.right}>Balance</th>
                </tr>
              }
            >
              {moved.map((row) => (
                <tr key={row.accountId}>
                  <td>
                    {row.name}
                    <div className={ui.hint} style={{ fontFamily: 'ui-monospace, monospace' }}>
                      {row.code}
                    </div>
                  </td>
                  <td className={ui.hint}>{row.groupName}</td>
                  <td className={`${ui.right} tnum`}>
                    {row.debitPaise === 0n ? '—' : formatRupees(paise(row.debitPaise))}
                  </td>
                  <td className={`${ui.right} tnum`}>
                    {row.creditPaise === 0n ? '—' : formatRupees(paise(row.creditPaise))}
                  </td>
                  <td className={`${ui.right} tnum`}>
                    {formatRupees(paise(row.netPaise < 0n ? -row.netPaise : row.netPaise))}
                    <span className={ui.hint}> {row.netPaise < 0n ? 'Cr' : 'Dr'}</span>
                  </td>
                </tr>
              ))}
              <tr>
                <td className={ui.hint}>Total</td>
                <td />
                <td className={`${ui.right} tnum`}>
                  {formatRupees(paise(trialBalance.totalDebitPaise))}
                </td>
                <td className={`${ui.right} tnum`}>
                  {formatRupees(paise(trialBalance.totalCreditPaise))}
                </td>
                <td className={`${ui.right}`}>
                  <StatusPill status={balanced ? 'verified' : 'draft'}>
                    {balanced ? 'Balanced' : 'Out'}
                  </StatusPill>
                </td>
              </tr>
            </Table>
          )}
        </Panel>

        <Band>Sales register</Band>
        <RegisterPanel register={sales} />

        <Band>Purchase register</Band>
        <RegisterPanel register={purchases} />

        <Band>Bank reconciliation</Band>
        {reconciliations.length === 0 ? (
          <Panel>
            <EmptyState title="No bank account set up">
              Add a bank account on Process and import a statement, and the reconciliation appears
              here.
            </EmptyState>
          </Panel>
        ) : (
          reconciliations.map(({ bank, rec }) => (
            <div key={bank.id} style={{ marginBottom: 20 }}>
              <Panel
                title={`${bank.bankName} — ${bank.accountLabel}`}
                note={
                  rec.differencePaise === null
                    ? 'No statement balance to reconcile against yet.'
                    : rec.differencePaise === 0n
                      ? 'Reconciles exactly.'
                      : `Out by ${formatRupees(paise(rec.differencePaise))} — the difference is not explained by the lists below.`
                }
              >
                {/* The classic BRS: start from the books, add what the bank knows
                    and we do not, subtract what we know and the bank does not.
                    The difference is shown rather than hidden, because an
                    unexplained difference is the whole reason to run this. */}
                <table className={ui.table}>
                  <tbody>
                    <tr>
                      <td>Balance as per the books</td>
                      <td className={`${ui.right} tnum`}>
                        {formatRupees(paise(rec.bookBalancePaise))}
                      </td>
                    </tr>
                    <tr>
                      <td>
                        On the statement, not in the books
                        <div className={ui.hint}>
                          {rec.unreconciledStatementLines.length}{' '}
                          {rec.unreconciledStatementLines.length === 1 ? 'line' : 'lines'}
                        </div>
                      </td>
                      <td className={`${ui.right} tnum`}>
                        {formatRupees(paise(rec.unreconciledStatementTotalPaise))}
                      </td>
                    </tr>
                    <tr>
                      <td>
                        In the books, not yet on the statement
                        <div className={ui.hint}>
                          {rec.unpresentedVouchers.length}{' '}
                          {rec.unpresentedVouchers.length === 1 ? 'voucher' : 'vouchers'}
                        </div>
                      </td>
                      <td className={`${ui.right} tnum`}>
                        {formatRupees(paise(-rec.unpresentedTotalPaise))}
                      </td>
                    </tr>
                    <tr>
                      <td><b>Reconciled balance</b></td>
                      <td className={`${ui.right} tnum`}>
                        <b>{formatRupees(paise(rec.reconciledBalancePaise))}</b>
                      </td>
                    </tr>
                    <tr>
                      <td>Balance as per the statement</td>
                      <td className={`${ui.right} tnum`}>
                        {rec.statementBalancePaise === null
                          ? '—'
                          : formatRupees(paise(rec.statementBalancePaise))}
                      </td>
                    </tr>
                    <tr>
                      <td>Difference</td>
                      <td className={ui.right}>
                        {rec.differencePaise === null ? (
                          <span className={ui.hint}>Not known</span>
                        ) : (
                          <StatusPill status={rec.differencePaise === 0n ? 'verified' : 'draft'}>
                            {formatRupees(paise(rec.differencePaise))}
                          </StatusPill>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>

                {rec.unreconciledStatementLines.length > 0 ? (
                  <>
                    <p className={ui.hint} style={{ marginTop: 16 }}>
                      On the statement, not in the books
                    </p>
                    <table className={ui.table}>
                      <tbody>
                        {rec.unreconciledStatementLines.map((line) => (
                          <tr key={line.lineId}>
                            <td className="tnum">{line.lineDate}</td>
                            <td>
                              {line.narration}
                              {line.status === 'ignored' ? (
                                <div className={ui.hint}>Marked as needing no voucher</div>
                              ) : null}
                            </td>
                            <td className={`${ui.right} tnum`}>
                              {formatRupees(paise(line.amountPaise))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : null}

                {rec.unpresentedVouchers.length > 0 ? (
                  <>
                    <p className={ui.hint} style={{ marginTop: 16 }}>
                      In the books, not yet on the statement
                    </p>
                    <table className={ui.table}>
                      <tbody>
                        {rec.unpresentedVouchers.map((voucher) => (
                          <tr key={voucher.voucherId}>
                            <td className="tnum">{voucher.voucherDate}</td>
                            <td>{voucher.voucherNo}</td>
                            <td className={`${ui.right} tnum`}>
                              {formatRupees(paise(voucher.amountPaise))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : null}
              </Panel>
            </div>
          ))
        )}

        <Band>Three-way match</Band>
        {threeWay.length === 0 ? (
          <Panel>
            <EmptyState title="No purchase orders">
              Raise a purchase order and record what arrived against it, and this compares the
              order, the delivery and the bill. It is the control that stops a supplier being paid
              for goods nobody ordered or nobody received.
            </EmptyState>
          </Panel>
        ) : (
          <Panel bodyless>
            <Table
              head={
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Received</th>
                  <th>Billed</th>
                  <th>What disagrees</th>
                  <th className={ui.right}>Would overpay</th>
                </tr>
              }
            >
              {threeWay.map((row) => (
                <tr key={row.poId}>
                  <td>
                    {row.poNo}
                    <div className={ui.hint}>{row.poDate}</div>
                  </td>
                  <td>{row.supplierName}</td>
                  <td className={ui.hint}>
                    {row.grnNumbers.length === 0 ? 'Nothing yet' : row.grnNumbers.join(', ')}
                  </td>
                  <td className={ui.hint}>
                    {row.billNumbers.length === 0 ? 'Nothing yet' : row.billNumbers.join(', ')}
                  </td>
                  <td>
                    {row.result.matched ? (
                      <StatusPill status="verified">All three agree</StatusPill>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 16 }}>
                        {row.result.exceptions.map((exception, i) => (
                          <li key={i}>
                            <b>{EXCEPTION_LABELS[exception.kind]}</b>
                            <div className={ui.hint}>{exception.detail}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={ui.right}>
                    {row.overchargePaise === 0n ? (
                      <span className={ui.hint}>—</span>
                    ) : (
                      <>
                        <span className="tnum">{formatRupees(paise(row.overchargePaise))}</span>
                        <div className={ui.hint}>more than was agreed</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
        )}

        <Band>Day book</Band>
        <Panel
          title="Every posted voucher, newest first"
          note={dayBook.length > 0 ? `${dayBook.length} shown` : undefined}
        >
          {dayBook.length === 0 ? (
            <EmptyState title="Nothing posted yet">
              The day book is the complete record of what was entered and when. It fills as
              vouchers are posted.
            </EmptyState>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {dayBook.map((voucher) => (
                <article
                  key={voucher.voucherId}
                  style={{
                    border: '1px solid var(--sb-hairline-soft)',
                    borderRadius: 14,
                    padding: '12px 14px',
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                      marginBottom: 8,
                    }}
                  >
                    <span>
                      <b>{voucher.voucherNo}</b>{' '}
                      <span className={ui.hint}>
                        {voucher.voucherType.replace('_', ' ')} · {voucher.voucherDate}
                        {voucher.partyName ? ` · ${voucher.partyName}` : ''}
                      </span>
                    </span>
                    {voucher.reversed ? (
                      <StatusPill status="draft">Reversed</StatusPill>
                    ) : (
                      <span className={`${ui.right} tnum`}>
                        {formatRupees(paise(voucher.totalPaise))}
                      </span>
                    )}
                  </header>
                  {voucher.narration ? (
                    <p className={ui.hint} style={{ marginTop: 0, marginBottom: 8 }}>
                      {voucher.narration}
                    </p>
                  ) : null}
                  <table className={ui.table}>
                    <tbody>
                      {voucher.lines.map((line, i) => (
                        <tr key={i}>
                          <td>{line.accountName}</td>
                          <td className={`${ui.right} tnum`}>
                            {line.debitPaise === 0n ? '' : formatRupees(paise(line.debitPaise))}
                          </td>
                          <td className={`${ui.right} tnum`}>
                            {line.creditPaise === 0n ? '' : formatRupees(paise(line.creditPaise))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <p className={ui.hint} style={{ marginTop: 24 }}>
          Prepared by SherrByte — review by a qualified professional. These are working reports,
          not a statutory audit opinion, and every GST rate behind them still needs CA
          verification.
        </p>
      </>
    );
  });
}

/**
 * A sales or purchase register.
 *
 * Credit and debit notes appear in line with negative amounts, because the
 * period's turnover is net of them and that is also the figure a GST return
 * reports. Listing them separately would mean adding two tables together to get
 * one true number.
 */
function RegisterPanel({ register }: { register: Awaited<ReturnType<typeof getRegister>> }) {
  if (register.rows.length === 0) {
    return (
      <Panel>
        <EmptyState title={`No ${register.kind === 'sales' ? 'sales' : 'purchases'} recorded`}>
          {register.kind === 'sales'
            ? 'Raise an invoice on Process and it will appear here with its tax treatment.'
            : 'Enter a bill on Process and it will appear here with its input tax.'}
        </EmptyState>
      </Panel>
    );
  }

  const isSales = register.kind === 'sales';

  return (
    <Panel bodyless>
      <Table
        head={
          <tr>
            <th>Voucher</th>
            <th>Date</th>
            <th>{isSales ? 'Customer' : 'Supplier'}</th>
            <th>GSTIN</th>
            <th>Place of supply</th>
            <th className={ui.right}>Taxable</th>
            <th className={ui.right}>CGST</th>
            <th className={ui.right}>SGST</th>
            <th className={ui.right}>IGST</th>
            <th className={ui.right}>Total</th>
          </tr>
        }
      >
        {register.rows.map((row) => (
          <tr key={row.voucherId}>
            <td>
              {isSales ? (
                <a href={`/api/invoices/${row.voucherId}/pdf`}>{row.voucherNo}</a>
              ) : (
                row.voucherNo
              )}
              {row.supplierInvoiceNo ? (
                <div className={ui.hint}>Their ref {row.supplierInvoiceNo}</div>
              ) : null}
              {row.reversed ? <div className={ui.hint}>Reversed</div> : null}
            </td>
            <td className="tnum">{row.voucherDate}</td>
            <td>{row.partyName ?? '—'}</td>
            <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
              {row.partyGstin ?? <span className={ui.hint}>Unregistered</span>}
            </td>
            <td className={ui.hint}>
              {row.placeOfSupplyStateCode
                ? STATE_CODES[row.placeOfSupplyStateCode] ?? row.placeOfSupplyStateCode
                : '—'}
            </td>
            <td className={`${ui.right} tnum`}>{formatRupees(paise(row.taxablePaise))}</td>
            <td className={`${ui.right} tnum`}>
              {row.cgstPaise === 0n ? '—' : formatRupees(paise(row.cgstPaise))}
            </td>
            <td className={`${ui.right} tnum`}>
              {row.sgstPaise === 0n ? '—' : formatRupees(paise(row.sgstPaise))}
            </td>
            <td className={`${ui.right} tnum`}>
              {row.igstPaise === 0n ? '—' : formatRupees(paise(row.igstPaise))}
            </td>
            <td className={`${ui.right} tnum`}>{formatRupees(paise(row.totalPaise))}</td>
          </tr>
        ))}
        <tr>
          <td className={ui.hint}>Total</td>
          <td colSpan={4} />
          <td className={`${ui.right} tnum`}>{formatRupees(paise(register.taxablePaise))}</td>
          <td className={`${ui.right} tnum`}>{formatRupees(paise(register.cgstPaise))}</td>
          <td className={`${ui.right} tnum`}>{formatRupees(paise(register.sgstPaise))}</td>
          <td className={`${ui.right} tnum`}>{formatRupees(paise(register.igstPaise))}</td>
          <td className={`${ui.right} tnum`}>{formatRupees(paise(register.totalPaise))}</td>
        </tr>
      </Table>
    </Panel>
  );
}
