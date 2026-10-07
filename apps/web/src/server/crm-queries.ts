import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { dealActivities, deals, pipelineStages } from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'crm:read')) throw forbidden('view the sales pipeline');
};

/** Ordered for board rendering: lowest sortOrder first. */
export async function listPipelineStages(ctx: RequestContext) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.select().from(pipelineStages).where(eq(pipelineStages.orgId, ctx.orgId)).orderBy(pipelineStages.sortOrder),
  );
}

/**
 * Every open deal, newest first. Shallow on purpose: no stage join, no
 * pagination — a kanban board groups these client-side by stageId for now.
 */
export async function listDeals(ctx: RequestContext) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.select().from(deals).where(eq(deals.orgId, ctx.orgId)).orderBy(desc(deals.updatedAt)),
  );
}

export async function listDealActivities(ctx: RequestContext, dealId: string) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx
      .select()
      .from(dealActivities)
      .where(eq(dealActivities.dealId, dealId))
      .orderBy(desc(dealActivities.createdAt)),
  );
}
