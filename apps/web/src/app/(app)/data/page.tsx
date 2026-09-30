import { PageHeader } from '@/components/shell/PageHeader';
import { EmptyState, Panel, Table, ui } from '@/components/ui';
import { can, ROLE_LABELS } from '@/lib/auth/permissions';
import { getAuditLog, getCompany } from '@/server/queries';
import { withContext } from '../_guard';
import { CompanyForm } from './CompanyForm';

export const dynamic = 'force-dynamic';

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

const KIND_LABELS: Record<string, string> = {
  gstin: 'GSTIN', tan: 'TAN', iec: 'IEC', msme: 'MSME', cin: 'CIN',
};

export default async function DataPage() {
  return withContext(async (ctx) => {
    const { org, registrations } = await getCompany(ctx);
    const mayReadAudit = can(ctx.role, 'audit:read');
    const audit = mayReadAudit ? await getAuditLog(ctx, 25) : [];

    return (
      <>
        <PageHeader
          title="Data"
          subtitle="Company profile, registrations and the audit history."
        />

        <Panel title="Company profile">
          <CompanyForm
            readOnly={!can(ctx.role, 'company:update')}
            initial={{
              legalName: org?.legalName ?? '',
              tradeName: org?.tradeName ?? '',
              pan: org?.pan ?? '',
              stateCode: org?.stateCode ?? '',
              fyStartMonth: org?.fyStartMonth ?? 4,
            }}
          />
        </Panel>

        <div style={{ marginTop: 24 }}>
          <Panel
            title="Registrations"
            note={`${registrations.length} on file`}
            bodyless={registrations.length > 0}
          >
            {registrations.length === 0 ? (
              <EmptyState title="No registrations recorded">
                Add your GSTIN and TAN so taxation workings can be prepared against the right
                registration. Multi-state companies record one GSTIN per state.
              </EmptyState>
            ) : (
              <Table head={<tr><th>Type</th><th>Number</th><th>State</th></tr>}>
                {registrations.map((r) => (
                  <tr key={r.id}>
                    <td>{KIND_LABELS[r.kind] ?? r.kind}</td>
                    <td className="tnum" style={{ fontFamily: 'ui-monospace, monospace' }}>
                      {r.number}
                    </td>
                    <td className="tnum">{r.stateCode ?? '—'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>

        <div style={{ marginTop: 24 }}>
          <Panel
            title="Audit history"
            note={mayReadAudit ? 'Append-only. Newest first.' : undefined}
            bodyless={mayReadAudit && audit.length > 0}
          >
            {!mayReadAudit ? (
              <EmptyState title="Not available to your role">
                The audit history is readable by owners and CA reviewers. You are signed in as{' '}
                {ROLE_LABELS[ctx.role]}.
              </EmptyState>
            ) : audit.length === 0 ? (
              <EmptyState title="Nothing recorded yet">
                Every change writes a row here in the same transaction as the change itself, so
                this cannot fall out of step with the data.
              </EmptyState>
            ) : (
              <Table head={<tr><th>When</th><th>Who</th><th>Action</th><th>Subject</th></tr>}>
                {audit.map((row) => (
                  <tr key={String(row.id)}>
                    <td className="tnum">{dateTimeFmt.format(row.at)}</td>
                    <td>
                      {row.actorEmail ?? 'System'}
                      {row.actorRole ? (
                        <div style={{ color: 'var(--sb-text-3)', fontSize: 12.5 }}>
                          {ROLE_LABELS[row.actorRole as keyof typeof ROLE_LABELS] ?? row.actorRole}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
                      {row.action}
                    </td>
                    <td className={ui.hint}>{row.subjectKind}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>
      </>
    );
  });
}
