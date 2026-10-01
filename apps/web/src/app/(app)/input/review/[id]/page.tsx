import Link from 'next/link';
import { PageHeader } from '@/components/shell/PageHeader';
import { Band, EmptyState, Panel, StatusPill, ui } from '@/components/ui';
import { can } from '@/lib/auth/permissions';
import { formatRupees, paise } from '@/lib/money';
import { CONFIDENCE_FLOOR } from '@/lib/ai/contract';
import { getExtractionForReview } from '@/server/inbox-queries';
import { withContext } from '../../../_guard';
import { ReviewForm } from './ReviewForm';
import { DocumentPane } from './DocumentPane';

export const dynamic = 'force-dynamic';

/**
 * Reviewing what the model read.
 *
 * Side by side on purpose: the document on one side, the fields on the other, so
 * checking a figure is a glance rather than a memory test. Everything on the right
 * is editable, and what the reviewer leaves there is what becomes the voucher —
 * the model's own values are shown beside each field, never silently adopted.
 *
 * Approving creates a draft. It cannot post, and the page says so where the button
 * is, not in a footnote.
 */
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return withContext(async (ctx) => {
    const { id } = await params;
    const view = await getExtractionForReview(ctx, id);

    const blockers = view.validation?.findings.filter((f) => f.severity === 'blocker') ?? [];
    const checks = view.validation?.findings.filter((f) => f.severity === 'check') ?? [];
    const notes = view.validation?.findings.filter((f) => f.severity === 'note') ?? [];

    return (
      <>
        <PageHeader
          title="Review"
          subtitle={`${view.document.originalFilename} — read by ${view.model}, prompt ${view.promptVersion}.`}
        />

        <p className={ui.hint} style={{ marginTop: -8, marginBottom: 20 }}>
          <Link href="/input">← Back to the inbox</Link>
        </p>

        {view.status === 'failed' ? (
          <Panel title="This reading failed">
            <p className={ui.statusErr}>{view.failureReason}</p>
            <p className={ui.hint}>
              Nothing was stored except the failure itself. Try reading it again from the inbox, or
              enter the bill by hand on the Process page.
            </p>
          </Panel>
        ) : view.status === 'approved' ? (
          <Panel title="Already approved">
            <p className={ui.statusOk}>
              This became a draft voucher. It is not in the books until somebody posts it.
            </p>
            <p className={ui.hint}>
              <Link href="/process">Open the Process page to post it →</Link>
            </p>
          </Panel>
        ) : view.extracted === null ? (
          <Panel title="Nothing to review">
            <EmptyState title="This document has not been read">
              Run a reading from the inbox first.
            </EmptyState>
          </Panel>
        ) : (
          <>
            {view.duplicate ? (
              <Panel title="This bill may already be entered">
                <p className={ui.statusErr}>
                  {view.duplicate.voucherNo} dated {view.duplicate.voucherDate} is already posted
                  with this supplier and invoice number. Entering it again would mean paying it
                  twice. Approving will be refused unless the invoice number is genuinely different.
                </p>
              </Panel>
            ) : null}

            {/* What a person must resolve, before the fields rather than after:
                a reviewer who reads the figures first has already formed a view. */}
            <Band>
              {blockers.length === 0
                ? 'Nothing blocking — a person still has to check it'
                : `${blockers.length} thing${blockers.length === 1 ? '' : 's'} to resolve`}
            </Band>
            <Panel
              title="What our own checks found"
              note="The model reported what it read. These are our figures computed from the same lines, and where the two disagree."
            >
              {view.validation === null ? (
                <p className={ui.hint}>No checks were recorded for this reading.</p>
              ) : (
                <>
                  {blockers.map((f, i) => (
                    <p key={`b${i}`} className={ui.statusErr}>
                      {f.field ? <code>{f.field}</code> : null} {f.message}
                    </p>
                  ))}
                  {checks.map((f, i) => (
                    <p key={`c${i}`} className={ui.hint}>
                      <StatusPill status="provisional">Check</StatusPill>{' '}
                      {f.field ? <code>{f.field}</code> : null} {f.message}
                    </p>
                  ))}
                  {notes.map((f, i) => (
                    <p key={`n${i}`} className={ui.hint}>
                      {f.message}
                    </p>
                  ))}
                  {view.validation.findings.length === 0 ? (
                    <p className={ui.statusOk}>
                      Our arithmetic agrees with the document on every figure. That is not approval
                      — it means there is nothing obviously wrong.
                    </p>
                  ) : null}

                  {view.validation.computed ? (
                    <p className={ui.hint} style={{ marginTop: 12 }}>
                      Computed from the lines by the same GST engine a hand-typed invoice uses:
                      taxable {formatRupees(paise(view.validation.computed.taxablePaise))}, CGST{' '}
                      {formatRupees(paise(view.validation.computed.cgstPaise))}, SGST{' '}
                      {formatRupees(paise(view.validation.computed.sgstPaise))}, IGST{' '}
                      {formatRupees(paise(view.validation.computed.igstPaise))}, total{' '}
                      {formatRupees(paise(view.validation.computed.totalPaise))}.
                    </p>
                  ) : null}
                </>
              )}
            </Panel>

            <Band>The document, and what was read from it</Band>

            {/* Two columns on a wide screen, stacked on a narrow one. A review on a
                phone is still a review; it just scrolls. */}
            <div className={ui.reviewSplit}>
              <DocumentPane
                documentId={view.documentId}
                mimeType={view.document.mimeType}
                filename={view.document.originalFilename}
              />

              <ReviewForm
                extractionId={view.extractionId}
                extracted={view.extracted}
                reviewed={view.reviewed}
                parties={view.parties}
                suggestedParty={view.suggestedParty}
                companyStateCode={view.company.stateCode}
                lockedUpto={view.lockedUpto}
                confidenceFloor={CONFIDENCE_FLOOR}
                readOnly={!can(ctx.role, 'voucher:draft')}
              />
            </div>
          </>
        )}

        <p className={ui.hint} style={{ marginTop: 24 }}>
          The model read this document; it did not compute anything. Every figure above was either
          transcribed from the page or worked out by this product&apos;s own GST engine from the
          lines you can see. Approving records your name against these values and creates a draft.
        </p>
      </>
    );
  });
}
