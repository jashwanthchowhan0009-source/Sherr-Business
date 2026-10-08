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
      {subtitle ? <p className={styles.sub}>{subtitle}</p> : null}
    </>
  );
}

/**
 * The trust ribbon from docs/03-OWNER-DASHBOARD-SPEC.md §2.
 * In Phase 1 it reports what Phase 1 actually knows: connected sources and
 * reconciliation state arrive with the modules that produce them.
 */
export function TrustRibbon({ items }: { items: { tone: 'ok' | 'warn' | 'crit'; node: ReactNode }[] }) {
  const toneClass = { ok: styles.dotOk, warn: styles.dotWarn, crit: styles.dotCrit };
  return (
    <div className={styles.ribbon}>
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 ? <span className={styles.sep}>·</span> : null}
          <span className={`${styles.dot} ${toneClass[item.tone]}`} />
          {item.node}
        </span>
      ))}
    </div>
  );
}
