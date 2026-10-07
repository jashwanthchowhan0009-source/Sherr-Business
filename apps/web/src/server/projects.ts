'use server';

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { PROJECT_TASK_STATUSES, parties, projectTasks, projects } from '@/lib/db/schema';
import { notFound } from '@/lib/errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');
const optionalDate = isoDate.optional().or(z.literal(''));

const createProjectAction = defineAction({
  name: 'project.created',
  capability: 'project:write',
  input: z.object({
    name: z.string().trim().min(1, 'Name the project').max(200),
    partyId: z.string().uuid().optional().or(z.literal('')),
    startDate: optionalDate,
    dueDate: optionalDate,
    budgetRupees: z.string().trim().optional().or(z.literal('')),
  }),
  handler: async ({ tx, orgId, input, userId, audit }) => {
    if (input.partyId) {
      const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
      if (!party) throw notFound('That party');
    }

    const [project] = await tx
      .insert(projects)
      .values({
        orgId,
        name: input.name,
        partyId: input.partyId || null,
        startDate: input.startDate || null,
        dueDate: input.dueDate || null,
        ownerUserId: userId,
        budgetPaise: input.budgetRupees ? BigInt(Math.round(parseFloat(input.budgetRupees) * 100)) : null,
      })
      .returning();

    await audit({ action: 'project.created', subjectKind: 'project', subjectId: project?.id, after: input });
    revalidatePath('/projects');
    return project;
  },
});

const createProjectTaskAction = defineAction({
  name: 'project.task.created',
  capability: 'project:write',
  input: z.object({
    projectId: z.string().uuid(),
    title: z.string().trim().min(1, 'Title the task').max(300),
    assigneeUserId: z.string().uuid().optional().or(z.literal('')),
    dueDate: optionalDate,
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
    if (!project) throw notFound('That project');

    const [task] = await tx
      .insert(projectTasks)
      .values({
        orgId,
        projectId: input.projectId,
        title: input.title,
        assigneeUserId: input.assigneeUserId || null,
        dueDate: input.dueDate || null,
      })
      .returning();

    await audit({ action: 'project.task.created', subjectKind: 'project_task', subjectId: task?.id, after: input });
    revalidatePath('/projects');
    return task;
  },
});

const updateProjectTaskStatusAction = defineAction({
  name: 'project.task.status_changed',
  capability: 'project:write',
  input: z.object({
    taskId: z.string().uuid(),
    status: z.enum(PROJECT_TASK_STATUSES),
  }),
  handler: async ({ tx, input, audit }) => {
    const [before] = await tx.select().from(projectTasks).where(eq(projectTasks.id, input.taskId));
    if (!before) throw notFound('That task');

    const [after] = await tx
      .update(projectTasks)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(projectTasks.id, input.taskId))
      .returning();

    await audit({
      action: 'project.task.status_changed',
      subjectKind: 'project_task',
      subjectId: input.taskId,
      before: { status: before.status },
      after: { status: after?.status },
    });
    revalidatePath('/projects');
    return after;
  },
});

export async function createProject(input: unknown) {
  return createProjectAction(input);
}

export async function createProjectTask(input: unknown) {
  return createProjectTaskAction(input);
}

export async function updateProjectTaskStatus(input: unknown) {
  return updateProjectTaskStatusAction(input);
}
