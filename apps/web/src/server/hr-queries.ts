import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db/tenant';
import { departments, employees, payrollRuns, payslips } from '@/lib/db/schema';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import type { RequestContext } from '@/lib/auth/context';

const guard = (ctx: RequestContext) => {
  if (!can(ctx.role, 'hr:read')) throw forbidden('view HR records');
};

export async function listDepartments(ctx: RequestContext) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.select().from(departments).where(eq(departments.orgId, ctx.orgId)).orderBy(departments.name),
  );
}

export async function listEmployees(ctx: RequestContext, status?: 'active' | 'on_leave' | 'exited') {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx
      .select()
      .from(employees)
      .where(
        status
          ? and(eq(employees.orgId, ctx.orgId), eq(employees.status, status))
          : eq(employees.orgId, ctx.orgId),
      )
      .orderBy(employees.fullName),
  );
}

export async function listPayrollRuns(ctx: RequestContext) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.orgId, ctx.orgId))
      .orderBy(desc(payrollRuns.periodYear), desc(payrollRuns.periodMonth)),
  );
}

export async function listPayslipsForRun(ctx: RequestContext, payrollRunId: string) {
  guard(ctx);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) =>
    tx.select().from(payslips).where(eq(payslips.payrollRunId, payrollRunId)),
  );
}
