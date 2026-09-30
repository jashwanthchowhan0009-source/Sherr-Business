import { expect, test } from '@playwright/test';
import { requireE2EEnv } from './_guard';

test.describe('access control', () => {
  test.beforeEach(() => requireE2EEnv());

  test('an anonymous visitor cannot reach the dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/sign-in/);
  });

  test('a signed-in user without MFA is held at the enrolment gate', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel(/email/i).fill(process.env.E2E_USER_EMAIL!);
    await page.getByLabel(/password/i).fill(process.env.E2E_USER_PASSWORD!);
    await page.getByRole('button', { name: /continue|sign in/i }).click();
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: /two-factor/i })).toBeVisible();
  });
});

test.describe('health', () => {
  // No Clerk needed: proves the app is actually up before anything else is read.
  test('health endpoint responds', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
});
