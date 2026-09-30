import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, frontendApiHost } from '../../src/lib/security/csp';

/**
 * Regression tests for the sign-up hang.
 *
 * A missing CSP source is invisible on the server: nothing throws, nothing is
 * logged, and the deployment reports 200. The only symptom is a browser quietly
 * refusing a request — which showed up as a sign-up button spinning forever with
 * no error. These assertions are the only thing that catches it before a user does.
 */

// "quiet-lion-42.clerk.accounts.dev$" base64-encoded, as Clerk encodes it.
const PK_TEST = `pk_test_${Buffer.from('quiet-lion-42.clerk.accounts.dev$').toString('base64')}`;
const PK_LIVE = `pk_live_${Buffer.from('clerk.example.com$').toString('base64')}`;

function parse(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

const build = (overrides: Partial<Parameters<typeof contentSecurityPolicy>[0]> = {}) =>
  parse(
    contentSecurityPolicy({
      nonce: 'test-nonce',
      isDev: false,
      fapiHost: 'quiet-lion-42.clerk.accounts.dev',
      sentryEnabled: false,
      ...overrides,
    }),
  );

describe('frontendApiHost', () => {
  it('derives the host from a test key', () => {
    expect(frontendApiHost(PK_TEST)).toBe('quiet-lion-42.clerk.accounts.dev');
  });

  it('derives the host from a live key', () => {
    expect(frontendApiHost(PK_LIVE)).toBe('clerk.example.com');
  });

  it('returns null rather than a broken source expression', () => {
    for (const bad of [undefined, '', 'not-a-key', 'pk_test_!!!not-base64!!!']) {
      expect(frontendApiHost(bad), String(bad)).toBeNull();
    }
  });
});

describe('content security policy', () => {
  it('allows the Cloudflare Turnstile frame that Clerk bot protection renders', () => {
    // The omission that broke sign-up. Turnstile runs in an iframe; without this
    // the challenge never loads, Clerk never gets a token, and submit hangs.
    expect(build()['frame-src']).toContain('https://challenges.cloudflare.com');
  });

  it('allows the Turnstile script', () => {
    expect(build()['script-src']).toContain('https://challenges.cloudflare.com');
  });

  it("allows the instance's own Clerk API host", () => {
    for (const d of ['connect-src', 'frame-src', 'script-src']) {
      expect(build()[d], d).toContain('https://quiet-lion-42.clerk.accounts.dev');
    }
  });

  it('names no hardcoded Clerk domain', () => {
    // A guessed domain is worse than none: it looks configured and refuses
    // every request. The host must come from the publishable key.
    const csp = contentSecurityPolicy({
      nonce: 'n',
      isDev: false,
      fapiHost: null,
      sentryEnabled: false,
    });
    expect(csp).not.toMatch(/clerk\.sherrbyte\.com/);
    expect(csp).not.toMatch(/https:\/\/\s/);
    expect(csp).not.toMatch(/;\s*;/);
  });

  it('emits no empty source expression when the key is absent', () => {
    const directives = build({ fapiHost: null });
    for (const [name, sources] of Object.entries(directives)) {
      expect(sources.every((s) => s.length > 0), `${name} has an empty source`).toBe(true);
    }
  });

  it('carries the nonce and strict-dynamic', () => {
    const scriptSrc = build()['script-src'];
    expect(scriptSrc).toContain("'nonce-test-nonce'");
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it('allows unsafe-eval only in development', () => {
    expect(build({ isDev: true })['script-src']).toContain("'unsafe-eval'");
    expect(build({ isDev: false })['script-src']).not.toContain("'unsafe-eval'");
  });

  it('includes Sentry only when a DSN is configured', () => {
    expect(build({ sentryEnabled: true })['connect-src']).toContain('https://*.ingest.sentry.io');
    expect(build({ sentryEnabled: false })['connect-src']).not.toContain(
      'https://*.ingest.sentry.io',
    );
  });

  it('keeps the page unframeable and blocks plugins', () => {
    const d = build();
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
  });

  it('allows the Google Fonts the design system loads', () => {
    const d = build();
    expect(d['style-src']).toContain('https://fonts.googleapis.com');
    expect(d['font-src']).toContain('https://fonts.gstatic.com');
  });
});
