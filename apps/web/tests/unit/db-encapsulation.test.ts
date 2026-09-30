import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The raw connection pool is reachable from exactly one place. Anything that
 * imports it directly is a query that skips the tenant GUC, which is a
 * cross-tenant read waiting to happen.
 */
const SRC = join(process.cwd(), 'src');
const ALLOWED = ['lib/db/pool.ts', 'lib/db/tenant.ts', 'lib/ratelimit.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('database encapsulation', () => {
  const files = walk(SRC);

  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports the raw pool only from the sanctioned modules', () => {
    const offenders = files.filter((file) => {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (ALLOWED.includes(rel)) return false;
      return /from\s+['"](@\/lib\/db\/pool|\.\/pool|\.\.\/db\/pool)['"]/.test(
        readFileSync(file, 'utf8'),
      );
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('never reaches the owner connection from a route or page', () => {
    const offenders = files
      .filter((f) => relative(SRC, f).startsWith('app'))
      .filter((f) => readFileSync(f, 'utf8').includes('db/owner'));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('keeps every tenant query inside withTenant', () => {
    // Anything selecting from a tenant table must do so through a tx handed out
    // by withTenant or defineAction. Queries elsewhere are the smell.
    const offenders = files.filter((file) => {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (rel.startsWith('lib/db/') || rel === 'lib/ratelimit.ts') return false;
      const source = readFileSync(file, 'utf8');
      return /\bappDb\s*\(/.test(source);
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
