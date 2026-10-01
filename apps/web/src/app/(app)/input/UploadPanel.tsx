'use client';

import { useRef, useState, useTransition, type ChangeEvent, type DragEvent } from 'react';
import { ui } from '@/components/ui';
import {
  DECLARED_DOCUMENT_TYPES,
  DECLARED_DOCUMENT_TYPE_LABELS,
  type DeclaredDocumentType,
} from '@/lib/db/schema';
import { uploadDocument } from '@/server/documents';

const MAX_MB = 10;

/**
 * The upload panel from the Input reference screen: blue-glowing container,
 * dashed drop target, input-type chips beneath.
 *
 * Files are read in the browser and sent as base64 through the server action,
 * which is what keeps the upload inside the same permission, rate-limit and
 * audit path as every other mutation. It costs a third in transfer size, which
 * at a 10 MB ceiling is an acceptable price for not having a second,
 * separately-guarded write path into the system.
 */
export function UploadPanel({ readOnly, inboxEmail }: { readOnly: boolean; inboxEmail: string }) {
  const [declaredType, setDeclaredType] = useState<DeclaredDocumentType | null>(null);
  const [dragging, setDragging] = useState(false);
  const [messages, setMessages] = useState<{ kind: 'ok' | 'err'; text: string }[]>([]);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const send = (files: FileList | null) => {
    if (!files || files.length === 0 || readOnly) return;
    const chosen = [...files];

    startTransition(async () => {
      const results: { kind: 'ok' | 'err'; text: string }[] = [];

      for (const file of chosen) {
        if (file.size > MAX_MB * 1024 * 1024) {
          results.push({
            kind: 'err',
            text: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MB} MB.`,
          });
          continue;
        }

        const contentBase64 = await toBase64(file);
        const result = await uploadDocument({
          originalFilename: file.name,
          // Browsers leave this empty for some files; the server rejects an
          // unaccepted type either way, so an empty string fails cleanly.
          mimeType: file.type,
          contentBase64,
          ...(declaredType ? { declaredType } : {}),
        });

        results.push(
          result.ok
            ? { kind: 'ok', text: `${file.name} stored.` }
            : { kind: 'err', text: `${file.name}: ${result.error}` },
        );
      }

      setMessages(results);
      if (inputRef.current) inputRef.current.value = '';
    });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    send(event.dataTransfer.files);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => send(event.target.files);

  return (
    <>
      <div className={ui.drop}>
        <label className={ui.targetLabel}>
          <input
            ref={inputRef}
            className={ui.fileInput}
            type="file"
            multiple
            disabled={readOnly || pending}
            onChange={onChange}
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.csv,.xls,.xlsx"
          />
          <div
            className={[
              ui.target,
              dragging ? ui.targetHot : '',
              pending ? ui.targetBusy : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onDragOver={(e) => {
              e.preventDefault();
              if (!readOnly) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div>
              <div className={ui.targetTitle}>
                {pending ? 'Uploading…' : 'Upload'}
                <CloudGlyph />
              </div>
              <div className={ui.targetHint}>
                {readOnly
                  ? 'Your role can read documents but not add them.'
                  : 'Drop files here, or click to choose them'}
              </div>
              <div className={ui.targetHint}>
                PDF, image, CSV or Excel · up to {MAX_MB} MB each
              </div>
              {/* The design shows a forwarding address here. It is shown, but
                  stated as not yet live: the panel must not imply that mail
                  sent to it would arrive. */}
              <div className={ui.targetHint} style={{ color: 'var(--sb-text-3)' }}>
                Forwarding bills to <b>{inboxEmail}</b> arrives with the AI document inbox
              </div>
            </div>
          </div>
        </label>

        <div className={ui.chips} role="group" aria-label="Input type">
          {DECLARED_DOCUMENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={ui.chip}
              aria-pressed={declaredType === type}
              onClick={() => setDeclaredType(declaredType === type ? null : type)}
            >
              {DECLARED_DOCUMENT_TYPE_LABELS[type]}
            </button>
          ))}
        </div>

        <p className={ui.chipHint}>
          {declaredType
            ? `Tagging uploads as ${DECLARED_DOCUMENT_TYPE_LABELS[declaredType]}. This is recorded as what you said it is — nothing is read from the file yet.`
            : 'Optional: tag what you are uploading. Files are stored either way.'}
        </p>
      </div>

      {messages.length > 0 ? (
        <ul className={ui.actions} aria-live="polite" style={{ display: 'grid', gap: 6 }}>
          {messages.map((m, i) => (
            <li key={i} className={m.kind === 'ok' ? ui.statusOk : ui.statusErr}>
              {m.text}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Reads a File into base64 without loading it twice. */
async function toBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) overflows the call stack on a file
  // of any real size.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function CloudGlyph() {
  return (
    <svg width="38" height="26" viewBox="0 0 38 26" fill="none" aria-hidden="true">
      <path
        d="M10 20h18a6 6 0 0 0 .6-11.97A9 9 0 0 0 11.2 6.4A5.8 5.8 0 0 0 10 20Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M19 17V8m0 0-3.4 3.4M19 8l3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
