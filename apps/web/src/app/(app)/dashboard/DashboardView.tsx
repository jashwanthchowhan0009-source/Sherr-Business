import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader, TrustRibbon } from '@/components/shell/PageHeader';
import { Panel, StatusPill, Table, ui } from '@/components/ui';
import { Sparkline } from '@/components/charts/Sparkline';
import { AlertIcon, CheckIcon, ClockIcon } from '@/components/shell/icons';
import { can } from '@/lib/auth/permissions';
import { fiscalYearOf } from '@/lib/accounting/fiscal-year';
import { AGEING_BUCKETS, AGEING_BUCKET_LABELS } from '@/lib/accounting/ageing';
import { formatCompact, formatRupees, paise } from '@/lib/money';
import {
  attentionItems, cashOutlook, cashSpark, expenseAnomaly, insights, monthlySpark, percentChange,
  sharePercent, summariseDue, toDayPoints, topParties, type DueSummary,
} from '@/lib/dashboard/model';
import { getAuditLog, getCompany, getMembers } from '@/server/queries';
import { getDashboard, type Ageing } from '@/server/reports';
import { getControlCentreData } from '@/server/dashboard';
import type { RequestContext } from '@/lib/auth/context';
import { MetricCards, type Metric } from './MetricCards';
import { PerformanceChart } from './PerformanceChart';
import { CashOutlookChart } from './CashOutlookChart';
import styles from './dashboard.module.css';

const compact = (p: bigint) => formatCompact(paise(p));

/** Today in India, as a civil date — the books are kept in IST. */
function todayInIndia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/**
 * The owner dashboard: how the business is doing, where the money is, and what
 * needs a decision.
 *
 * Every figure is drawn from posted entries or open documents, carries a status,
 * and — for the headline figures — opens to the vouchers behind it. Nothing is
 * marked verified on the strength of its arithmetic: an open period can still
 * change, so its figures stay provisional however correct they are today.
 */
