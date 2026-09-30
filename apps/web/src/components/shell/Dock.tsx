'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './shell.module.css';
import {
  DashboardIcon, DataIcon, InputIcon, OutputIcon, PeopleIcon, ProcessIcon,
} from './icons';

/**
 * The two-sided navigation from the reference screens: a three-segment dock,
 * and a toggle beneath it that switches which three.
 *
 * Workspace is the pipeline (Input -> Process -> Output); Company is the context
 * (Dashboard, People, Data). A user is always in one of those two modes.
 */
const SIDES = {
  workspace: [
    { href: '/input', label: 'Input', Icon: InputIcon },
    { href: '/process', label: 'Process', Icon: ProcessIcon },
    { href: '/output', label: 'Output', Icon: OutputIcon },
  ],
  company: [
    { href: '/dashboard', label: 'Dashboard', Icon: DashboardIcon },
    { href: '/people', label: 'People', Icon: PeopleIcon },
    { href: '/data', label: 'Data', Icon: DataIcon },
  ],
} as const;

type Side = keyof typeof SIDES;

function sideFor(pathname: string): Side {
  return SIDES.workspace.some((s) => pathname.startsWith(s.href)) ? 'workspace' : 'company';
}

export function Dock() {
  const pathname = usePathname();
  const side = sideFor(pathname);
  const segments = SIDES[side];

  return (
    <div className={styles.dockWrap}>
      <nav className={styles.dock} aria-label="Section">
        {segments.map(({ href, label, Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`${styles.seg} ${active ? styles.segActive : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className={styles.sideToggle} role="group" aria-label="Switch side">
        <Link
          href={SIDES.workspace[0].href}
          aria-label="Workspace"
          aria-current={side === 'workspace' ? 'true' : undefined}
        >
          <span
            className={`${styles.sideDot} ${side === 'workspace' ? styles.sideDotActive : ''}`}
          />
        </Link>
        <Link
          href={SIDES.company[0].href}
          aria-label="Company"
          aria-current={side === 'company' ? 'true' : undefined}
        >
          <span className={`${styles.sideDot} ${side === 'company' ? styles.sideDotActive : ''}`} />
        </Link>
      </div>
    </div>
  );
}
