import { SignOutButton, UserProfile } from '@clerk/nextjs';
import { Panel, ui } from '@/components/ui';
import { LogoGlyph } from '@/components/brand/Logo';

export const dynamic = 'force-dynamic';

/**
 * Hard gate. Reached whenever the session carries no second factor.
 * This is a financial product; MFA is not opt-in.
 *
 * The enrolment UI is embedded rather than linked. Middleware sends every
 * signed-in user here until the `mfa` claim is true, so whatever this page
 * cannot do, the user cannot do at all. An earlier version pointed at a "user
 * menu" that does not exist anywhere in this app, which left every account
 * stranded here with no way to enrol and no way to sign out.
 */
export default function MfaGatePage() {
  return (
    <main data-theme="dark" style={{ maxWidth: 880, margin: '0 auto', padding: '10vh 16px 64px' }}>
      {/* This page has no top bar — middleware sends people here before the
          shell exists — so it carries the mark itself. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <LogoGlyph size={40} />
        <span
          style={{
            fontSize: 13,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--sb-text-3)',
          }}
        >
          SherrByte
        </span>
      </div>

      <h1 style={{ fontSize: 'clamp(28px,5vw,40px)', letterSpacing: '-.02em', marginBottom: 12 }}>
        Add two-factor authentication
      </h1>
      <p style={{ color: 'var(--sb-text-2)', marginBottom: 28, maxWidth: '52ch' }}>
        SherrByte holds your company&apos;s financial records, so a password alone is not enough.
        Open <strong style={{ color: 'var(--sb-text)' }}>Security → Two-step verification</strong>{' '}
        below, scan the code with your authenticator app, and save the backup codes. Access opens as
        soon as your session carries the second factor.
      </p>

      <div style={{ marginBottom: 28 }}>
        <UserProfile routing="hash" />
      </div>

      <Panel>
        <p className={ui.hint} style={{ margin: 0 }}>
          Already enrolled and still seeing this? Sign out and back in so the session picks up the
          change.
        </p>
        <div className={ui.actions} style={{ marginTop: 16 }}>
          <SignOutButton>
            <button type="button" className={`${ui.button} ${ui.buttonGhost}`}>
              Sign out
            </button>
          </SignOutButton>
        </div>
      </Panel>
    </main>
  );
}
