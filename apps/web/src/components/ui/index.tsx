import type { ReactNode } from 'react';
import styles from './ui.module.css';

export function Panel({
  title, note, children, bodyless,
}: { title?: string; note?: string; children: ReactNode; bodyless?: boolean }) {
  return (
    <section className={styles.panel}>
      {title ? (
        <header className={styles.panelHead}>
          <h2 className={styles.panelTitle}>{title}</h2>
          {note ? <span className={styles.panelNote}>{note}</span> : null}
        </header>
      ) : null}
      {bodyless ? children : <div className={styles.panelBody}>{children}</div>}
    </section>
  );
}

export function Band({ children }: { children: ReactNode }) {
  return <div className={styles.band}>{children}</div>;
}

export type MetricStatus = 'verified' | 'provisional' | 'draft';

export function StatusPill({ status, children }: { status: MetricStatus; children: ReactNode }) {
  const cls = {
    verified: styles.pillVerified,
    provisional: styles.pillProvisional,
    draft: styles.pillDraft,
  }[status];
  return <span className={`${styles.pill} ${cls}`}>{children}</span>;
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className={styles.cards}>{children}</div>;
}

/**
 * A metric card. `status` is required, not optional: docs/03 §4 makes an
 * unlabelled number a defect, because a reader cannot tell a settled figure
 * from a provisional one without it.
 */
export function DataCard({
  label, value, caption, status,
}: { label: string; value: string; caption: string; status?: MetricStatus }) {
  return (
    <article className={styles.card}>
      <div className={styles.cardHead}>
        {status && status !== 'verified' ? (
          <StatusPill status={status}>{status}</StatusPill>
        ) : null}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardLabel}>{label}</div>
        <div className={`${styles.cardValue} tnum`}>{value}</div>
        <div className={styles.cardCaption}>{caption}</div>
      </div>
    </article>
  );
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Empty states name a cause and an action. Never just "No data". */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      <p className={styles.emptyBody}>{children}</p>
    </div>
  );
}

export { styles as ui };
