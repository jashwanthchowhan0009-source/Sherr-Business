'use server';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { EMPLOYMENT_TYPES, departments, employees, payrollRuns, payslips } from '@/lib/db/schema';
import { conflict, invalidInput, notFound } from '@/lib/errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
const rupeesToPaise = (rupees: string) => BigInt(Math.round(parseFloat(rupees || '0') * 100));

const createDepartmentAction = defineAction({
  name: 'hr.department.created',
  capability: 'hr:write',
  input: z.object({ name: z.string().trim().min(1, 'Name the department').max(100) }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [department] = await tx.insert(departments).values({ orgId, name: input.name }).returning();
    await audit({ action: 'hr.department.created', subjectKind: 'department', subjectId: department?.id, after: input });
    revalidatePath('/hr');
    return department;
  },
});

const createEmployeeAction = defineAction({
  name: 'hr.employee.created',
  capability: 'hr:write',
  input: z.object({
    fullName: z.string().trim().min(1, "Enter the employee's name").max(200),
    email: z.string().trim().email().optional().or(z.literal('')),
    phone: z.string().trim().max(20).optional().or(z.literal('')),
    departmentId: z.string().uuid().optional().or(z.literal('')),
    designation: z.string().trim().max(100).optional().or(z.literal('')),
    employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
    dateOfJoining: isoDate.optional().or(z.literal('')),
    monthlyCtcRupees: z.string().trim().optional().or(z.literal('')),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    if (input.departmentId) {
      const [department] = await tx.select().from(departments).where(eq(departments.id, input.departmentId));
      if (!department) throw notFound('That department');
    }

    const [employee] = await tx
      .insert(employees)
      .values({
        orgId,
        fullName: input.fullName,
        email: input.email || null,
        phone: input.phone || null,
        departmentId: input.departmentId || null,
        designation: input.designation || null,
        employmentType: input.employmentType,
        dateOfJoining: input.dateOfJoining || null,
        monthlyCtcPaise: input.monthlyCtcRupees ? rupeesToPaise(input.monthlyCtcRupees) : null,
      })
      .returning();

    await audit({ action: 'hr.employee.created', subjectKind: 'employee', subjectId: employee?.id, after: input });
    revalidatePath('/hr');
    return employee;
  },
});

/**
 * Opens a payroll run for a month and seeds one payslip per active employee
 * from their monthly CTC. This is a starting point, not a payroll engine —
 * deductions, statutory contributions and pro-rating for mid-month joiners or
 * exits are a later, deliberate addition, not something inferred here.
 */
const openPayrollRunAction = defineAction({
  name: 'hr.payroll_run.opened',
  capability: 'hr:write',
  input: z.object({
    periodMonth: z.coerce.number().int().min(1).max(12),
    periodYear: z.coerce.number().int().min(2000).max(2100),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [existing] = await tx
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          eq(payrollRuns.periodYear, input.periodYear),
          eq(payrollRuns.periodMonth, input.periodMonth),
        ),
      );
    if (existing) throw conflict('A payroll run already exists for that month.');

    const activeEmployees = await tx
      .select()
      .from(employees)
      .where(and(eq(employees.orgId, orgId), eq(employees.status, 'active')));

    const lines = activeEmployees
      .filter((e) => e.monthlyCtcPaise !== null)
      .map((e) => ({ employeeId: e.id, grossPaise: e.monthlyCtcPaise! }));

    if (lines.length === 0) {
      throw invalidInput('No active employee has a monthly CTC set yet.');
    }

    const totalGrossPaise = lines.reduce((acc, l) => acc + l.grossPaise, 0n);

    const [run] = await tx
      .insert(payrollRuns)
      .values({
        orgId,
        periodMonth: input.periodMonth,
        periodYear: input.periodYear,
        totalGrossPaise,
        totalDeductionsPaise: 0n,
        totalNetPaise: totalGrossPaise,
      })
      .returning();

    for (const line of lines) {
      await tx.insert(payslips).values({
        orgId,
        payrollRunId: run!.id,
        employeeId: line.employeeId,
        grossPaise: line.grossPaise,
        deductionsPaise: 0n,
        netPaise: line.grossPaise,
      });
    }

    await audit({
      action: 'hr.payroll_run.opened',
      subjectKind: 'payroll_run',
      subjectId: run?.id,
      after: { ...input, employeeCount: lines.length, totalGrossPaise: totalGrossPaise.toString() },
    });
    revalidatePath('/hr');
    return run;
  },
});

const approvePayrollRunAction = defineAction({
  name: 'hr.payroll_run.approved',
  capability: 'hr:write',
  input: z.object({ payrollRunId: z.string().uuid() }),
  handler: async ({ tx, input, userId, audit }) => {
    const [before] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, input.payrollRunId));
    if (!before) throw notFound('That payroll run');
    if (before.status !== 'draft') throw conflict('Only a draft payroll run can be approved.');

    const [after] = await tx
      .update(payrollRuns)
      .set({ status: 'approved', approvedBy: userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(payrollRuns.id, input.payrollRunId))
      .returning();

    await audit({
      action: 'hr.payroll_run.approved',
      subjectKind: 'payroll_run',
      subjectId: input.payrollRunId,
      before: { status: before.status },
      after: { status: after?.status },
    });
    revalidatePath('/hr');
    return after;
  },
});

export async function createDepartment(input: unknown) {
  return createDepartmentAction(input);
}

export async function createEmployee(input: unknown) {
  return createEmployeeAction(input);
}

export async function openPayrollRun(input: unknown) {
  return openPayrollRunAction(input);
}

export async function approvePayrollRun(input: unknown) {
  return approvePayrollRunAction(input);
}
