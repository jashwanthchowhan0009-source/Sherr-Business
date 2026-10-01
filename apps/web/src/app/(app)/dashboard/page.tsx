import { PageHeader, TrustRibbon } from '@/components/shell/PageHeader';
import { Band, EmptyState, Panel, StatusPill, Table, ui } from '@/components/ui';
import { ROLE_LABELS } from '@/lib/auth/permissions';
import { fiscalYearOf } from '@/lib/accounting/fiscal-year';
import { AGEING_BUCKETS, AGEING_BUCKET_LABELS } from '@/lib/accounting/ageing';
import { formatRupees, paise } from '@/lib/money';
import { getCompany, getMembers } from '@/server/queries';
import { getAgeing, getDashboard } from '@/server/reports';
import { withContext } from '../_guard';
import { MetricCards } from './MetricCards';

export const dynamic = 'force-dynamic';

/**
 * The owner dashboard.
 *
 * Every figure carries a status and opens to the vouchers behind it. Nothing is
 * marked verified on the strength of its arithmetic: a period that has not been
 * locked can still change, so its figures stay provisional however correct they
 * are today. That is the §2 rule, and it is the difference between a dashboard
 * an owner can act on and one that merely looks confident.
 */
export default async function DashboardPage() {
  return withContext(async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);

    const [{ org, registrations }, members] = await Promise.all([
      getCompany(ctx),
      getMembers(ctx),
    ]);

    const fy = fiscalYearOf(today, org?.fyStartMonth ?? 4);
    const [dashboard, receivable, payable] = await Promise.all([
      getDashboard(ctx, { from: fy.startDate, asOf: today }),
      getAgeing(ctx, { kind: 'receivable', asOf: today }),
      getAgeing(ctx, { kind: 'payable', asOf: today }),
    ]);

    const gstin = registrations.find((r) => r.kind === 'gstin')?.number;
    const withoutMfa = members.filter((m) => !m.mfaEnabled).length;
    const balanced = dashboard.trialBalanceDifferencePaise === 0n;
    const empty = dashboard.postedVoucherCount === 0;

    return (
      <>
        <PageHeader
          title="Owner dashboard"
          subtitle={`${org?.legalName ?? 'Company'}${gstin ? ` · ${gstin}` : ''} · ${
            fy.longLabel
          } · signed in as ${ROLE_LABELS[ctx.role]}`}
        />

        {/* The ribbon states facts rather than reassurance, because an owner
            reads it before acting on anything below it. A ledger that does not
            balance is reported first: it should be impossible, since the
            database rejects an unbalanced voucher, so if it ever shows,
            something reached the data without going through the app. */}
        <TrustRibbon
          items={[
            {
              tone: balanced ? 'ok' : 'crit',
              node: balanced ? (
                <>Ledger balances</>
              ) : (
                <>
                  <b>Ledger is out by {formatRupees(paise(dashboard.trialBalanceDifferencePaise))}</b>
                  {' '}— stop and investigate
                </>
              ),
            },
            {
              tone: dashboard.postedVoucherCount > 0 ? 'ok' : 'warn',
              node: (
                <>
                  <b>{dashboard.postedVoucherCount}</b> posted
                  {dashboard.draftVoucherCount > 0 ? (
                    <>, <b>{dashboard.draftVoucherCount}</b> draft</>
                  ) : null}
                </>
              ),
            },
            {
              tone: dashboard.lockedUpto ? 'ok' : 'warn',
              node: dashboard.lockedUpto ? (
                <>Books closed to {dashboard.lockedUpto}</>
              ) : (
                <>Period open — figures can change</>
              ),
            },
            {
              tone:
                dashboard.documentCount === 0
                  ? 'warn'
                  : dashboard.unlinkedDocumentCount > 0
                    ? 'warn'
                    : 'ok',
              node:
                dashboard.documentCount === 0 ? (
                  <>No documents uploaded</>
                ) : dashboard.unlinkedDocumentCount === 0 ? (
                  <><b>{dashboard.documentCount}</b> documents, all linked</>
                ) : (
                  <>
                    <b>{dashboard.unlinkedDocumentCount}</b> of {dashboard.documentCount} documents
                    not linked to a voucher
                  </>
                ),
            },
            {
              tone: withoutMfa > 0 ? 'crit' : 'ok',
              node:
                withoutMfa > 0 ? (
                  <><b>{withoutMfa}</b> without two-factor</>
                ) : (
                  <>All members have two-factor</>
                ),
            },
          ]}
        />

        {empty ? (
          <Panel>
            <EmptyState title="No vouchers posted yet">
              Raise an invoice or enter a bill on <a href="/process">Process</a> and these cards
              will fill from the ledger. Nothing here is a placeholder: a card shows a figure only
              once there are postings behind it.
            </EmptyState>
          </Panel>
        ) : (
          <>
            <Band>The figures, and where each comes from</Band>
            <MetricCards
              metrics={dashboard.metrics.map((m) => ({
                key: m.key,
                label: m.label,
                valuePaise: m.valuePaise.toString(),
                caption: m.caption,
                status: m.status,
                statusReason: m.statusReason,
                trace: m.trace.map((t) => ({
                  voucherId: t.voucherId,
                  voucherNo: t.voucherNo,
                  voucherType: t.voucherType,
                  voucherDate: t.voucherDate,
                  partyName: t.partyName,
                  amountPaise: t.amountPaise.toString(),
                  hasDocument: t.hasDocument,
                })),
              }))}
            />

            <Band>Who owes you</Band>
            <AgeingPanel ageing={receivable} emptyText="No customer owes anything." />

            <Band>What you owe</Band>
            <AgeingPanel ageing={payable} emptyText="You owe no supplier anything." />
          </>
        )}

        <p className={ui.hint} style={{ marginTop: 24 }}>
          <StatusPill status="provisional">Provisional</StatusPill>{' '}
          Prepared by SherrByte — review by a qualified professional. Figures stay provisional
          until the period is closed, and nothing here is a statutory audit opinion or a
          guarantee of tax compliance.
        </p>
      </>
    );
  });
}

