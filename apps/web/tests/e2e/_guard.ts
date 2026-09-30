import { test } from '@playwright/test';

/**
 * E2E needs a running app and real Clerk test credentials. When those are
 * absent the suite SKIPS — it never passes vacuously, because a green tick that
 * exercised nothing is worse than a visible gap.
 */
export const E2E_READY = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
    process.env.CLERK_SECRET_KEY &&
    process.env.E2E_USER_EMAIL &&
    process.env.E2E_USER_PASSWORD,
);

export function requireE2EEnv(): void {
  test.skip(
    !E2E_READY,
    'Clerk test credentials are not set (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, E2E_USER_EMAIL, E2E_USER_PASSWORD).',
  );
}
