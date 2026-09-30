/**
 * Content-Security-Policy construction.
 *
 * Pure and testable on purpose: this policy is the difference between a working
 * sign-up and a button that spins forever, and a CSP bug is invisible
 * server-side — nothing throws, nothing is logged, the browser just refuses a
 * request. tests/unit/csp.test.ts is the only place it gets checked.
 */

/** Cloudflare Turnstile, which Clerk uses for bot protection on sign-up. */
const TURNSTILE = 'https://challenges.cloudflare.com';

/** Clerk's own hosts, per its published CSP defaults. */
const CLERK_IMG = 'https://img.clerk.com';
const CLERK_TELEMETRY = ['https://clerk-telemetry.com', 'https://*.clerk-telemetry.com'];

/**
 * Derives the Clerk Frontend API host from the publishable key.
 *
 * The key is `pk_(test|live)_<base64 of "host$">`, so the instance's own API
 * host travels with the key. Hardcoding a guess instead is how this policy
 * broke: it named a domain that did not exist, and every Clerk request from the
 * deployed origin was refused.
 *
 * Returns null for a malformed or absent key; callers then omit the host rather
 * than emitting a broken source expression.
 */
export function frontendApiHost(publishableKey: string | undefined): string | null {
  if (!publishableKey) return null;
  const encoded = publishableKey.replace(/^pk_(test|live)_/, '');
  if (encoded === publishableKey) return null;
  try {
    const decoded = atob(encoded).replace(/\$+$/, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Clerk Frontend API host, e.g. "quiet-lion-42.clerk.accounts.dev". */
  fapiHost: string | null;
  sentryEnabled: boolean;
}

export function contentSecurityPolicy({
  nonce,
  isDev,
  fapiHost,
  sentryEnabled,
}: CspOptions): string {
  const fapi = fapiHost ? `https://${fapiHost}` : '';

  // Clerk loads its SDK and the Turnstile challenge as scripts. 'strict-dynamic'
  // covers scripts injected by an already-trusted script, but naming the hosts
  // keeps the policy working in browsers that do not support it.
  const scriptSrc = [
    `'self'`,
    `'nonce-${nonce}'`,
    `'strict-dynamic'`,
    TURNSTILE,
    fapi,
    isDev ? `'unsafe-eval'` : '',
  ];

  // Turnstile renders inside an iframe. Omitting it here is precisely what made
  // sign-up hang: the challenge frame was refused, so Clerk never received a
  // token and the submit button spun with no error to show.
  const frameSrc = [`'self'`, TURNSTILE, fapi];

  const connectSrc = [
    `'self'`,
    fapi,
    ...CLERK_TELEMETRY,
    CLERK_IMG,
    sentryEnabled ? 'https://*.ingest.sentry.io' : '',
  ];

  return [
    `default-src 'self'`,
    directive('script-src', scriptSrc),
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' data: blob: ${CLERK_IMG}`,
    directive('connect-src', connectSrc),
    directive('frame-src', frameSrc),
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    isDev ? '' : 'upgrade-insecure-requests',
  ]
    .filter(Boolean)
    .join('; ');
}

const directive = (name: string, sources: readonly string[]): string =>
  `${name} ${sources.filter(Boolean).join(' ')}`;
