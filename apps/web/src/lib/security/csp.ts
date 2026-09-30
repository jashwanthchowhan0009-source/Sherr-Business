/**
 * The app's Content-Security-Policy.
 *
 * Kept out of middleware.ts so it can be unit-tested without loading Clerk's
 * edge runtime. middleware.ts owns the nonce and the response wiring.
 */

/** Clerk serves its JS bundle, interstitial and telemetry from these hosts. */
const CLERK = [
  'https://*.clerk.accounts.dev',
  'https://*.clerk.com',
  'https://clerk.sherrbyte.com',
].join(' ');

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

export function contentSecurityPolicy(nonce: string, isDev: boolean): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    // Lets the nonced Next bootstrap load its own chunks, and Clerk load
    // Turnstile. Browsers honouring 'strict-dynamic' ignore the host list
    // below; it is kept for those that do not.
    "'strict-dynamic'",
    TURNSTILE,
    isDev ? "'unsafe-eval'" : '',
  ].filter(Boolean);

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' data: blob: https://img.clerk.com`,
    `connect-src 'self' ${CLERK} ${TURNSTILE} https://*.ingest.sentry.io`,
    `frame-src ${CLERK} ${TURNSTILE}`,
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
