import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every mutation must go through one of the two action factories.
 *
 * defineAction applies the permission check, the rate limit, the tenant
 * transaction and the audit row. defineAccountAction covers the operations that
 * legitimately run before an organization exists (today, only company
 * creation): it drops the capability check and the tenant transaction, because
 * there is no tenant yet, and keeps identity, validation and rate limiting.
 *
 * Relying on reviewers to notice a hand-rolled server action is exactly the kind
 * of control that fails quietly at 6pm on a Friday, so it is asserted here.
 */
const FACTORIES = ['defineAction', 'defineAccountAction'] as const;
const SERVER_DIR = join(process.cwd(), 'src', 'server');

function serverActionFiles(): string[] {
  return readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SERVER_DIR, f))
    .filter((p) => readFileSync(p, 'utf8').includes("'use server'"));
}

describe('server action guard', () => {
  const files = serverActionFiles();

  it('finds the server action modules', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s exports only thin delegates to a defineAction handler', (file) => {
    const source = readFileSync(file, 'utf8');

    // Next requires a 'use server' module to export async functions only, so each
    // action is exposed through a wrapper. Every wrapper must do nothing except
    // delegate to a const built by defineAction().
    const exported = [
      ...source.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g),
    ];
    expect(exported.length, 'no exported actions found').toBeGreaterThan(0);

    for (const [, name, body] of exported) {
      const delegate = body?.trim().match(/^return\s+(\w+)\(input\);$/);
      expect(delegate, `${name} must be a one-line delegate, found: ${body?.trim()}`).not.toBeNull();

      const target = delegate![1];
      const builtBy = FACTORIES.find((factory) =>
        new RegExp(`const\\s+${target}\\s*=\\s*${factory}\\(`).test(source),
      );
      expect(
        builtBy,
        `${name} delegates to ${target}, which is not built by ${FACTORIES.join(' or ')}`,
      ).toBeDefined();
    }

    // Nothing else may leave the module.
    expect(/export\s+const\s/.test(source), 'unexpected exported const').toBe(false);
  });

  it.each(files)('%s never opens its own tenant transaction', (file) => {
    const source = readFileSync(file, 'utf8');
    // defineAction supplies `tx`; calling withTenant again would escape the
    // audit binding and open a second transaction.
    expect(source.includes('withTenant('), 'calls withTenant directly').toBe(false);
  });

  it('keeps defineAccountAction to the operations that genuinely predate an org', () => {
    // It is the weaker factory: no capability check, no tenant transaction, and
    // no screen-lock check. If it spreads, mutations start escaping all three.
    //
    // Two modules qualify, and only two. Creating a company runs before any
    // organization exists. The screen lock runs before one is reachable — and
    // must: an unlock action behind the unlock check could never be called.
    const users = files.filter((f) => readFileSync(f, 'utf8').includes('defineAccountAction('));
    expect(users.map((f) => f.split('/').pop()).sort()).toEqual(['onboarding.ts', 'screen-lock.ts']);
  });

  it('lets nothing but the lock itself out of the screen-lock check', () => {
    // Every other action goes through defineAction, where the unlock is
    // verified. This is the assertion that keeps the lock a lock: without it,
    // moving one mutation to the weaker factory would quietly exempt it.
    const exempt = files
      .filter((f) => readFileSync(f, 'utf8').includes('defineAccountAction('))
      .map((f) => f.split('/').pop());
    for (const name of exempt) {
      expect(['onboarding.ts', 'screen-lock.ts'], `${name} is exempt from the screen lock`)
        .toContain(name);
    }
  });
});
