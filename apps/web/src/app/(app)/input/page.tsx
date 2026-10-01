import { PageHeader } from '@/components/shell/PageHeader';
import { Band, EmptyState, Panel, Table, ui } from '@/components/ui';
import { can } from '@/lib/auth/permissions';
import { DECLARED_DOCUMENT_TYPE_LABELS, type DeclaredDocumentType } from '@/lib/db/schema';
import { getCompany } from '@/server/queries';
import { getDocuments } from '@/server/ledger-queries';
import { withContext } from '../_guard';
import { UploadPanel } from './UploadPanel';

export const dynamic = 'force-dynamic';

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export default async function InputPage() {
  return withContext(async (ctx) => {
    const [{ org }, documents] = await Promise.all([getCompany(ctx), getDocuments(ctx)]);

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
                  <th>By</th>
                  <th className={ui.right}>Size</th>
                  <th>State</th>
                </tr>
              }
            >
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>
                    <a href={`/api/documents/${doc.id}`}>{doc.originalFilename}</a>
                  </td>
                  <td>
                    {doc.declaredType ? (
                      DECLARED_DOCUMENT_TYPE_LABELS[doc.declaredType as DeclaredDocumentType]
                    ) : (
                      <span className={ui.hint}>Not tagged</span>
                    )}
                  </td>
                  <td>{dateTimeFmt.format(doc.createdAt)}</td>
                  <td>{doc.uploadedByName ?? doc.uploadedByEmail ?? '—'}</td>
                  <td className={`${ui.right} tnum`}>{formatBytes(doc.byteSize)}</td>
                  <td>{STATE_LABELS[doc.status] ?? doc.status}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <p className={ui.hint} style={{ marginTop: 18 }}>
          Storing a document changes no number. Reading the fields out of it, checking them and
          turning them into a draft voucher is a later step; until then these are files, and the
          books are unaffected by them.
        </p>
      </>
    );
  });
}

const STATE_LABELS: Record<string, string> = {
  stored: 'Stored',
  extracting: 'Reading',
  extracted: 'Read, awaiting review',
  needs_review: 'Needs review',
  posted: 'Posted',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

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
