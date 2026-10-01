import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { LogoMark } from '@/components/brand/Logo';
import styles from './shell.module.css';

export function TopBar() {
  return (
    <header className={styles.top}>
      {/* The whole mark, not the eye crop. A circle cropped to the eye read as
          a close-up photograph rather than a logo; the tear is the shape people
          recognise, and it only works whole. */}
      <Link className={styles.mark} href="/dashboard" aria-label="SherrByte — go to the dashboard">
        <LogoMark height={38} priority />
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
