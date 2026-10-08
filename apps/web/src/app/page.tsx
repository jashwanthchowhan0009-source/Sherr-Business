import Link from 'next/link';
import { clerkConfigured } from '@/lib/env';
import { ui } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import brand from '@/components/brand/brand.module.css';

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const configured = clerkConfigured();

  return (
    <main data-theme="dark" style={{ maxWidth: 860, margin: '0 auto', padding: '14vh 16px 64px' }}>
      <div className={brand.hero}>
        <div className={brand.heroMark}>
          {/* Above the fold and the largest thing on the page, so it loads
              eagerly rather than arriving after the text has settled. */}
          <LogoMark height={260} priority />
        </div>

        <div className={brand.heroText}>
          <h1 style={{ fontSize: 'clamp(34px,6vw,52px)', letterSpacing: '-.03em', marginBottom: 16 }}>
            SherrByte Business
          </h1>
          <p style={{ color: 'var(--sb-text-2)', fontSize: 17, marginBottom: 36, maxWidth: '46ch' }}>
            Verified accounting, taxation and reporting for Indian companies. Every number traces
            back to the document it came from.
          </p>

          {error === 'auth_not_configured' || !configured ? (
            <div className={ui.panel}>
              <div className={ui.panelBody}>
                <strong style={{ fontWeight: 400 }}>Authentication is not configured.</strong>
                <p style={{ color: 'var(--sb-text-2)', margin: '8px 0 0', fontSize: 14 }}>
                  Set <code>CLERK_SECRET_KEY</code> and{' '}
                  <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code>, then restart. Setup steps are in{' '}
                  <code>README.md</code>. Protected pages stay closed until then.
                </p>
              </div>
            </div>
          ) : (
            <div className={ui.actions}>
              <Link className={ui.button} href="/sign-in">
                Sign in
              </Link>
              <Link className={`${ui.button} ${ui.buttonGhost}`} href="/sign-up">
                Create an account
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