export async function DashboardView({ ctx }: { ctx: RequestContext }) {
  {
    const today = todayInIndia();

    const [{ org, registrations }, members] = await Promise.all([getCompany(ctx), getMembers(ctx)]);
    const fy = fiscalYearOf(today, org?.fyStartMonth ?? 4);

    const [dashboard, cc, audit] = await Promise.all([
      getDashboard(ctx, { from: fy.startDate, asOf: today }),
      getControlCentreData(ctx, { today, fyStart: fy.startDate }),
      can(ctx.role, 'audit:read') ? getAuditLog(ctx, 8) : Promise.resolve(null),
    ]);

    const { statements, receivable, payable } = dashboard;
    const pl = statements.profitAndLoss;
    const points = toDayPoints(cc.days);
    const metric = (key: string) => dashboard.metrics.find((m) => m.key === key)!;

    const line = (name: string) =>
      [...pl.income, ...pl.expenses].find((s) => s.line === name)?.amountPaise ?? 0n;
    const revenueOps = line('revenue_from_operations');
    const addBack = line('finance_costs') + line('depreciation');
    const ebitda = pl.profitBeforeTaxPaise + addBack;
    const opex =
      pl.totalExpensePaise -
      line('cost_of_materials') -
      line('changes_in_inventories') -
      line('finance_costs') -
      line('depreciation');

    const priorEbitda = cc.prior.incomePaise - cc.prior.expensePaise + cc.prior.addBackPaise;
    const against = 'vs last year';
    const change = (now: bigint, before: bigint, upIsGood: boolean) => {
      const c = percentChange(now, before);
      if (!c) return null;
      return { text: c.text, good: c.tenths === 0 ? null : (c.tenths > 0) === upIsGood, against };
    };

    const receivables = summariseDue(receivable.documents, today);
    const payables = summariseDue(payable.documents, today);
    const cashNow = metric('cash').valuePaise;

    const kpis: Metric[] = [
      {
        ...serialise(metric('revenue')),
        change: change(metric('revenue').valuePaise, cc.prior.revenuePaise, true),
        spark: monthlySpark(points, fy.startDate, today, (b) => b.revenue),
      },
      {
        key: 'expenses',
        label: 'Expenses',
        valuePaise: pl.totalExpensePaise.toString(),
        caption: `All expenses including purchases, ${fy.startDate} to ${today}.`,
        status: metric('revenue').status,
        statusReason: metric('revenue').statusReason,
        trace: [],
        change: change(pl.totalExpensePaise, cc.prior.expensePaise, false),
        spark: monthlySpark(points, fy.startDate, today, (b) => b.expenses),
      },
      {
        key: 'ebitda',
        label: 'EBITDA',
        valuePaise: ebitda.toString(),
        caption: 'Profit before tax with finance costs and depreciation added back.',
        status: metric('profit').status,
        statusReason: metric('profit').statusReason,
        trace: [],
        change: change(ebitda, priorEbitda, true),
        spark: monthlySpark(points, fy.startDate, today, (b) => b.profit),
      },
      {
        ...serialise(metric('cash')),
        label: 'Cash balance',
        change: (() => {
          const c = percentChange(cashNow, statements.cashFlow.openingCashPaise);
          return c
            ? { text: c.text, good: c.tenths === 0 ? null : c.tenths > 0, against: 'this year' }
            : null;
        })(),
        spark: cashSpark(points, cc.cashBeforeSeriesPaise, cc.seriesFrom, fy.startDate, today),
      },
      {
        ...serialise(metric('receivable')),
        label: 'Receivables',
        context:
          receivables.overduePaise > 0n ? `${compact(receivables.overduePaise)} overdue` : 'Nothing overdue',
      },
    ];

    const attention = attentionItems({
      today,
      ledgerOutPaise: dashboard.trialBalanceDifferencePaise,
      receivable: receivables,
      payable: payables,
      gstPayablePaise: metric('gst').valuePaise,
      draftVouchers: dashboard.draftVoucherCount,
      unlinkedDocuments: dashboard.unlinkedDocumentCount,
      unmatchedBankLines: cc.counts.unmatchedBankLines,
      openPurchaseOrders: cc.counts.openPurchaseOrders,
      closingStockMissing: !statements.closingStockEntered,
      hasPurchases: line('cost_of_materials') > 0n,
      membersWithoutMfa: members.filter((m) => !m.mfaEnabled).length,
      formatAmount: compact,
    });

    const outlook = cashOutlook({
      points,
      cashNowPaise: cashNow,
      receivables: receivable.documents,
      payables: payable.documents,
      today,
    });

    const topCustomers = topParties(dashboard.sales.rows);
    const topVendors = topParties(dashboard.purchases.rows);
    const observations = insights({
      today,
      points,
      receivableParties: receivable.parties,
      receivableOverduePaise: receivables.overduePaise,
      outlook,
      expenseMonths: cc.expenseMonths,
      topCustomers,
      revenuePaise: metric('revenue').valuePaise,
      formatAmount: compact,
    });

    const expenseLines = pl.expenses
      .flatMap((s) => s.accounts)
      .filter((a) => a.code !== 'INVENTORY_CHANGE' && a.amountPaise > 0n)
      .sort((a, b) => (b.amountPaise > a.amountPaise ? 1 : -1))
      .slice(0, 5);
    const anomaly = expenseAnomaly(cc.expenseMonths, today);

    const gstin = registrations.find((r) => r.kind === 'gstin')?.number;
    const balanced = dashboard.trialBalanceDifferencePaise === 0n;
    const conversion =
      cc.counts.dealsWon + cc.counts.dealsLost > 0
        ? sharePercent(BigInt(cc.counts.dealsWon), BigInt(cc.counts.dealsWon + cc.counts.dealsLost))
        : null;

    return (
      <>
        <PageHeader
          title="Dashboard"
          subtitle={[org?.legalName ?? 'Company', gstin, `FY ${fy.longLabel}`].filter(Boolean).join(', ')}
        />

        <TrustRibbon
          items={[
            {
              tone: balanced ? 'ok' : 'crit',
              node: balanced ? (
                <>Ledger balances</>
              ) : (
                <><b>Ledger out by {formatRupees(paise(dashboard.trialBalanceDifferencePaise))}</b></>
              ),
            },
            {
              tone: dashboard.postedVoucherCount > 0 ? 'ok' : 'warn',
              node: <><b>{dashboard.postedVoucherCount}</b> posted{dashboard.draftVoucherCount > 0 ? <>, <b>{dashboard.draftVoucherCount}</b> draft</> : null}</>,
            },
            {
              tone: dashboard.lockedUpto ? 'ok' : 'warn',
              node: dashboard.lockedUpto ? <>Books closed to {dashboard.lockedUpto}</> : <>Period open, figures can change</>,
            },
          ]}
        />

        <div className={styles.grid}>
          <section className={`${styles.span12} ${styles.oKpis}`} aria-label="Key figures">
            <MetricCards metrics={kpis} />
          </section>

          <div className={`${styles.span8} ${styles.oPerformance}`}>
            <Panel title="Business performance">
              <PerformanceChart points={points} today={today} />
            </Panel>
          </div>

          <div className={`${styles.span4} ${styles.oAttention}`}>
            <Panel
              title="Needs attention"
              note={attention.length > 0 ? `${attention.length}` : undefined}
              bodyless
            >
              {attention.length === 0 ? (
                <div className={styles.allClear}>
                  <CheckIcon width={20} height={20} />
                  <span>Nothing needs attention</span>
                </div>
              ) : (
                <ul className={styles.attention}>
                  {attention.map((item, i) => (
                    <li key={i} className={styles.attentionItem}>
                      <span className={item.tone === 'crit' ? styles.toneCrit : styles.toneWarn}>
                        <AlertIcon width={16} height={16} />
                      </span>
                      <div className={styles.attentionText}>
                        <div className={styles.attentionTitle}>{item.title}</div>
                        <div className={styles.attentionDetail}>{item.detail}</div>
                      </div>
                      <Link href={item.href} className={styles.attentionAction}>
                        {item.action}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className={`${styles.span6} ${styles.oCash}`}>
            <Panel title="Cash flow" note="Last 6 months and next 3">
              <div className={styles.statRow}>
                <Stat label="Money in (6 mo)" value={compact(sumBig(outlook.filter((m) => !m.forecast).map((m) => m.inPaise)))} />
                <Stat label="Money out (6 mo)" value={compact(sumBig(outlook.filter((m) => !m.forecast).map((m) => m.outPaise)))} />
                <Stat
                  label="Net"
                  value={compact(sumBig(outlook.filter((m) => !m.forecast).map((m) => m.inPaise - m.outPaise)))}
                />
                <Stat
                  label={`Projected, ${outlook[outlook.length - 1]?.label ?? ''}`}
                  value={compact(BigInt(Math.round(outlook[outlook.length - 1]?.balancePaise ?? 0)))}
                  tone={(outlook[outlook.length - 1]?.balancePaise ?? 0) < 0 ? 'bad' : undefined}
                />
              </div>
              <CashOutlookChart months={outlook} />
            </Panel>
          </div>

          <div className={`${styles.span6} ${styles.oProfit}`}>
            <Panel
              title="Profitability"
              note={`FY ${fy.longLabel} to date`}
              action={<StatusPill status={metric('profit').status}>{metric('profit').status}</StatusPill>}
            >
              <ProfitBars
                revenue={revenueOps}
                rows={[
                  { label: 'Revenue', value: revenueOps },
                  { label: 'Gross profit', value: pl.grossProfitPaise },
                  { label: 'Operating expenses', value: opex, cost: true },
                  { label: 'EBITDA', value: ebitda },
                  { label: 'Net profit (before tax)', value: pl.profitBeforeTaxPaise },
                ]}
              />
              {!statements.closingStockEntered && line('cost_of_materials') > 0n ? (
                <p className={ui.hint} style={{ marginTop: 12 }}>
                  Closing stock not entered: profit is understated.{' '}
                  <Link href="/output#closing">Enter it</Link>
                </p>
              ) : null}
            </Panel>
          </div>

          <div className={`${styles.span6} ${styles.oReceivables}`} id="receivables">
            <DuePanel
              title="Receivables"
              summary={receivables}
              docHref={(id) => `/api/invoices/${id}/pdf`}
              moreHref="/output#sales-register"
              emptyText="No customer owes anything."
            />
          </div>

          <div className={`${styles.span6} ${styles.oPayables}`} id="payables">
            <DuePanel
              title="Payables"
              summary={payables}
              moreHref="/output#purchase-register"
              emptyText="Nothing owed to suppliers."
            />
          </div>

          <div className={`${audit ? styles.span8 : styles.span12} ${styles.oIntel}`} id="intelligence">
            <Panel title="SherrByte Intelligence" note="Computed from your ledger" bodyless>
              {observations.length === 0 ? (
                <p className={styles.quiet}>
                  Observations appear once there are two full months of entries.
                </p>
              ) : (
                <ul className={styles.insights}>
                  {observations.map((o, i) => (
                    <li key={i} className={styles.insight}>
                      <div className={styles.insightTitle}>{o.title}</div>
                      <div className={styles.insightWhy}>{o.why}</div>
                      {o.action ? (
                        <Link href={o.action.href} className={styles.insightAction}>
                          {o.action.label}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {audit ? (
            <div className={`${styles.span4} ${styles.oActivity}`}>
              <Panel title="Recent activity" bodyless action={<Link className={styles.panelLink} href="/data">All</Link>}>
                {audit.length === 0 ? (
                  <p className={styles.quiet}>Nothing recorded yet.</p>
                ) : (
                  <ul className={styles.activity}>
                    {audit.map((a) => (
                      <li key={a.id.toString()} className={styles.activityItem}>
                        <ClockIcon width={15} height={15} className={styles.activityIcon} />
                        <div>
                          <div className={styles.activityTitle}>
                            {actionLabel(a.action)}
                            {detailOf(a.after) ? <span className={styles.activityDetail}> {detailOf(a.after)}</span> : null}
                          </div>
                          <div className={styles.activityMeta}>
                            {timeAgo(a.at)}
                            {a.actorEmail ? `, ${a.actorEmail}` : ''}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          ) : null}

          <div className={`${styles.span6} ${styles.oSales}`}>
            <Panel title="Sales" note={`FY ${fy.longLabel}`}>
              <div className={styles.statRow}>
                <Stat label="Total sales" value={compact(metric('revenue').valuePaise)} />
                <Stat label="Invoices" value={cc.counts.invoices.toLocaleString('en-IN')} />
                <Stat label="New customers" value={cc.counts.newCustomers.toLocaleString('en-IN')} />
                {conversion !== null ? <Stat label="Deal conversion" value={`${conversion}%`} /> : null}
              </div>
              <div className={styles.split}>
                <Ranked
                  title="Top customers"
                  rows={topCustomers.map((c) => ({ name: c.name, amount: c.amountPaise }))}
                  empty="No sales yet."
                />
                <Ranked
                  title="Top products and services"
                  rows={cc.topProducts.map((p) => ({ name: p.name, amount: p.amountPaise }))}
                  empty="No invoice lines yet."
                />
              </div>
              <div className={styles.trend}>
                <span className={ui.hint}>Monthly sales</span>
                <Sparkline
                  values={monthlySpark(points, fy.startDate, today, (b) => b.revenue)}
                  width={220}
                  height={36}
                  label="Monthly sales this year"
                />
              </div>
            </Panel>
          </div>

          <div className={`${styles.span6} ${styles.oExpenses}`}>
            <Panel title="Expenses" note={`FY ${fy.longLabel}`}>
              <div className={styles.statRow}>
                <Stat label="Total expenses" value={compact(pl.totalExpensePaise)} />
                <Stat label="Operating expenses" value={compact(opex)} />
              </div>
              {anomaly ? (
                <p className={styles.anomaly}>
                  <AlertIcon width={14} height={14} /> {anomaly.name} up {anomaly.change.text.replace('+', '')} in{' '}
                  {anomaly.month} against the month before.
                </p>
              ) : null}
              <div className={styles.split}>
                <Ranked
                  title="Top categories"
                  rows={expenseLines.map((a) => ({ name: a.name, amount: a.amountPaise }))}
                  empty="No expenses yet."
                />
                <Ranked
                  title="Largest vendors"
                  rows={topVendors.map((v) => ({ name: v.name, amount: v.amountPaise }))}
                  empty="No bills yet."
                />
              </div>
              <div className={styles.trend}>
                <span className={ui.hint}>Monthly expenses</span>
                <Sparkline
                  values={monthlySpark(points, fy.startDate, today, (b) => b.expenses)}
                  width={220}
                  height={36}
                  label="Monthly expenses this year"
                />
              </div>
            </Panel>
          </div>

          {cc.counts.goodsItems > 0 ? (
            <div className={`${styles.span12} ${styles.oInventory}`}>
              <Panel title="Inventory" action={<Link className={styles.panelLink} href="/process#items">Products</Link>}>
                <div className={styles.inventory}>
                  <div className={styles.statRow}>
                    <Stat label="Active products" value={cc.counts.goodsItems.toLocaleString('en-IN')} />
                    <Stat label="Slow moving (90 days)" value={cc.counts.slowMovingItems.toLocaleString('en-IN')} />
                    <Stat
                      label="Pending purchase orders"
                      value={`${cc.counts.openPurchaseOrders}`}
                      sub={cc.counts.openPurchaseOrders > 0 ? compact(cc.counts.openPurchaseOrderPaise) : undefined}
                    />
                  </div>
                  <div>
                    <div className={styles.rankedTitle}>Fast moving, last 30 days</div>
                    {cc.fastMovers.length === 0 ? (
                      <p className={ui.hint}>No goods sold in the last 30 days.</p>
                    ) : (
                      <ol className={styles.ranked}>
                        {cc.fastMovers.map((f) => (
                          <li key={f.name}>
                            <span>{f.name}</span>
                            <span className="tnum">
                              {formatQty(f.quantity)} {f.unit ?? ''}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              </Panel>
            </div>
          ) : null}

          <details className={`${styles.span12} ${styles.oAgeing} ${styles.ageing}`}>
            <summary>Ageing by party</summary>
            <div className={styles.ageingBody}>
              <AgeingTable title="Customers" ageing={receivable} />
              <AgeingTable title="Suppliers" ageing={payable} />
            </div>
          </details>
        </div>

        <p className={ui.hint} style={{ marginTop: 24 }}>
          Prepared by SherrByte for review by a qualified professional. Not an audit opinion.
        </p>
      </>
    );
  }
}

// ── pieces ───────────────────────────────────────────────────────────────────

function serialise(m: Awaited<ReturnType<typeof getDashboard>>['metrics'][number]): Metric {
  return {
    key: m.key,
    label: m.label,
    valuePaise: m.valuePaise.toString(),
    caption: m.caption,
    status: m.status,
    statusReason: m.statusReason,
    trace: m.trace.map((t) => ({ ...t, amountPaise: t.amountPaise.toString() })),
  };
}

function sumBig(values: readonly number[]): bigint {
  return values.reduce((s, v) => s + BigInt(Math.round(v)), 0n);
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={`${styles.statValue} ${tone === 'bad' ? styles.statBad : ''} tnum`}>{value}</div>
      {sub ? <div className={styles.statSub}>{sub}</div> : null}
    </div>
  );
}

function ProfitBars({
  revenue,
  rows,
}: {
  revenue: bigint;
  rows: { label: string; value: bigint; cost?: boolean }[];
}) {
  const scale = rows.reduce((m, r) => {
    const a = r.value < 0n ? -r.value : r.value;
    return a > m ? a : m;
  }, 0n);
  return (
    <ul className={styles.profit}>
      {rows.map((r) => {
        const abs = r.value < 0n ? -r.value : r.value;
        const width = scale > 0n ? Number((abs * 1000n) / scale) / 10 : 0;
        const margin = revenue > 0n && !r.cost && r.label !== 'Revenue' ? `${sharePercent(r.value < 0n ? 0n : r.value, revenue)}%` : '';
        return (
          <li key={r.label} className={styles.profitRow}>
            <span className={styles.profitLabel}>{r.label}</span>
            <span className={styles.profitTrack} aria-hidden="true">
              <span
                className={r.value < 0n ? styles.profitBarNeg : r.cost ? styles.profitBarCost : styles.profitBar}
                style={{ width: `${width}%` }}
              />
            </span>
            <span className={`${styles.profitValue} tnum`}>{compact(r.value)}</span>
            <span className={styles.profitMargin}>{r.value < 0n && revenue > 0n ? 'loss' : margin}</span>
          </li>
        );
      })}
    </ul>
  );
}

function DuePanel({
  title,
  summary,
  docHref,
  moreHref,
  emptyText,
}: {
  title: string;
  summary: DueSummary;
  docHref?: (id: string) => string;
  moreHref: string;
  emptyText: string;
}) {
  return (
    <Panel title={title} action={<Link className={styles.panelLink} href={moreHref}>Register</Link>}>
      <div className={styles.statRow}>
        <Stat label="Outstanding" value={compact(summary.totalPaise)} />
        <Stat
          label="Overdue"
          value={compact(summary.overduePaise)}
          tone={summary.overduePaise > 0n ? 'bad' : undefined}
          sub={summary.overdueCount > 0 ? `${summary.overdueCount} documents` : undefined}
        />
        <Stat label="Due this week" value={compact(summary.dueThisWeekPaise)} />
        <Stat label="Due this month" value={compact(summary.dueThisMonthPaise)} />
      </div>
      {summary.totalPaise === 0n ? (
        <p className={ui.hint}>{emptyText}</p>
      ) : summary.overdue.length > 0 ? (
        <ul className={styles.dueList}>
          {summary.overdue.map((d) => (
            <li key={d.voucherId}>
              <span>
                {docHref ? <a href={docHref(d.voucherId)}>{d.voucherNo}</a> : d.voucherNo}
                <span className={styles.dueParty}> {d.partyName}</span>
              </span>
              <span className={styles.dueLate}>{d.daysOverdue}d late</span>
              <span className="tnum">{compact(d.outstandingPaise)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.hint}>Nothing overdue.</p>
      )}
    </Panel>
  );
}

function Ranked({ title, rows, empty }: { title: string; rows: { name: string; amount: bigint }[]; empty: string }) {
  const top = rows[0]?.amount ?? 0n;
  return (
    <div>
      <div className={styles.rankedTitle}>{title}</div>
      {rows.length === 0 ? (
        <p className={ui.hint}>{empty}</p>
      ) : (
        <ol className={styles.ranked}>
          {rows.map((r) => (
            <li key={r.name}>
              <span className={styles.rankedName}>
                {r.name}
                <span className={styles.rankedBar} style={{ width: `${top > 0n ? Number((r.amount * 100n) / top) : 0}%` }} />
              </span>
              <span className="tnum">{compact(r.amount)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AgeingTable({ title, ageing }: { title: string; ageing: Ageing }): ReactNode {
  if (ageing.parties.length === 0) {
    return (
      <div>
        <div className={styles.rankedTitle}>{title}</div>
        <p className={ui.hint}>Nothing outstanding.</p>
      </div>
    );
  }
  return (
    <div>
      <div className={styles.rankedTitle}>{title}</div>
      <Table
        head={
          <tr>
            <th>Party</th>
            {AGEING_BUCKETS.map((b) => (
              <th key={b} className={ui.right}>{AGEING_BUCKET_LABELS[b]}</th>
            ))}
            <th className={ui.right}>Total</th>
          </tr>
        }
      >
        {ageing.parties.map((p) => (
          <tr key={p.partyId}>
            <td>{p.partyName}</td>
            {AGEING_BUCKETS.map((b) => (
              <td key={b} className={`${ui.right} tnum`}>
                {p.byBucket[b] === 0n ? '—' : formatRupees(paise(p.byBucket[b]))}
              </td>
            ))}
            <td className={`${ui.right} tnum`}>{formatRupees(paise(p.totalPaise))}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

/** "voucher.reversed" → "Voucher reversed"; "hr.payroll_run.opened" → "Payroll run opened". */
function actionLabel(action: string): string {
  const parts = action.split('.');
  const words = (parts.length > 2 ? parts.slice(1) : parts).join(' ').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function detailOf(after: unknown): string | null {
  if (!after || typeof after !== 'object') return null;
  const a = after as Record<string, unknown>;
  for (const key of ['voucherNo', 'reversalVoucherNo', 'legalName', 'name', 'title', 'originalFilename', 'email']) {
    const v = a[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function timeAgo(at: Date): string {
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(at));
}

/** Quantities are scaled by 10,000. */
function formatQty(q: bigint): string {
  const whole = q / 10_000n;
  const frac = q % 10_000n;
  return frac === 0n ? whole.toLocaleString('en-IN') : (Number(q) / 10_000).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
