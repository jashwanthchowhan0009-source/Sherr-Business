'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UserButton, useOrganization } from '@clerk/nextjs';
import { LogoGlyph } from '@/components/brand/Logo';
import { CREATE_ACTIONS, NAV, flatDestinations, type NavGroup } from './nav';
import { ChevronIcon, CloseIcon, MenuIcon, PlusIcon, SearchIcon } from './icons';
import styles from './shell.module.css';

/**
 * The working frame: a quiet navigation rail on the left, a slim header with
 * search and "Create" on top, and the page beneath.
 *
 * On a narrow screen the rail becomes a drawer behind the menu button; the page
 * itself restructures in its own CSS rather than being shrunk.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const hash = useHash();
  const [menuOpen, setMenuOpen] = useState(false);

  // A navigation closes the drawer — the reader went where they meant to.
  useEffect(() => setMenuOpen(false), [pathname, hash]);

  return (
    <div className={styles.frame}>
      <aside
        className={`${styles.rail} ${menuOpen ? styles.railOpen : ''}`}
        aria-label="Main navigation"
      >
        <div className={styles.railTop}>
          <Link href="/dashboard" className={styles.brand} aria-label="SherrByte — go to the dashboard">
            <LogoGlyph size={34} priority />
            <span className={styles.brandText}>
              <span className={styles.brandName}>SherrByte</span>
              <span className={styles.brandSub}>Businesses</span>
            </span>
          </Link>
          <button
            type="button"
            className={styles.railClose}
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          >
            <CloseIcon />
          </button>
        </div>

        <Workspace />

        <div className={styles.railSearch}>
          <QuickJump variant="rail" />
        </div>

        <nav className={styles.nav}>
          {NAV.map((group) => (
            <NavSection key={group.label} group={group} pathname={pathname} hash={hash} />
          ))}
        </nav>
      </aside>

      {menuOpen ? (
        <button
          type="button"
          className={styles.scrim}
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <div className={styles.workspace}>
        <header className={styles.header}>
          <button
            type="button"
            className={styles.menuButton}
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
          >
            <MenuIcon width={20} height={20} />
          </button>
          <div className={styles.headerSearch}>
            <QuickJump variant="header" />
          </div>
          <div className={styles.headerActions}>
            <CreateMenu />
            <UserButton />
          </div>
        </header>
        <main className={styles.stage}>{children}</main>
      </div>
    </div>
  );
}

/** The company this session is working in. */
function Workspace() {
  const { organization } = useOrganization();
  if (!organization) return null;
  return (
    <div className={styles.workspaceCard} title={organization.name}>
      <span className={styles.workspaceInitial} aria-hidden="true">
        {(organization.name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
      </span>
      <span className={styles.workspaceName}>{organization.name}</span>
    </div>
  );
}

function isActive(href: string, pathname: string, hash: string): boolean {
  const [path, anchor] = href.split('#');
  if (!path || pathname !== path) return false;
  return anchor ? hash === `#${anchor}` : hash === '' || !NAV_ANCHORS.has(`${path}${hash}`);
}

/** Anchors that some nav entry owns, so a page-level link does not light up beside one. */
const NAV_ANCHORS = new Set(
  NAV.flatMap((g) => [g.href, ...(g.items ?? []).map((i) => i.href)]).filter(
    (h): h is string => Boolean(h && h.includes('#')),
  ),
);

function NavSection({ group, pathname, hash }: { group: NavGroup; pathname: string; hash: string }) {
  const containsActive = (group.items ?? []).some((i) => i.href && isActive(i.href, pathname, hash));
  const [open, setOpen] = useState(containsActive);

  // Landing inside a group opens it; leaving does not close it again.
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);

  const { Icon } = group;

  if (group.href) {
    const active = isActive(group.href, pathname, hash);
    return (
      <Link
        href={group.href}
        className={`${styles.navTop} ${active ? styles.navActive : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <Icon />
        <span>{group.label}</span>
      </Link>
    );
  }

  const listId = `nav-${group.label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <div className={styles.navGroup}>
      <button
        type="button"
        className={`${styles.navTop} ${containsActive ? styles.navTopHasActive : ''}`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon />
        <span>{group.label}</span>
        <ChevronIcon className={`${styles.navChevron} ${open ? styles.navChevronOpen : ''}`} width={14} height={14} />
      </button>
      {open ? (
        <ul className={styles.navList} id={listId}>
          {group.items?.map((item) => {
            if (!item.href) {
              return (
                <li key={item.label}>
                  <span className={styles.navSoon} aria-disabled="true">
                    {item.label}
                    <span className={styles.soonTag}>Soon</span>
                  </span>
                </li>
              );
            }
            const active = isActive(item.href, pathname, hash);
            return (
              <li key={item.label}>
                <Link
                  href={item.href}
                  className={`${styles.navItem} ${active ? styles.navActive : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Search, scoped to what exists: every page, section and "create" action.
 * Enter opens the first match; ⌘K / Ctrl+K focuses it from anywhere.
 */
function QuickJump({ variant }: { variant: 'header' | 'rail' }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const all = useMemo(() => flatDestinations(), []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return all
      .filter((d) => `${d.label} ${d.group}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [all, query]);

  useEffect(() => {
    if (variant !== 'header') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [variant]);

  const go = (href: string) => {
    setQuery('');
    inputRef.current?.blur();
    router.push(href);
  };

  const listId = `jump-${variant}`;
  const showList = focused && results.length > 0;

  return (
    <div className={`${styles.jump} ${variant === 'rail' ? styles.jumpRail : ''}`}>
      <SearchIcon className={styles.jumpIcon} width={16} height={16} />
      <input
        ref={inputRef}
        className={styles.jumpInput}
        type="search"
        value={query}
        placeholder="Search pages and actions"
        aria-label="Search pages and actions"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onFocus={() => setFocused(true)}
        // Delayed so a click on a result lands before the list disappears.
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === 'Enter' && results[cursor]) {
            e.preventDefault();
            go(results[cursor].href);
          } else if (e.key === 'Escape') {
            setQuery('');
          }
        }}
      />
      {variant === 'header' ? <kbd className={styles.kbd}>Ctrl K</kbd> : null}
      {showList ? (
        <ul className={styles.jumpList} id={listId} role="listbox">
          {results.map((r, i) => (
            <li key={`${r.group}-${r.label}`} role="option" aria-selected={i === cursor}>
              <button
                type="button"
                className={`${styles.jumpItem} ${i === cursor ? styles.jumpItemOn : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(r.href)}
              >
                <span>{r.label}</span>
                {r.group ? <span className={styles.jumpGroup}>{r.group}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CreateMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.create} ref={ref}>
      <button
        type="button"
        className={styles.createButton}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <PlusIcon width={16} height={16} />
        <span>Create</span>
      </button>
      {open ? (
        <div className={styles.createMenu} role="menu">
          {CREATE_ACTIONS.map((a) => (
            <Link
              key={a.label}
              href={a.href}
              role="menuitem"
              className={styles.createItem}
              onClick={() => setOpen(false)}
            >
              {a.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The URL fragment, kept current — Next's router does not report hash changes. */
function useHash(): string {
  const pathname = usePathname();
  const [hash, setHash] = useState('');
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener('hashchange', read);
    // A <Link> to the same page with a new fragment changes the hash without a
    // hashchange event in some browsers, so re-read after every click too.
    const onClick = () => window.setTimeout(read, 0);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('hashchange', read);
      document.removeEventListener('click', onClick);
    };
  }, [pathname]);
  return hash;
}
