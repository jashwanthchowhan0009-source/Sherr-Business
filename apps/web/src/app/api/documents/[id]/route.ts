import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { requireOrgContext } from '@/lib/auth/context';
import { can } from '@/lib/auth/permissions';
import { withTenant } from '@/lib/db/tenant';
import { documents } from '@/lib/db/schema';
import { storage } from '@/lib/storage';
import { AppError } from '@/lib/errors';

/**
 * The only route that hands a stored document back to a browser.
 *
 * Three gates, in this order, because each is necessary and none implies the
 * others:
 *   1. an authenticated session with an active organization and MFA satisfied;
 *   2. the `document:read` capability for the caller's role;
 *   3. the row read inside `withTenant`, so RLS resolves the document against
 *      the caller's own organization. A document id from another company
 *      simply does not exist as far as this query is concerned.
 *
 * The blob itself is private, so this route is not merely obscuring a public
 * URL — there is no URL that works without it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const ctx = await requireOrgContext();
    if (!can(ctx.role, 'document:read')) {
      return NextResponse.json({ error: 'Not permitted.' }, { status: 403 });
    }

    const row = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
      const [found] = await tx.select().from(documents).where(eq(documents.id, id));
      return found ?? null;
    });

    // Deliberately the same answer as a document that does not exist: a 403
    // here would confirm that some other company holds this id.
    if (!row) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }

    const bytes = await (await storage()).get(row.storageKey);

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': row.mimeType,
        'content-length': String(bytes.byteLength),
        // `inline` would let a crafted SVG or HTML file run in the app's own
        // origin. Everything here downloads.
        'content-disposition': `attachment; filename="${sanitizeFilename(row.originalFilename)}"`,
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
    console.error('[documents:get]', err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

/**
 * The filename is attacker-controlled text that is about to be placed inside a
 * quoted header value, so anything that could terminate the quoting or inject a
 * header is removed rather than escaped.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\-() ]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'document';
}
