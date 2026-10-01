'use server';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineAction } from '@/lib/auth/action';
import { organizations, orgRegistrations, REGISTRATION_KINDS } from '@/lib/db/schema';
import { notFound } from '@/lib/errors';
import { revalidatePath } from 'next/cache';

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

const companyProfileSchema = z.object({
  legalName: z.string().trim().min(2, 'Legal name is required').max(200),
  tradeName: z.string().trim().max(200).optional().or(z.literal('')),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PAN, 'PAN looks like AAAAA9999A')
    .optional()
    .or(z.literal('')),
  stateCode: z
    .string()
    .trim()
    .regex(/^[0-9]{2}$/, 'State code is two digits')
    .optional()
    .or(z.literal('')),
  fyStartMonth: z.coerce.number().int().min(1).max(12),
});

const updateCompanyProfileAction = defineAction({
  name: 'company.profile.updated',
  capability: 'company:update',
  input: companyProfileSchema,
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
    if (!before) throw notFound('Company');

    const next = {
      legalName: input.legalName,
      tradeName: input.tradeName || null,
      pan: input.pan || null,
      stateCode: input.stateCode || null,
      fyStartMonth: input.fyStartMonth,
      updatedAt: new Date(),
    };

    const [after] = await tx
      .update(organizations)
      .set(next)
      .where(eq(organizations.id, orgId))
      .returning();

    await audit({
      action: 'company.profile.updated',
      subjectKind: 'organization',
      subjectId: orgId,
      before: {
        legalName: before.legalName,
        tradeName: before.tradeName,
        pan: before.pan,
        stateCode: before.stateCode,
        fyStartMonth: before.fyStartMonth,
      },
      after: next,
    });

    revalidatePath('/data');
    return { legalName: after?.legalName ?? input.legalName };
  },
});

const registrationSchema = z.object({
  kind: z.enum(REGISTRATION_KINDS),
  number: z.string().trim().toUpperCase().min(3).max(32),
  stateCode: z
    .string()
    .trim()
    .regex(/^[0-9]{2}$/, 'State code is two digits')
    .optional()
    .or(z.literal('')),
});

const addRegistrationAction = defineAction({
  name: 'company.registration.added',
  capability: 'registration:write',
  input: registrationSchema.refine(
    (v) => v.kind !== 'gstin' || GSTIN.test(v.number),
    { message: 'GSTIN must be 15 characters, e.g. 29AABCS1234A1ZX', path: ['number'] },
  ),
  handler: async ({ tx, orgId, input, audit }) => {
    const [row] = await tx
      .insert(orgRegistrations)
      .values({
        orgId,
        kind: input.kind,
        number: input.number,
        // A GSTIN carries its state in the first two digits; trust the number.
        stateCode: input.kind === 'gstin' ? input.number.slice(0, 2) : input.stateCode || null,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      return { id: null, duplicate: true as const };
    }

    await audit({
      action: 'company.registration.added',
      subjectKind: 'org_registration',
      subjectId: row.id,
      after: { kind: row.kind, number: row.number, stateCode: row.stateCode },
    });

    revalidatePath('/data');
    return { id: row.id, duplicate: false as const };
  },
});

const removeRegistrationAction = defineAction({
  name: 'company.registration.removed',
  capability: 'registration:write',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ tx, orgId, input, audit }) => {
    const [before] = await tx
      .select()
      .from(orgRegistrations)
      .where(and(eq(orgRegistrations.id, input.id), eq(orgRegistrations.orgId, orgId)));
    if (!before) throw notFound('Registration');

    await tx.delete(orgRegistrations).where(eq(orgRegistrations.id, input.id));

    await audit({
      action: 'company.registration.removed',
      subjectKind: 'org_registration',
      subjectId: input.id,
      before: { kind: before.kind, number: before.number },
    });

    revalidatePath('/data');
    return { id: input.id };
  },
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function updateCompanyProfile(input: unknown) {
  return updateCompanyProfileAction(input);
}

export async function addRegistration(input: unknown) {
  return addRegistrationAction(input);
}

export async function removeRegistration(input: unknown) {
  return removeRegistrationAction(input);
}
