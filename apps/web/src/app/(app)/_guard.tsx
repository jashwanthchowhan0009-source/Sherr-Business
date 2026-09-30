import type { ReactNode } from 'react';
import Link from 'next/link';
import { optionalOrgContext, type RequestContext } from '@/lib/auth/context';
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
  if (!ctx) {
    return (
      <Panel>
        <EmptyState title="No company selected">
          Sign in and choose a company to continue. If you have just been invited, accept the
          invitation first. <Link href="/">Back to start</Link>
        </EmptyState>
      </Panel>
    );
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
