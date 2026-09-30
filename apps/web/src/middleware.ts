import { NextResponse, type NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { contentSecurityPolicy, frontendApiHost } from '@/lib/security/csp';

/**
 * Edge middleware. Must not touch the database — `pg` cannot run here, and the
 * authoritative permission check happens in the action factory anyway.
 *
 * Responsibilities:
 *  1. Require a signed-in user on /app routes.
 *  2. Gate on MFA enrolment, failing closed when the signal is unreadable.
 *  3. Attach a per-request CSP nonce.
 */

const isPublic = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
]);

/** The MFA enrolment page itself must stay reachable while MFA is missing. */
const isMfaSetup = createRouteMatcher(['/onboarding/mfa(.*)']);

function withSecurity(req: NextRequest): { response: NextResponse; nonce: string } {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    // Derived from the key rather than hardcoded, so it is right for whichever
    // Clerk instance the deployment actually points at.
    fapiHost: frontendApiHost(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
    sentryEnabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return { response, nonce };
}

const clerkConfigured = Boolean(
  process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
);

/**
 * Without Clerk keys the app still boots so the database work and the shell can
 * be developed and tested. Protected routes are refused outright rather than
 * silently opened — an unconfigured auth provider must never mean "allow".
 */
const unconfigured = (req: NextRequest): NextResponse => {
  const { response } = withSecurity(req);
  if (isPublic(req)) return response;
  return NextResponse.redirect(new URL('/?error=auth_not_configured', req.url));
};

const configured = clerkMiddleware(async (getAuth, req) => {
  const { response } = withSecurity(req);
  if (isPublic(req)) return response;

  const { userId, sessionClaims, redirectToSignIn } = await getAuth();
  if (!userId) return redirectToSignIn({ returnBackUrl: req.url });

  if (!isMfaSetup(req) && !hasSecondFactor(sessionClaims)) {
    return NextResponse.redirect(new URL('/onboarding/mfa', req.url));
  }

  return response;
});

/**
 * Reads the MFA signal from the session token.
 *
 * Add this to Clerk -> Sessions -> Customize session token (README § Clerk):
 *   { "mfa": "{{user.two_factor_enabled}}" }
 *
 * If the claim is missing or malformed this returns false, so a misconfigured
 * dashboard locks users out of /app rather than letting them past the gate.
 * requireOrgContext() re-checks server-side regardless.
 */
function hasSecondFactor(claims: unknown): boolean {
  if (!claims || typeof claims !== 'object') return false;
  const value = (claims as Record<string, unknown>).mfa;
  return value === true || value === 'true';
}

export default clerkConfigured ? configured : unconfigured;

export const config = {
  matcher: [
    // Everything except Next internals and files with an extension.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
