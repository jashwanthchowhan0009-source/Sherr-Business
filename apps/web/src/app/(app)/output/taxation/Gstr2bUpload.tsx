'use client';

import { useRef, useState, useTransition } from 'react';
import { ui } from '@/components/ui';
import { uploadGstr2b } from '@/server/gst';

/**
 * Uploading the GSTR-2B JSON the portal downloads.
 *
 * Nothing is posted and no credit is claimed or reversed. The output is a list of
 * differences between what suppliers filed and what the books record, and what
 * each difference means for the credit already taken.
 */
export function Gstr2bUpload({
  periodFrom,
  periodTo,
  readOnly,
}: {
  periodFrom: string;
  periodTo: string;
  readOnly: boolean;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [problems, setProblems] = useState<{ path: string; reason: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  if (readOnly) {
    return (
      <p className={ui.hint}>
        Your role can read the reconciliation but not upload a file.
      </p>
    );
  }

  return (
    <>
      <p className={ui.hint} style={{ marginTop: 0 }}>
        The JSON file from the portal, not a spreadsheet or a PDF. Input tax credit may only be
        claimed on what appears in GSTR-2B, so the difference between it and your purchase register
        is the difference between the credit you have taken and the credit you are entitled to.
      </p>

      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="g2b-file">GSTR-2B JSON</label>
          <input
            ref={fileRef}
            className={ui.input}
            id="g2b-file"
            type="file"
            accept=".json,application/json"
            disabled={pending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setMessage(null);
              setProblems([]);
              start(async () => {
                const buffer = await file.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = '';
                const CHUNK = 0x8000;
                for (let i = 0; i < bytes.length; i += CHUNK) {
                  binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
                }
                const result = await uploadGstr2b({
                  periodFrom,
                  periodTo,
                  contentBase64: btoa(binary),
                });
                if (result.ok) {
                  setProblems(result.data.problems);
                  setMessage({
                    tone: 'ok',
                    text:
                      `${result.data.invoicesRead} invoices read` +
                      (result.data.period ? ` for period ${result.data.period}` : '') +
                      '. The reconciliation below is now against this file.',
                  });
                } else {
                  setMessage({ tone: 'err', text: result.error });
                }
                if (fileRef.current) fileRef.current.value = '';
              });
            }}
          />
          <p className={ui.hint}>
            Reconciled against {periodFrom} to {periodTo}.
          </p>
        </div>
      </div>

      {message ? (
        <p className={message.tone === 'ok' ? ui.statusOk : ui.statusErr} aria-live="polite">
          {message.text}
        </p>
      ) : null}

      {problems.length > 0 ? (
        <>
          <p className={ui.hint} style={{ marginTop: 12 }}>
            {problems.length} {problems.length === 1 ? 'record' : 'records'} could not be read.
            Nothing was guessed — a silently dropped invoice is a silently lost credit.
          </p>
          <ul className={ui.hint}>
            {problems.map((p, i) => (
              <li key={i}>
                <code>{p.path}</code>: {p.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
