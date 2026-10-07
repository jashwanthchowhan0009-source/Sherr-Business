'use client';

import { useState, useTransition } from 'react';
import { inviteMember } from '@/server/members';
import { ROLES } from '@/lib/db/schema';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/auth/permissions';
import { ui } from '@/components/ui';

export function InviteForm() {
  const [pending, start] = useTransition();
  const [role, setRole] = useState<(typeof ROLES)[number]>('accountant');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const external = role === 'ca_reviewer';

  function onSubmit(formData: FormData) {
    setMessage(null);
    setToken(null);
    start(async () => {
      const raw = {
        email: String(formData.get('email') ?? ''),
        role: String(formData.get('role') ?? ''),
        validToDays: formData.get('validToDays')
          ? Number(formData.get('validToDays'))
          : undefined,
      };
      const result = await inviteMember(raw);
      if (result.ok) {
        setToken(result.data.token);
        setMessage({ tone: 'ok', text: 'Invitation created.' });
      } else {
        setMessage({ tone: 'err', text: result.error });
      }
    });
  }

  return (
    <form action={onSubmit}>
      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="invite-email">Email address</label>
          <input
            className={ui.input}
            id="invite-email"
            name="email"
            type="email"
            required
            autoComplete="off"
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="invite-role">Role</label>
          <select
            className={ui.input}
            id="invite-role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
          <span className={ui.hint}>{ROLE_DESCRIPTIONS[role]}</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="invite-days">Access expires after</label>
          <input
            className={ui.input}
            id="invite-days"
            name="validToDays"
            type="number"
            min={1}
            max={3650}
          />
          <span className={ui.hint}>
            {external
              ? 'External reviewers should expire. 120 days covers a quarter plus filing. Blank means no expiry.'
              : 'Optional. Blank means access continues until it is removed.'}
          </span>
        </div>
      </div>

      <div className={ui.actions}>
        <button className={ui.button} type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create invitation'}
        </button>
        {message ? (
          <span className={`${ui.status} ${message.tone === 'ok' ? ui.statusOk : ui.statusErr}`}>
            {message.text}
          </span>
        ) : null}
      </div>

      {token ? (
        <div style={{ marginTop: 16 }}>
          <span className={ui.label}>Invitation link — shown once, not stored</span>
          <input
            className={ui.input}
            readOnly
            value={`${window.location.origin}/invite/${token}`}
            onFocus={(e) => e.currentTarget.select()}
            style={{ marginTop: 6 }}
          />
          <span className={ui.hint}>
            Only a hash of this token is kept, so it cannot be recovered later. Send it now.
          </span>
        </div>
      ) : null}
    </form>
  );
}
