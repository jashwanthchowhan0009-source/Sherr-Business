import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { optionalOrgContext, type RequestContext } from '@/lib/auth/context';
import { screenUnlocked } from '@/lib/auth/unlock';
import { EmptyState, Panel, ui } from '@/components/ui';

/**
 * Renders a page only when the caller resolves to an organization context.
 * Server actions re-check independently; this is about what the page shows,
 * never about what it is allowed to do.
 */
export async function withContext(
  render: (ctx: RequestContext) => ReactNode | Promise<ReactNode>,
): Promise<ReactNode> {
  const ctx = await optionalOrgContext();
  // No company yet: send them to create one rather than showing a dead end.
  // Signing in is handled upstream by middleware, so reaching here without a
  // context means the user exists but belongs to no organization.
  if (!ctx) redirect('/onboarding/company');

  // The screen lock. Checked here rather than drawn over the page, because an
  // overlay on top of data the browser already holds is decoration: the page
  // simply is not rendered until the PIN has been entered.
  if (!(await screenUnlocked(ctx.userId))) {
    // The lock screen reads from the database which of set, enter or reset it is,
    // so there is nothing to tell it here.
    redirect('/lock');
  }

  return render(ctx);
}

/** Honest placeholder for the modules that Phase 1 deliberately does not build. */
export function PhaseTwo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel>
      <EmptyState title={title}>
        {children}{' '}
        <span className={`${ui.pill} ${ui.pillOnDark}`} style={{ marginLeft: 6 }}>
          Phase 2
        </span>
      </EmptyState>
    </Panel>
  );
}
