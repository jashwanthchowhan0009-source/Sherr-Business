import type { ReactNode } from 'react';
import styles from './shell.module.css';

export function PageHeader({
  title,
  subtitle,
  badge,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
}) {
  return (
    <>
      <div className={styles.head}>
        <h1 className={styles.title}>{title}</h1>
        {badge}
      </div>
      {subtitle ? <p className={styles.sub}>{subtitle}</p> : <div style={{ height: 20 }} />}
    </>
  );
}

/**
 * The trust ribbon from docs/03-OWNER-DASHBOARD-SPEC.md §2: what can be relied on
 * in the figures below, stated as facts.
 */
export function TrustRibbon({ items }: { items: { tone: 'ok' | 'warn' | 'crit'; node: ReactNode }[] }) {
  const toneClass = { ok: styles.dotOk, warn: styles.dotWarn, crit: styles.dotCrit };
  return (
    <div className={styles.ribbon}>
      {items.map((item, i) => (
        <span key={i} className={styles.ribbonItem}>
          <span className={`${styles.dot} ${toneClass[item.tone]}`} />
          {item.node}
        </span>
      ))}
    </div>
  );
}
