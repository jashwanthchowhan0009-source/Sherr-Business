import Link from 'next/link';
import { PageHeader } from '@/components/shell/PageHeader';
import { Band, EmptyState, Panel, StatusPill, Table, ui } from '@/components/ui';
import { can } from '@/lib/auth/permissions';
import { DECLARED_DOCUMENT_TYPE_LABELS, type DeclaredDocumentType } from '@/lib/db/schema';
import { getCompany } from '@/server/queries';
import { extractionConfigured, getInbox } from '@/server/inbox-queries';
import { withContext } from '../_guard';
import { UploadPanel } from './UploadPanel';
import { ExtractButton } from './ExtractButton';

export const dynamic = 'force-dynamic';

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export default async function InputPage() {
  return withContext(async (ctx) => {
    const [{ org }, documents] = await Promise.all([getCompany(ctx), getInbox(ctx)]);
    const aiReady = extractionConfigured();
    const mayExtract = can(ctx.role, 'document:extract');

    return (
      <>
        <PageHeader
          title="Input"
          subtitle="Collect and extract — documents in, structured fields out."
        />

        <UploadPanel
          readOnly={!can(ctx.role, 'document:upload')}
          inboxEmail={inboxAddressFor(org?.tradeName ?? org?.legalName ?? null)}
        />

        <Band>
          {documents.length === 0
            ? 'Document inbox'
            : `Document inbox — ${documents.length} stored`}
        </Band>

        {!aiReady ? (
          <p className={ui.hint} style={{ marginTop: 0, marginBottom: 16 }}>
            No AI reader is configured, so documents are stored but not read. Add{' '}
            <code>GEMINI_API_KEY</code> to the environment to turn reading on. Everything here can
            still be entered by hand from the Process page — the inbox is a shortcut, not the only
            way in.
          </p>
        ) : (
          <p className={ui.hint} style={{ marginTop: 0, marginBottom: 16 }}>
            Reading a document sends it to Google Gemini. On a free-tier key, use only your own
            demo documents — never a real client&apos;s papers.
          </p>
        )}

        <Panel bodyless>
          {documents.length === 0 ? (
            <div className={ui.panelBody}>
              <EmptyState title="Nothing uploaded yet">
                Drop a file above and it will appear here. Files are stored privately; only
                people in this company can open them.
              </EmptyState>
            </div>
          ) : (
            <Table
              head={
                <tr>
                  <th>Document</th>
                  <th>You said it is</th>
                  <th>Uploaded</th>
                  <th className={ui.right}>Size</th>
                  <th>Reading</th>
                  <th>Next</th>
                </tr>
              }
            >
              {documents.map((doc) => {
                const state = readingState(doc);
                return (
                  <tr key={doc.documentId}>
                    <td>
                      <a href={`/api/documents/${doc.documentId}`}>{doc.originalFilename}</a>
                    </td>
                    <td>
                      {doc.declaredType ? (
                        DECLARED_DOCUMENT_TYPE_LABELS[doc.declaredType as DeclaredDocumentType]
                      ) : (
                        <span className={ui.hint}>Not tagged</span>
                      )}
                    </td>
                    <td>{dateTimeFmt.format(new Date(doc.uploadedAt))}</td>
                    <td className={`${ui.right} tnum`}>{formatBytes(BigInt(doc.byteSize))}</td>
                    <td>
                      <StatusPill status={state.tone}>{state.label}</StatusPill>
                      {state.detail ? (
                        <>
                          <br />
                          <span className={ui.hint}>{state.detail}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {doc.voucherId ? (
                        <Link href="/process">
                          {doc.voucherNo} — {doc.voucherStatus === 'posted' ? 'posted' : 'draft, post it'}
                        </Link>
                      ) : doc.extractionStatus === 'succeeded' ||
                        doc.extractionStatus === 'reviewed' ? (
                        <Link className={ui.buttonGhost} href={`/input/review/${doc.extractionId}`}>
                          Review
                        </Link>
                      ) : (
                        <ExtractButton
                          documentId={doc.documentId}
                          label={doc.extractionStatus === 'failed' ? 'Read again' : 'Read with AI'}
                          disabled={!aiReady || !mayExtract}
                          disabledReason={
                            !mayExtract
                              ? 'Your role cannot run a reading'
                              : 'Needs an AI key'
                          }
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Panel>

        <p className={ui.hint} style={{ marginTop: 18 }}>
          Storing a document changes no number, and neither does reading it. A reading produces
          claims about a document and our own arithmetic beside them; a person checks both and
          approves, which creates a <b>draft</b> voucher. Posting it — the act that puts a figure
          into the books — is still a separate, deliberate step. Nothing on this page can post.
        </p>
      </>
    );
  });
}

/**
 * What stage a document has reached, in a bookkeeper's words.
 *
 * The one state worth naming precisely is an approved reading: it has produced a
 * **draft**, and the row says so, because the difference between a draft and a
 * posting is the difference between a figure that is in the books and one that is
 * not.
 */
function readingState(doc: {
  extractionStatus: string | null;
  failureReason: string | null;
  validation: unknown;
  voucherStatus: string | null;
}): { label: string; tone: 'verified' | 'provisional' | 'draft'; detail: string | null } {
  if (doc.extractionStatus === null) {
    return { label: 'Not read', tone: 'draft', detail: null };
  }
  if (doc.extractionStatus === 'failed') {
    return { label: 'Could not read', tone: 'provisional', detail: doc.failureReason };
  }
  if (doc.extractionStatus === 'rejected') {
    return { label: 'Rejected', tone: 'draft', detail: doc.failureReason };
  }
  if (doc.extractionStatus === 'approved') {
    return {
      label: doc.voucherStatus === 'posted' ? 'Posted' : 'Draft voucher',
      tone: doc.voucherStatus === 'posted' ? 'verified' : 'provisional',
      detail: doc.voucherStatus === 'posted' ? null : 'Somebody still has to post it',
    };
  }

  const blockers = countBlockers(doc.validation);
  return {
    label: doc.extractionStatus === 'reviewed' ? 'Review saved' : 'Needs review',
    tone: 'provisional',
    detail:
      blockers > 0
        ? `${blockers} thing${blockers === 1 ? '' : 's'} to resolve`
        : 'Nothing blocking — still needs a person',
  };
}

function countBlockers(validation: unknown): number {
  if (validation === null || typeof validation !== 'object') return 0;
  const findings = (validation as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return 0;
  return findings.filter((f) => (f as { severity?: string }).severity === 'blocker').length;
}

/**
 * The forwarding address shown on the panel.
 *
 * Derived from the company name so the screen reads like the reference design
 * rather than showing a placeholder. Inbound email is not built: the address is
 * presented as where bills will be forwarded once it is, and it is labelled as
 * such on the page rather than implied to work today.
 */
function inboxAddressFor(name: string | null): string {
  const slug = (name ?? 'company')
    .toLowerCase()
    .replace(/\[mock\]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 18);
  return `${slug || 'company'}@in.sherrbyte.com`;
}

function formatBytes(bytes: bigint): string {
  const kb = Number(bytes) / 1024;
  if (kb < 1) return `${bytes} B`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
