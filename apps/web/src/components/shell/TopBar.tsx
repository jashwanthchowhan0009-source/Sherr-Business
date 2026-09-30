import styles from './shell.module.css';

export function TopBar() {
  return (
    <header className={styles.top}>
      <div className={styles.mark} aria-hidden="true">
        S
      </div>
      <button className={styles.cmd} type="button" disabled title="Available in a later phase">
        <span className={styles.cmdText}>
          Search invoices, customers, reports — or type an action
        </span>
        <span className={styles.kbd}>⌘K</span>
      </button>
    </header>
  );
}
