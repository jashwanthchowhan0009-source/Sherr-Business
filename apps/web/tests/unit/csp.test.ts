import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '@/lib/security/csp';

/** Pulls one directive out of a serialised policy. */
function directive(csp: string, name: string): string {
  const found = csp
    .split('; ')
    .find((part) => part === name || part.startsWith(`${name} `));
  if (!found) throw new Error(`missing directive: ${name}`);
  return found;
}

const TURNSTILE = 'https://challenges.cloudflare.com';

describe('contentSecurityPolicy', () => {
  const csp = contentSecurityPolicy('test-nonce', false);

  it('carries the request nonce', () => {
    expect(directive(csp, 'script-src')).toContain("'nonce-test-nonce'");
  });

  // Regression: leaving Turnstile out of frame-src blocked Clerk's bot
  // protection widget, so sign-up reported "The CAPTCHA failed to load" and
  // the Continue button span forever.
  it('allows the Clerk CAPTCHA to frame Cloudflare Turnstile', () => {
    expect(directive(csp, 'frame-src')).toContain(TURNSTILE);
  });

  it('allows Turnstile to be fetched and contacted', () => {
    expect(directive(csp, 'script-src')).toContain(TURNSTILE);
    expect(directive(csp, 'connect-src')).toContain(TURNSTILE);
  });

  it('still reaches Clerk itself on every host-bearing directive', () => {
    for (const name of ['connect-src', 'frame-src']) {
      expect(directive(csp, name)).toContain('https://*.clerk.accounts.dev');
    }
  });

  it('keeps the production hardening', () => {
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('only loosens script-src for local development', () => {
    expect(contentSecurityPolicy('n', true)).toContain("'unsafe-eval'");
  });

  it('emits no empty directives', () => {
    for (const part of csp.split('; ')) expect(part.trim()).toBe(part);
    expect(csp).not.toContain(';;');
  });
});
