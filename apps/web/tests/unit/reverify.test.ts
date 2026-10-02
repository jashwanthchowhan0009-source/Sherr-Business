import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({ auth }));

const { REVERIFY_WITHIN_MINUTES, reverifyState, secondFactorIsFresh } = await import(
  '../../src/lib/auth/reverify'
);

/** `fva` is [minutes since first factor, minutes since second factor]. */
const session = (claims: Record<string, unknown> | null) =>
  auth.mockResolvedValue({ sessionClaims: claims });

beforeEach(() => auth.mockReset());

describe('reading the factor-verification age', () => {
  it('accepts a second factor proved just now', async () => {
    session({ fva: [0, 0], mfa: true });
    expect(await reverifyState()).toEqual({ fresh: true });
  });

  it('accepts one proved inside the window', async () => {
    session({ fva: [30, REVERIFY_WITHIN_MINUTES - 1], mfa: true });
    expect((await reverifyState()).fresh).toBe(true);
  });

  it('refuses one proved outside it', async () => {
    session({ fva: [30, REVERIFY_WITHIN_MINUTES + 1], mfa: true });
    expect(await reverifyState()).toEqual({ fresh: false, reason: 'stale' });
  });

  it('treats the boundary minute as fresh', async () => {
    session({ fva: [0, REVERIFY_WITHIN_MINUTES], mfa: true });
    expect((await reverifyState()).fresh).toBe(true);
  });
});

describe('the compulsory-MFA fallback', () => {
  it('accepts a fresh sign-in on a two-factor account', async () => {
    // -1 means "no second factor in this session". On an account where sign-in
    // cannot complete without one, a sign-in two minutes old is a second factor
    // two minutes old, whatever the second slot says.
    session({ fva: [2, -1], mfa: true });
    expect((await reverifyState()).fresh).toBe(true);
  });

  it('refuses a fresh sign-in when two-factor is not on the account', async () => {
    session({ fva: [2, -1], mfa: false });
    expect(await reverifyState()).toEqual({ fresh: false, reason: 'stale' });
  });

  it('refuses an old sign-in even with two-factor on', async () => {
    session({ fva: [600, -1], mfa: true });
    expect((await reverifyState()).fresh).toBe(false);
  });

  it('reads the claim as the string Clerk templates produce', async () => {
    // A session-token template interpolates {{user.two_factor_enabled}} as text.
    session({ fva: [2, -1], mfa: 'true' });
    expect((await reverifyState()).fresh).toBe(true);
  });
});

describe('when freshness cannot be judged', () => {
  it.each([
    ['no claims at all', null],
    ['no fva claim', { mfa: true }],
    ['fva holding one value', { fva: [0], mfa: true }],
    ['fva that is not an array', { fva: '0,0', mfa: true }],
  ])('reports %s as unavailable, not stale', async (_label, claims) => {
    // The two are told apart on purpose. "Stale" sends the user to sign in
    // again; for a missing claim that is a loop they can never leave, so the
    // screen has to say something else.
    session(claims as Record<string, unknown> | null);
    expect(await reverifyState()).toEqual({ fresh: false, reason: 'unavailable' });
  });

  it.each([
    ['a non-numeric age', { fva: [0, 'soon'], mfa: false }],
    ['a negative age on an account without MFA', { fva: [-1, -1], mfa: false }],
  ])('fails closed on %s', async (_label, claims) => {
    session(claims as Record<string, unknown>);
    expect(await secondFactorIsFresh()).toBe(false);
  });

  it('never resets a PIN on an unreadable signal', async () => {
    // The whole point: the lock protects against somebody holding this very
    // session, so an unreadable signal must not be read as permission.
    session({ fva: [0, 0] });
    const withoutMfaClaim = await secondFactorIsFresh();
    session({});
    expect([withoutMfaClaim, await secondFactorIsFresh()]).toEqual([true, false]);
  });
});
