import { PageHeader, TrustRibbon } from '@/components/shell/PageHeader';
import { Band, Cards, DataCard, EmptyState, Panel, StatusPill } from '@/components/ui';
import { ROLE_LABELS } from '@/lib/auth/permissions';
import { getCompany, getMembers } from '@/server/queries';
import { withContext } from '../_guard';

export const dynamic = 'force-dynamic';

/**
 * The owner dashboard shell, in the four bands of docs/03-OWNER-DASHBOARD-SPEC.md.
 *
 * Phase 1 has no ledger, so the money bands report that honestly rather than
 * showing placeholder rupee figures. A dashboard that looks populated before the
 * numbers are real is precisely the failure mode this product exists to avoid.
 */
export default async function DashboardPage() {
  return withContext(async (ctx) => {
    const [{ org, registrations }, members] = await Promise.all([
      getCompany(ctx),
      getMembers(ctx),
    ]);

    const gstin = registrations.find((r) => r.kind === 'gstin')?.number;
    const withoutMfa = members.filter((m) => !m.mfaEnabled).length;

    return (
      <>
        <PageHeader
          title="Owner dashboard"
          subtitle={`${org?.legalName ?? 'Company'}${gstin ? ` · ${gstin}` : ''} · signed in as ${ROLE_LABELS[ctx.role]}`}
        />

        <TrustRibbon
          items={[
            { tone: 'warn', node: <>No accounting data yet</> },
            { tone: 'ok', node: <><b>{members.length}</b> {members.length === 1 ? 'member' : 'members'}</> },
            {
              tone: withoutMfa > 0 ? 'crit' : 'ok',
              node: withoutMfa > 0
                ? <><b>{withoutMfa}</b> without two-factor</>
                : <>All members have two-factor</>,
            },
          ]}
        />

        <Band>Money now</Band>
        <Cards>
          <DataCard
            label="Available cash"
            value="—"
            caption="Connect a bank source"
            status="draft"
          />
          <DataCard label="Net cash flow" value="—" caption="This month" status="draft" />
        </Cards>

        <Band>Who owes · what&apos;s owed</Band>
        <Cards>
          <DataCard label="Customer dues" value="—" caption="No invoices yet" status="draft" />
          <DataCard label="Payments due" value="—" caption="No bills yet" status="draft" />
        </Cards>

        <Band>Needs attention</Band>
        <Panel>
          <EmptyState title="Nothing needs you">
            Exceptions appear here once documents are being reconciled. Until then the only setup
            left is on{' '}
            <a href="/data">Data</a> and <a href="/people">People</a>.
          </EmptyState>
        </Panel>

        <p style={{ color: 'var(--sb-text-3)', fontSize: 13, marginTop: 24 }}>
          <StatusPill status="draft">Phase 1</StatusPill>{' '}
          Cards show an em dash rather than a figure because no ledger exists yet. Every value here
          will carry its source, as-of time and a link to the underlying transactions.
        </p>
      </>
    );
  });
}