/**
 * One ageing table, oldest debt first.
 *
 * Sorted by who has owed the longest rather than who owes the most, because that
 * is the order the list gets acted on: a small very old balance needs a phone
 * call more than a large one raised last week.
 */
function AgeingPanel({
  ageing,
  emptyText,
}: {
  ageing: Awaited<ReturnType<typeof getAgeing>>;
  emptyText: string;
}) {
  if (ageing.parties.length === 0) {
    return (
      <Panel>
        <EmptyState title="Nothing outstanding">{emptyText}</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel bodyless>
      <Table
        head={
          <tr>
            <th>Party</th>
            {AGEING_BUCKETS.map((bucket) => (
              <th key={bucket} className={ui.right}>{AGEING_BUCKET_LABELS[bucket]}</th>
            ))}
            <th className={ui.right}>Total</th>
          </tr>
        }
      >
        {ageing.parties.map((party) => (
          <tr key={party.partyId}>
            <td>
              {party.partyName}
              {party.oldestDueDate ? (
                <div className={ui.hint}>Oldest due {party.oldestDueDate}</div>
              ) : null}
            </td>
            {AGEING_BUCKETS.map((bucket) => (
              <td key={bucket} className={`${ui.right} tnum`}>
                {party.byBucket[bucket] === 0n ? '—' : formatRupees(paise(party.byBucket[bucket]))}
              </td>
            ))}
            <td className={`${ui.right} tnum`}>{formatRupees(paise(party.totalPaise))}</td>
          </tr>
        ))}
        <tr>
          <td className={ui.hint}>Total</td>
          {AGEING_BUCKETS.map((bucket) => (
            <td key={bucket} className={`${ui.right} tnum`}>
              {ageing.total.byBucket[bucket] === 0n
                ? '—'
                : formatRupees(paise(ageing.total.byBucket[bucket]))}
            </td>
          ))}
          <td className={`${ui.right} tnum`}>{formatRupees(paise(ageing.total.totalPaise))}</td>
        </tr>
      </Table>
    </Panel>
  );
}
