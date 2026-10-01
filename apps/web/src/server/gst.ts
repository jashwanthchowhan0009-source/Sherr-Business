'use server';

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { defineAction } from '@/lib/auth/action';
import { UnreadableGstr2bError, parseGstr2b } from '@/lib/gst/gstr2b';
import { conflict, invalidInput, notFound } from '@/lib/errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');

/**
 * Uploads a GSTR-2B file from the portal.
 *
 * Parses it, stores what it said, and reconciles it against the purchase
 * register. Nothing is posted and no credit is claimed or reversed: the output is
 * a list of differences and what each means, for a person to act on.
 *
 * The file's own GSTIN is checked against the company's registrations. A GSTR-2B
 * for the wrong company would reconcile against the wrong books and produce a
 * page of differences that are all artefacts, which is worse than refusing it.
 */
const uploadGstr2bAction = defineAction({
  name: 'gst.gstr2b.uploaded',
  capability: 'voucher:post',
  input: z.object({
    periodFrom: isoDate,
    periodTo: isoDate,
    documentId: z.string().uuid().optional().or(z.literal('')),
    /** The JSON file, base64 so the bytes survive unchanged. */
    contentBase64: z.string().min(1),
  }),
  rateLimit: { limit: 10, windowSeconds: 60 },
  handler: async ({ tx, input, userId, audit }) => {
    if (input.periodTo < input.periodFrom) {
      throw invalidInput('The period must end on or after it starts.');
    }

    const text = Buffer.from(input.contentBase64, 'base64').toString('utf8');

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw invalidInput(
        'That file is not valid JSON. Download the GSTR-2B JSON from the portal rather than a ' +
          'spreadsheet or a PDF.',
      );
    }

    let parsed;
    try {
      parsed = parseGstr2b(json);
    } catch (err) {
      if (err instanceof UnreadableGstr2bError) throw invalidInput(err.message);
      throw err;
    }

    if (parsed.invoices.length === 0) {
      throw invalidInput(
        parsed.problems.length > 0
          ? `No invoices could be read. The first problem is at ${parsed.problems[0]?.path}: ${parsed.problems[0]?.reason}`
          : 'That file contains no B2B invoices.',
      );
    }

    // A file for another company would reconcile against the wrong books.
    if (parsed.gstin) {
      const ours = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from org_registrations
         where kind = 'gstin' and upper(number) = ${parsed.gstin}
      `);
      if (Number(ours.rows[0]?.n ?? 0) === 0) {
        throw conflict(
          `That file is for GSTIN ${parsed.gstin}, which is not registered to this company. ` +
            'Reconciling it against these books would produce differences that are all artefacts.',
        );
      }
    }

    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into gstr2b_uploads (
        org_id, document_id, period, period_from, period_to, stated_gstin,
        invoice_count, problem_count, invoices, uploaded_by
      ) values (
        app_current_org_id(), ${input.documentId || null}::uuid, ${parsed.period},
        ${input.periodFrom}::date, ${input.periodTo}::date, ${parsed.gstin},
        ${parsed.invoices.length}, ${parsed.problems.length},
        ${JSON.stringify(
          // Amounts as strings: a bigint cannot be serialised, and a float would
          // defeat the point of having parsed them exactly.
          parsed.invoices.map((i) => ({
            supplierGstin: i.supplierGstin,
            supplierName: i.supplierName,
            invoiceNo: i.invoiceNo,
            invoiceDate: i.invoiceDate,
            taxablePaise: i.taxablePaise.toString(),
            igst: i.tax.igst.toString(),
            cgst: i.tax.cgst.toString(),
            sgst: i.tax.sgst.toString(),
            cess: i.tax.cess.toString(),
            itcAvailable: i.itcAvailable,
            itcReason: i.itcReason,
          })),
        )}::jsonb,
        ${userId}::uuid
      ) returning id
    `);

    await audit({
      action: 'gst.gstr2b.uploaded',
      subjectKind: 'gstr2b_upload',
      subjectId: rows[0]!.id,
      after: {
        period: parsed.period,
        statedGstin: parsed.gstin,
        invoicesRead: parsed.invoices.length,
        problems: parsed.problems.length,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
      },
    });

    revalidatePath('/output');
    return {
      id: rows[0]!.id,
      period: parsed.period,
      invoicesRead: parsed.invoices.length,
      problems: parsed.problems.slice(0, 10),
    };
  },
});

/**
 * A CA signs a tax rule off.
 *
 * Clears the `needs_ca_verification` flag on one of this company's own rules,
 * recording who and when. A product-wide rule — one with no organization — cannot
 * be signed off by a single company, and the SQL function enforces that: whoever
 * maintains the product ships those verified or not at all.
 *
 * Held by `taxrule:verify`, which only the owner and the CA reviewer have. An
 * accountant using a rate is not the same as a professional approving it.
 */
const verifyTaxRuleAction = defineAction({
  name: 'taxrule.verified',
  capability: 'taxrule:verify',
  input: z.object({
    ruleId: z.string().uuid(),
    verifiedBy: z
      .string()
      .trim()
      .min(3, 'Give the name and membership number of the professional signing this off')
      .max(200),
  }),
  handler: async ({ tx, input, audit }) => {
    const { rows } = await tx.execute<{ ok: boolean }>(sql`
      select app_verify_tax_rule(${input.ruleId}::uuid, ${input.verifiedBy}) as ok
    `);
    if (!rows[0]?.ok) {
      throw notFound(
        'That rule either does not belong to this company or does not exist. A rule shipped with ' +
          'the product cannot be signed off by one company.',
      );
    }

    await audit({
      action: 'taxrule.verified',
      subjectKind: 'tax_rule',
      subjectId: input.ruleId,
      before: { needsCaVerification: true },
      after: { needsCaVerification: false, verifiedBy: input.verifiedBy },
    });

    revalidatePath('/output');
    revalidatePath('/data');
    return { ruleId: input.ruleId };
  },
});


// ─── exported entry points ──────────────────────────────────────────────────
// A 'use server' module may only export async functions, so each action is
// exposed through a thin wrapper. The body must do nothing but delegate:
// tests/unit/action-guard.test.ts fails if any logic appears here.

export async function uploadGstr2b(input: unknown) {
  return uploadGstr2bAction(input);
}

export async function verifyTaxRule(input: unknown) {
  return verifyTaxRuleAction(input);
}
