import 'server-only';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { projectTasks, projects } from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'project:read')) throw forbidden('view projects');
};

export async function listProjects(ctx: RequestContext, status?: 'active' | 'on_hold' | 'completed' | 'cancelled') {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx
      .select()
      .from(projects)
      .where(
        status ? and(eq(projects.orgId, ctx.orgId), eq(projects.status, status)) : eq(projects.orgId, ctx.orgId),
      )
      .orderBy(projects.name),
  );
}

export async function listProjectTasks(ctx: RequestContext, projectId: string) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.select().from(projectTasks).where(eq(projectTasks.projectId, projectId)).orderBy(projectTasks.dueDate),
  );
}
