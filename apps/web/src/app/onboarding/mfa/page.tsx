import { Panel, ui } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Hard gate. Reached whenever the session carries no second factor.
 * This is a financial product; MFA is not opt-in.
 */
export default function MfaGatePage() {
  return (
    <main style={{ maxWidth: 620, margin: '0 auto', padding: '16vh 16px 64px' }}>
      <h1 style={{ fontSize: 'clamp(28px,5vw,40px)', letterSpacing: '-.02em', marginBottom: 12 }}>
        Add two-factor authentication
      </h1>
      <p style={{ color: 'var(--sb-text-2)', marginBottom: 28, maxWidth: '52ch' }}>
        SherrByte holds your company&apos;s financial records, so a password alone is not enough.
        Add an authenticator app to continue.
      </p>
      <Panel>
        <ol style={{ margin: 0, paddingLeft: 20, color: 'var(--sb-text-2)', fontSize: 14, lineHeight: 2 }}>
          <li>Open your account settings from the user menu.</li>
          <li>Choose <strong style={{ color: 'var(--sb-text)' }}>Security → Two-step verification</strong>.</li>
          <li>Scan the code with your authenticator app and save the backup codes.</li>
          <li>Return here — access opens automatically.</li>
        </ol>
        <p className={ui.hint} style={{ marginTop: 18 }}>
          Already enrolled and still seeing this? Sign out and back in so the session picks up the
          change.
        </p>
      </Panel>
    </main>
  );
}
