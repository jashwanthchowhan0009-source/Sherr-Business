'use server';

import { z } from 'zod';
import { clerkClient } from '@clerk/nextjs/server';
import { defineAccountAction } from '@/lib/auth/action';
import { createCompany as createCompanyRow } from '@/lib/db/tenant';
import { ACCOUNTS, ACCOUNT_GROUPS } from '@/lib/accounting/chart-of-accounts';
import { REGISTRATION_TYPES } from '@/lib/db/schema';
import { isValidPan, validateGstin } from '@/lib/india/gstin';
import { conflict, AppError } from '@/lib/errors';

const companySchema = z
  .object({
    legalName: z.string().trim().min(2, 'Enter the registered legal name').max(200),
    tradeName: z.string().trim().max(200).optional().or(z.literal('')),
    registrationType: z.enum(REGISTRATION_TYPES),
    gstin: z.string().trim().toUpperCase().optional().or(z.literal('')),
    pan: z.string().trim().toUpperCase().optional().or(z.literal('')),
    // Always required, never inferred from nothing. The GST engine decides
    // CGST+SGST against IGST by comparing this with the place of supply, so a
    // company without it cannot raise a single invoice.
    stateCode: z
      .string()
      .trim()
      .regex(/^[0-9]{2}$/, 'Choose the state your business is in'),
    fyStartMonth: z.coerce.number().int().min(1).max(12).default(4),
    booksStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
    baseCurrency: z.literal('INR').default('INR'),
  })
  .superRefine((value, ctx) => {
    // A GSTIN is never required to create a company. Registration under GST is
    // compulsory only above the turnover thresholds, so plenty of real
    // businesses have none; and somebody who is registered may simply not have
    // the number to hand, or may still be waiting for it. Refusing to open the
    // books over a field that can be filled in later helps nobody. What the
    // books genuinely cannot do without is the state, which is asked for
    // directly above.
    if (!value.gstin) {
      if (value.pan && !isValidPan(value.pan)) {
        ctx.addIssue({ code: 'custom', path: ['pan'], message: 'PAN looks like AAAAA9999A.' });
      }
      return;
    }

    const result = validateGstin(value.gstin);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', path: ['gstin'], message: result.message });
      return;
    }

    // The GSTIN carries the PAN and the state. If either was also supplied and
    // disagrees, one of them is wrong — say so rather than silently preferring
    // the GSTIN, because the user may have mistyped the GSTIN itself.
    if (value.pan && value.pan !== result.parts.pan) {
      ctx.addIssue({
        code: 'custom',
        path: ['pan'],
        message: `This GSTIN belongs to PAN ${result.parts.pan}. Check which is right.`,
      });
    }
    if (value.stateCode && value.stateCode !== result.parts.stateCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['stateCode'],
        message: `This GSTIN was issued in ${result.parts.stateName}.`,
      });
    }
  });

const createCompanyAction = defineAccountAction({
  name: 'company.created',
  input: companySchema,
  // Creating companies is rare and creates a Clerk organization each time.
  // Raised from three. Creating a company is a once-ever action, so the limit is
  // only there to stop a script; three left somebody who hit a few server errors
  // locked out of onboarding for an hour with nothing they could do about it.
  rateLimit: { limit: 20, windowSeconds: 3600 },
  handler: async ({ userId, clerkUserId, input }) => {
    const parsed = input.gstin ? validateGstin(input.gstin) : null;
    const derived = parsed?.ok ? parsed.parts : null;

    const pan = derived?.pan ?? (input.pan || null);
    const stateCode = derived?.stateCode ?? (input.stateCode || null);

    // Clerk owns organization membership, so its org must exist before ours.
    // Created first deliberately: if our transaction then fails, we are left
    // with an empty Clerk org the user can retry into, rather than a company
    // with no way to reach it.
    const clerk = await clerkClient();
    let clerkOrgId: string;
    try {
      const org = await clerk.organizations.createOrganization({
        name: input.legalName,
        createdBy: clerkUserId,
      });
      clerkOrgId = org.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new AppError(
        `Could not create the organization (${message}). Nothing was saved.`,
        'conflict',
      );
    }

    // One statement, one transaction: organization, owner membership, GSTIN,
    // the chart of accounts and the audit row all commit together.
    const { id: orgId } = await createCompanyRow({
      clerkOrgId,
      legalName: input.legalName,
      ownerUserId: userId,
      tradeName: input.tradeName || null,
      gstin: input.gstin || null,
      pan,
      stateCode,
      registrationType: input.registrationType,
      fyStartMonth: input.fyStartMonth,
      booksStartDate: input.booksStartDate,
      accountGroups: ACCOUNT_GROUPS,
      accounts: ACCOUNTS,
    });

    if (!orgId) throw conflict('The company could not be created.');

    return { orgId, clerkOrgId, legalName: input.legalName };
  },
});

// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate.

export async function createCompany(input: unknown) {
  return createCompanyAction(input);
}
