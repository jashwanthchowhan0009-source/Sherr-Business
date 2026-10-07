'use server';

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { DEAL_ACTIVITY_KINDS, dealActivities, deals, parties, pipelineStages } from '@/lib/db/schema';
import { notFound } from '@/lib/errors';

const optional = (schema: z.ZodString) => schema.optional().or(z.literal(''));

const createPipelineStageAction = defineAction({
  name: 'crm.stage.created',
  capability: 'crm:write',
  input: z.object({
    name: z.string().trim().min(1, 'Name the stage').max(100),
    sortOrder: z.coerce.number().int().default(0),
    isWon: z.boolean().default(false),
    isLost: z.boolean().default(false),
  }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [stage] = await tx
      .insert(pipelineStages)
      .values({ orgId, name: input.name, sortOrder: input.sortOrder, isWon: input.isWon, isLost: input.isLost })
      .returning();
    await audit({ action: 'crm.stage.created', subjectKind: 'pipeline_stage', subjectId: stage?.id, after: input });
    revalidatePath('/crm');
    return stage;
  },
});

/**
 * A deal against an existing party. Shallow on purpose: no inline party
 * creation here — reuse party:write (already on the ledger side) to add one
 * first, so a deal's customer and an invoice's customer stay the same record.
 */
const createDealAction = defineAction({
  name: 'crm.deal.created',
  capability: 'crm:write',
  input: z.object({
    partyId: z.string().uuid('Choose a party').optional().or(z.literal('')),
    stageId: z.string().uuid('Choose a stage'),
    title: z.string().trim().min(1, 'Title the deal').max(200),
    valueRupees: z.string().trim().default('0'),
    expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
    notes: optional(z.string().trim().max(2000)),
  }),
  handler: async ({ tx, orgId, input, userId, audit }) => {
    const [stage] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, input.stageId));
    if (!stage) throw notFound('That pipeline stage');

    if (input.partyId) {
      const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
      if (!party) throw notFound('That party');
    }

    const valuePaise = BigInt(Math.round(parseFloat(input.valueRupees || '0') * 100));

    const [deal] = await tx
      .insert(deals)
      .values({
        orgId,
        partyId: input.partyId || null,
        stageId: input.stageId,
        title: input.title,
        valuePaise,
        expectedCloseDate: input.expectedCloseDate || null,
        ownerUserId: userId,
        notes: input.notes || null,
      })
      .returning();

    await audit({ action: 'crm.deal.created', subjectKind: 'deal', subjectId: deal?.id, after: input });
    revalidatePath('/crm');
    return deal;
  },
});

const moveDealStageAction = defineAction({
  name: 'crm.deal.stage_changed',
  capability: 'crm:write',
  input: z.object({
    dealId: z.string().uuid(),
    stageId: z.string().uuid(),
  }),
  handler: async ({ tx, orgId, input, userId, audit }) => {
    const [before] = await tx.select().from(deals).where(eq(deals.id, input.dealId));
    if (!before) throw notFound('That deal');
    const [stage] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, input.stageId));
    if (!stage) throw notFound('That pipeline stage');

    const status = stage.isWon ? 'won' : stage.isLost ? 'lost' : 'open';

    const [after] = await tx
      .update(deals)
      .set({ stageId: input.stageId, status, updatedAt: new Date() })
      .where(eq(deals.id, input.dealId))
      .returning();

    await tx.insert(dealActivities).values({
      orgId,
      dealId: input.dealId,
      kind: 'stage_change',
      body: `Moved from ${before.stageId} to ${input.stageId}`,
      createdBy: userId,
    });

    await audit({
      action: 'crm.deal.stage_changed',
      subjectKind: 'deal',
      subjectId: input.dealId,
      before: { stageId: before.stageId, status: before.status },
      after: { stageId: after?.stageId, status: after?.status },
    });
    revalidatePath('/crm');
    return after;
  },
});

const addDealActivityAction = defineAction({
  name: 'crm.deal.activity_added',
  capability: 'crm:write',
  input: z.object({
    dealId: z.string().uuid(),
    kind: z.enum(DEAL_ACTIVITY_KINDS).default('note'),
    body: z.string().trim().min(1, 'Say something').max(2000),
  }),
  handler: async ({ tx, orgId, input, userId, audit }) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, input.dealId));
    if (!deal) throw notFound('That deal');

    const [activity] = await tx
      .insert(dealActivities)
      .values({ orgId, dealId: input.dealId, kind: input.kind, body: input.body, createdBy: userId })
      .returning();

    await audit({ action: 'crm.deal.activity_added', subjectKind: 'deal', subjectId: input.dealId, after: input });
    revalidatePath('/crm');
    return activity;
  },
});

export async function createPipelineStage(input: unknown) {
  return createPipelineStageAction(input);
}

export async function createDeal(input: unknown) {
  return createDealAction(input);
}

export async function moveDealStage(input: unknown) {
  return moveDealStageAction(input);
}

export async function addDealActivity(input: unknown) {
  return addDealActivityAction(input);
}
