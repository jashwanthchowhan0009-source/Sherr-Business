import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every mutation must go through defineAction(), which is what applies the
 * permission check, the rate limit, the tenant transaction and the audit row.
 *
 * Relying on reviewers to notice a hand-rolled server action is exactly the kind
 * of control that fails quietly at 6pm on a Friday, so it is asserted here.
 */
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
      expect(
        new RegExp(`const\\s+${target}\\s*=\\s*defineAction\\(`).test(source),
        `${name} delegates to ${target}, which is not built by defineAction()`,
      ).toBe(true);
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
});
