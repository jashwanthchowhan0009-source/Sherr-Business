import { PageHeader } from '@/components/shell/PageHeader';
import { Band, Cards, DataCard, EmptyState, Panel, Table, ui } from '@/components/ui';
import { can, ROLE_LABELS } from '@/lib/auth/permissions';
import { getAuditLog, getCompany, getMembers } from '@/server/queries';
import { getAccounts, getDataCounts, getDocuments } from '@/server/ledger-queries';
import { STANDARD_ACCOUNT_CODES } from '@/lib/accounting/chart-of-accounts';
import { withContext } from '../_guard';
import { CompanyForm } from './CompanyForm';
import { RegistrationsEditor } from './RegistrationsEditor';
import { AccountRow } from './AccountRow';

export const dynamic = 'force-dynamic';

/**
 * Where an account came from.
 *
 * Three cases, not two. "System" is one the engine posts to and nobody may
 * remove; "Standard" came with the company and can be renamed or removed; and
 * only what somebody actually created is "Added by you". The page used to call
 * the middle group "Added by you", which told a person who had just made their
 * company that they had added accounts they had never seen.
 */
function originOf(account: { code: string; isSystem: boolean }): string {
  if (account.isSystem) return 'System';
  return STANDARD_ACCOUNT_CODES.has(account.code) ? 'Standard' : 'Added by you';
}

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export default async function DataPage() {
  return withContext(async (ctx) => {
    const { org, registrations } = await getCompany(ctx);
    const mayReadAudit = can(ctx.role, 'audit:read');
    const [audit, counts, accounts, documents, members] = await Promise.all([
      mayReadAudit ? getAuditLog(ctx, 25) : Promise.resolve([]),
      getDataCounts(ctx),
      getAccounts(ctx),
      getDocuments(ctx, 10),
      getMembers(ctx),
    ]);

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
          >
            {registrations.length === 0 ? (
              <p className={ui.hint} style={{ marginBottom: 14 }}>
                Add your GSTIN and TAN so taxation workings can be prepared against the right
                registration. Multi-state companies record one GSTIN per state.
              </p>
            ) : null}
            <RegistrationsEditor
              readOnly={!can(ctx.role, 'registration:write')}
              rows={registrations.map((r) => ({
                id: r.id,
                kind: r.kind,
                number: r.number,
                stateCode: r.stateCode,
              }))}
            />
          </Panel>
        </div>

        <Band>What this company holds</Band>

        {/* Counts, not samples: this answers "is there anything in here?"
            before any section is opened. Every figure is a live count of rows
            this organization can see, so a zero means empty rather than
            unloaded. */}
        <Cards>
          <DataCard
            label="Ledger accounts"
            value={String(counts.accounts)}
            caption="Seeded from the chart of accounts when the company was created."
            status="verified"
          />
          <DataCard
            label="Customers and suppliers"
            value={String(counts.parties)}
            caption={counts.parties === 0 ? 'None added yet.' : 'Across both kinds.'}
            status="verified"
          />
          <DataCard
            label="Vouchers"
            value={String(counts.vouchers)}
            caption={`${counts.postedVouchers} posted, ${
              counts.vouchers - counts.postedVouchers
            } still draft.`}
            status={counts.vouchers === counts.postedVouchers ? 'verified' : 'draft'}
          />
          <DataCard
            label="Documents"
            value={String(counts.documents)}
            caption="Stored privately. Nothing has been read out of them yet."
            status="verified"
          />
        </Cards>

        <div style={{ marginTop: 24 }}>
          <Panel
            title="People with access"
            note={`${members.length} ${members.length === 1 ? 'member' : 'members'}`}
            bodyless={members.length > 0}
          >
            {members.length === 0 ? (
              <EmptyState title="No members">
                Every company has at least its owner, so an empty list here means something is
                wrong rather than that nobody has been invited.
              </EmptyState>
            ) : (
              <Table head={<tr><th>Who</th><th>Role</th><th>Status</th><th>MFA</th></tr>}>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.fullName ?? m.email}
                      {m.fullName ? (
                        <div className={ui.hint}>{m.email}</div>
                      ) : null}
                    </td>
                    <td>{ROLE_LABELS[m.role] ?? m.role}</td>
                    <td>
                      {m.status === 'active' ? 'Active' : m.status}
                      {m.validTo ? (
                        <div className={ui.hint}>
                          until {dateTimeFmt.format(m.validTo)}
                        </div>
                      ) : null}
                    </td>
                    <td>{m.mfaEnabled ? 'On' : 'Off'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>

        <div style={{ marginTop: 24 }}>
          <Panel
            title="Chart of accounts"
            note={`${accounts.length} accounts`}
            bodyless={accounts.length > 0}
          >
            {accounts.length === 0 ? (
              <EmptyState title="No chart of accounts">
                A company cannot record a voucher without one. This should have been seeded at
                creation, so an empty chart means the company was created by a path that skipped
                it.
              </EmptyState>
            ) : (
              <Table head={<tr><th>Code</th><th>Account</th><th>Nature</th><th>Origin</th><th /></tr>}>
                {accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={{ id: a.id, code: a.code, name: a.name, note: a.note, nature: a.nature }}
                    origin={originOf(a)}
                    editable={can(ctx.role, 'company:update')}
                  />
                ))}
              </Table>
            )}
          </Panel>
        </div>

        <div style={{ marginTop: 24 }}>
          <Panel
            title="Documents"
            note={documents.length > 0 ? 'Ten most recent' : undefined}
            bodyless={documents.length > 0}
          >
            {documents.length === 0 ? (
              <EmptyState title="Nothing uploaded yet">
                Upload documents from the Input tab. They are stored privately and listed here
                with who added them and when.
              </EmptyState>
            ) : (
              <Table head={<tr><th>Document</th><th>Uploaded</th><th>By</th><th>State</th></tr>}>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={`/api/documents/${d.id}`}>{d.originalFilename}</a>
                    </td>
                    <td className="tnum">{dateTimeFmt.format(d.createdAt)}</td>
                    <td>{d.uploadedByName ?? d.uploadedByEmail ?? '—'}</td>
                    <td className={ui.hint}>{d.status}</td>
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
