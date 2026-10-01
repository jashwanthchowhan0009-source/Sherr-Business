import { NextResponse } from 'next/server';
import { requireOrgContext } from '@/lib/auth/context';
import { getInvoice } from '@/server/ledger-queries';
import { getCompany } from '@/server/queries';
import { renderInvoicePdf } from '@/lib/pdf/invoice';
import { AppError } from '@/lib/errors';

/**
 * The GSTIN to print.
 *
 * A company may hold several, one per state it is registered in. The one that
 * belongs on the invoice is the registration for the state the supply is made
 * from; falling back to the only registration on file keeps a single-state
 * company working before its state is set.
 */
function gstinFor(
  registrations: readonly { kind: string; number: string; stateCode: string | null }[],
  stateCode: string | null,
): string | null {
  const gstins = registrations.filter((r) => r.kind === 'gstin');
  if (gstins.length === 0) return null;
  const forState = stateCode ? gstins.find((r) => r.stateCode === stateCode) : undefined;
  return (forState ?? gstins[0])?.number ?? null;
}

/**
 * The invoice PDF.
 *
 * Node runtime, not edge: the renderer reads the font files from disk and does
 * real layout work, neither of which belongs in an edge function.
 *
 * `getInvoice` applies the capability check and reads inside withTenant, so an
 * invoice id belonging to another company resolves to nothing and returns 404
 * — the same answer as an id that does not exist, since a 403 would confirm
 * that someone else holds it.
 */
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const ctx = await requireOrgContext();
    const [{ org, registrations }, { voucher, lines, party }] = await Promise.all([
      getCompany(ctx),
      getInvoice(ctx, id),
    ]);

    if (voucher.voucherType !== 'sales' && voucher.voucherType !== 'credit_note') {
      return NextResponse.json(
        { error: 'Only a sales invoice or a credit note prints as a tax invoice.' },
        { status: 400 },
      );
    }

    const pdf = await renderInvoicePdf({
      company: {
        legalName: org?.legalName ?? 'This company',
        tradeName: org?.tradeName ?? null,
        // The GSTIN lives in org_registrations rather than on the
        // organization, because a multi-state company holds one per state.
        // The invoice carries the registration for the state it supplies from.
        gstin: gstinFor(registrations, org?.stateCode ?? null),
        pan: org?.pan ?? null,
        stateCode: org?.stateCode ?? null,
      },
      voucher: {
        voucherNo: voucher.voucherNo,
        voucherDate: voucher.voucherDate,
        status: voucher.status,
        reference: voucher.reference,
        narration: voucher.narration,
        supplyType: voucher.supplyType,
        supplierStateCode: voucher.supplierStateCode,
        placeOfSupplyStateCode: voucher.placeOfSupplyStateCode,
        taxablePaise: voucher.taxablePaise,
        cgstPaise: voucher.cgstPaise,
        sgstPaise: voucher.sgstPaise,
        igstPaise: voucher.igstPaise,
        cessPaise: voucher.cessPaise,
        roundOffPaise: voucher.roundOffPaise,
        totalPaise: voucher.totalPaise,
      },
      party,
      lines,
    });

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(pdf.byteLength),
        'content-disposition': `inline; filename="${voucher.voucherNo.replace(/\//g, '-')}.pdf"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      const status =
        err.code === 'unauthenticated' || err.code === 'mfa_required'
          ? 401
          : err.code === 'forbidden'
            ? 403
            : err.code === 'not_found'
              ? 404
              : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error('[invoices:pdf]', err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
