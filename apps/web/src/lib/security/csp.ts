/**
 * The app's Content-Security-Policy.
 *
 * Kept out of middleware.ts so it can be unit-tested without loading Clerk's
 * edge runtime; middleware.ts owns the nonce and the response wiring.
 *
 * Pure on purpose: a missing CSP source is invisible server-side. Nothing
 * throws, nothing is logged, the deployment reports 200, and the only symptom
 * is a browser quietly refusing a subresource. tests/unit/csp.test.ts is the
 * only place this gets checked.
 */

/**
 * Clerk's bot sign-up protection renders a Cloudflare Turnstile widget inside a
 * challenges.cloudflare.com iframe. Omit this host and the widget is blocked,
 * Clerk shows "The CAPTCHA failed to load", and the Continue button spins
 * forever because sign-up can never be submitted.
 *
 * frame-src is the directive that actually matters: 'strict-dynamic' governs
 * script loading only, so it cannot rescue a blocked iframe.
 */
const TURNSTILE = 'https://challenges.cloudflare.com';

/**
 * Clerk-managed hosts, as a fallback. The exact Frontend API host is derived
 * from the publishable key below; these wildcards keep the policy working if
 * that derivation ever returns null, and cover Clerk's shared domains.
 */
const CLERK_WILDCARDS = ['https://*.clerk.accounts.dev', 'https://*.clerk.com'];
const CLERK_IMG = 'https://img.clerk.com';
const CLERK_TELEMETRY = ['https://clerk-telemetry.com', 'https://*.clerk-telemetry.com'];

/**
 * Derives the Clerk Frontend API host from the publishable key.
 *
 * The key is `pk_(test|live)_<base64 of "host$">`, so the instance's own API
 * host travels with the key. An earlier version of this policy hardcoded a
 * guessed domain instead; a guessed host is worse than none, because the policy
 * looks configured while naming somewhere that does not exist. Deriving it also
 * covers a custom production Frontend API domain, which the wildcards above
 * would miss.
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
  /** Clerk Frontend API host, e.g. "infinite-ladybug-9854.clerk.accounts.dev". */
  fapiHost: string | null;
  sentryEnabled: boolean;
}

export function contentSecurityPolicy({
  nonce,
  isDev,
  fapiHost,
  sentryEnabled,
}: CspOptions): string {
  const clerkHosts = [...CLERK_WILDCARDS, fapiHost ? `https://${fapiHost}` : ''].filter(Boolean);

  // Deliberately no 'strict-dynamic'. It would be the stronger policy, but it
  // disables host-based allowlisting, and Clerk's loader cannot survive that:
  // @clerk/nextjs renders the clerk-js <script> through ClerkJSScript, which
  // never sets a nonce attribute on it (6.39.7, utils/clerk-js-script.js), and
  // the ClerkProvider `nonce` prop only reaches the script URL. A parser-
  // inserted cross-origin tag with no nonce and no usable allowlist is simply
  // refused, which is what production reported:
  //
  //   Loading the script '…/clerk.browser.js' violates the following Content
  //   Security Policy directive … Note that 'strict-dynamic' is present, so
  //   host-based allowlisting is disabled. The action has been blocked.
  //
  // The nonce below still covers Next's inline bootstrap; every remote script
  // is named explicitly instead.
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    TURNSTILE,
    ...clerkHosts,
    isDev ? "'unsafe-eval'" : '',
  ];

  // Turnstile fetches its challenge as well as framing it.
  const connectSrc = [
    "'self'",
    TURNSTILE,
    ...clerkHosts,
    ...CLERK_TELEMETRY,
    CLERK_IMG,
    sentryEnabled ? 'https://*.ingest.sentry.io' : '',
  ];

  const frameSrc = ["'self'", TURNSTILE, ...clerkHosts];

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
