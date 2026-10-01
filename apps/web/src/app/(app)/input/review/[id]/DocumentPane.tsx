'use client';

import { useState } from 'react';
import { Panel, ui } from '@/components/ui';

/**
 * The document itself, beside the fields read from it.
 *
 * A PDF goes in an iframe and an image in an `img`, because a browser renders both
 * natively and a viewer library would be a dependency, a bundle and a second thing
 * to keep current for no gain. Anything else falls back to a download link rather
 * than an empty frame that looks broken.
 */
export function DocumentPane({
  documentId,
  mimeType,
  filename,
}: {
  documentId: string;
  mimeType: string;
  filename: string;
}) {
  const [failed, setFailed] = useState(false);
  const href = `/api/documents/${documentId}`;
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  return (
    <div className={ui.reviewSticky}>
      <Panel title="The document" note={filename}>
        {failed || (!isImage && !isPdf) ? (
          <p className={ui.hint}>
            This file cannot be shown in the browser.{' '}
            <a href={href} download>
              Download {filename}
            </a>{' '}
            to check the figures against it.
          </p>
        ) : isPdf ? (
          <iframe className={ui.docFrame} src={href} title={filename} onError={() => setFailed(true)} />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element --
             a private, authenticated, same-origin document. next/image would try
             to fetch and cache it through the optimiser, which has no session. */
          <img className={ui.docImage} src={href} alt={filename} onError={() => setFailed(true)} />
        )}
        <p className={ui.hint}>
          <a href={href} target="_blank" rel="noreferrer">
            Open full size in a new tab
          </a>
        </p>
      </Panel>
    </div>
  );
}
