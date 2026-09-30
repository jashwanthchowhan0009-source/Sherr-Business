import { PageHeader } from '@/components/shell/PageHeader';
import { EmptyState, Panel, Table, ui } from '@/components/ui';
import { CAPABILITIES, ROLE_LABELS, can } from '@/lib/auth/permissions';
import { ROLES } from '@/lib/db/schema';
import { getMembers, getPendingInvitations } from '@/server/queries';
import { withContext } from '../_guard';
import { InviteForm } from './InviteForm';

export const dynamic = 'force-dynamic';

const dateFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });

export default async function PeoplePage() {
  return withContext(async (ctx) => {
    const members = await getMembers(ctx);
    const invites = can(ctx.role, 'invite:read') ? await getPendingInvitations(ctx) : [];
    const mayInvite = can(ctx.role, 'member:invite');

    return (
      <>
        <PageHeader
          title="People"
          subtitle="Who has access, what they can do, and when that access ends."
        />

        <Panel title="Members" note={`${members.length} with access`} bodyless>
          <Table
            head={
              <tr>
                <th>Person</th><th>Role</th><th>Two-factor</th><th>Access until</th>
              </tr>
            }
          >
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.fullName ?? m.email}
                  <div style={{ color: 'var(--sb-text-3)', fontSize: 12.5 }}>{m.email}</div>
                </td>
                <td>{ROLE_LABELS[m.role]}</td>
                <td className={m.mfaEnabled ? ui.statusOk : ui.statusErr}>
                  {m.mfaEnabled ? 'Enrolled' : 'Not enrolled'}
                </td>
                <td className="tnum">
                  {m.validTo ? dateFmt.format(m.validTo) : 'No expiry'}
                </td>
              </tr>
            ))}
          </Table>
        </Panel>

        {mayInvite ? (
          <div style={{ marginTop: 24 }}>
            <Panel title="Invite someone">
              <InviteForm />
            </Panel>
          </div>
        ) : null}

        {can(ctx.role, 'invite:read') ? (
          <div style={{ marginTop: 24 }}>
            <Panel title="Pending invitations" bodyless={invites.length > 0}>
              {invites.length === 0 ? (
                <EmptyState title="No pending invitations">
                  Invitations you create appear here until they are accepted or revoked.
                </EmptyState>
              ) : (
                <Table head={<tr><th>Email</th><th>Role</th><th>Expires</th><th>Access until</th></tr>}>
                  {invites.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td>
                      <td>{ROLE_LABELS[i.role]}</td>
                      <td className="tnum">{dateFmt.format(i.expiresAt)}</td>
                      <td className="tnum">{i.validTo ? dateFmt.format(i.validTo) : 'No expiry'}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Panel>
          </div>
        ) : null}

        <div style={{ marginTop: 24 }}>
          <Panel title="Permissions" note={`You are signed in as ${ROLE_LABELS[ctx.role]}`} bodyless>
            <Table head={<tr><th>Capability</th>{ROLES.map((r) => <th key={r}>{ROLE_LABELS[r]}</th>)}</tr>}>
              {CAPABILITIES.map((capability) => (
                <tr key={capability}>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>{capability}</td>
                  {ROLES.map((r) => (
                    <td key={r} className={can(r, capability) ? ui.statusOk : undefined}>
                      {can(r, capability) ? '✓' : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </Table>
          </Panel>
        </div>
      </>
    );
  });
}
