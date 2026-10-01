import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { LogoGlyph } from '@/components/brand/Logo';
import styles from './shell.module.css';

export function TopBar() {
  return (
    <header className={styles.top}>
      {/* Home, as a logo in the top-left is expected to be. It was a bare
          letter in a circle before, which looked like a brand mark and did
          nothing when clicked. */}
      <Link className={styles.mark} href="/dashboard" aria-label="SherrByte — go to the dashboard">
        <LogoGlyph size={42} priority />
      </Link>
      <button className={styles.cmd} type="button" disabled title="Available in a later phase">
        <span className={styles.cmdText}>
          Search invoices, customers, reports — or type an action
        </span>
        <span className={styles.kbd}>⌘K</span>
      </button>
      {/* Account settings and sign-out. Without this there is no route to
          either, which previously stranded anyone who got past the MFA gate. */}
      <UserButton />
    </header>
  );
}
