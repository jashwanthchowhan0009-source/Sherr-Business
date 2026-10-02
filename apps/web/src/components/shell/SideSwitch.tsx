'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HomeIcon, ProfileIcon } from './icons';
import styles from './shell.module.css';

/**
 * Which half of the app you are in, in the corner where you can always see it.
 *
 * The app has two sides: Home is the working pipeline (Input, Process, Output)
 * and Profile is the company itself (Dashboard, People, Data). The dock at the
 * bottom already switches between them, but it shows the three pages of
 * whichever side you are on — so nothing on screen answered "which half am I
 * in?" without reading the page names and knowing which list they belong to.
 *
 * Two icons, the current one lit. It is both the answer and the way across.
 */
const HOME_PREFIXES = ['/input', '/process', '/output'];

export function SideSwitch() {
  const pathname = usePathname() ?? '';
  const onHome = HOME_PREFIXES.some((p) => pathname.startsWith(p));

  return (
    <nav className={styles.sides} aria-label="Section">
      <Link
        href="/input"
        className={`${styles.side} ${onHome ? styles.sideOn : ''}`}
        aria-current={onHome ? 'page' : undefined}
        title="Home — Input, Process, Output"
      >
        <HomeIcon width={18} height={18} />
        <span className={styles.sideLabel}>Home</span>
      </Link>
      <Link
        href="/dashboard"
        className={`${styles.side} ${onHome ? '' : styles.sideOn}`}
        aria-current={onHome ? undefined : 'page'}
        title="Profile — Dashboard, People, Data"
      >
        <ProfileIcon width={18} height={18} />
        <span className={styles.sideLabel}>Profile</span>
      </Link>
    </nav>
  );
}
