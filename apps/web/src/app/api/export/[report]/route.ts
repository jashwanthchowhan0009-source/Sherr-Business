import { NextResponse } from 'next/server';
import { requireOrgContext } from '@/lib/auth/context';
import { AppError, invalidInput, notFound } from '@/lib/errors';
import { toCsvFile, toKeyed } from '@/lib/export/write';
import {
  gstr1Export,
  gstr1HsnExport,
  gstr2bExport,
  gstr3bExport,
  setOffExport,
  taxRulesExport,
  tdsPayableExport,
  tdsRulesExport,
  type ExportFile,
} from '@/lib/export/tax-exports';
import {
  getGstr1,
  getGstr3b,
  getStoredGstr2bRecon,
  getTaxRuleStatus,
  getTdsPayable,
  getTdsRules,
} from '@/server/gst-queries';

/**
 * Taking a working out of the product.
 *
 * Node runtime: every builder reads through `withTenant`, which needs a real
 * Postgres connection and a transaction-scoped setting.
 *
 * The capability check is not done here. Each query function applies its own and
 * reads inside the tenant transaction, so a request with no right to a figure
 * never reaches the row — the export cannot be a way around a permission, because
 * it goes through the same door the page does.
 */
export const runtime = 'nodejs';

const isIso = (v: string | null): v is string => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

export async function GET(
  request: Request,
  { params }: { params: Promise<{ report: string }> },
) {
  const { report } = await params;
  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';

  try {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isIso(from) || !isIso(to)) {
      throw invalidInput('Give a period as from=YYYY-MM-DD&to=YYYY-MM-DD.');
    }
    if (to < from) throw invalidInput('The period must end on or after it starts.');

    const ctx = await requireOrgContext();
    const period = { from, to };

    let file: ExportFile;
    switch (report) {
      case 'gstr1':
        file = gstr1Export(await getGstr1(ctx, period));
        break;
      case 'gstr1-hsn':
        file = gstr1HsnExport(await getGstr1(ctx, period));
        break;
      case 'gstr3b':
        file = gstr3bExport(await getGstr3b(ctx, period));
        break;
      case 'gstr3b-setoff':
        file = setOffExport(await getGstr3b(ctx, period));
        break;
      case 'gstr2b': {
        const recon = await getStoredGstr2bRecon(ctx, period);
        if (!recon) {
          throw notFound('No GSTR-2B has been uploaded for that period.');
        }
        file = gstr2bExport(recon.reconciliation, period, recon.uploadedAt);
        break;
      }
      case 'tds-payable':
        file = tdsPayableExport(await getTdsPayable(ctx, to), period);
        break;
      case 'tds-rules':
        file = tdsRulesExport(await getTdsRules(ctx), period);
        break;
      case 'tax-rules':
        file = taxRulesExport(await getTaxRuleStatus(ctx), period);
        break;
      default:
        throw notFound(`There is no export called ${report}.`);
    }

    const body =
      format === 'json'
        ? // The same tables keyed by their own column names, so a reader does not
          // have to know that column seven is SGST. Both writers walk one declared
          // structure, so a figure cannot differ between the two files.
          JSON.stringify(toKeyed(file), null, 2)
        : toCsvFile(file);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type':
          format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        // An attachment, never inline: a CSV rendered in the browser invites the
        // text to be read as markup, and these files contain supplier names.
        'content-disposition': `attachment; filename="${safeName(file.filename)}.${format}"`,
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
    console.error('[export]', err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

/** A filename safe in a Content-Disposition header. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120) || 'export';
}
