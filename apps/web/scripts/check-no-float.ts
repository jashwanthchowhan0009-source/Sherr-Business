/**
 * Money must be an integer count of paise. This fails CI if a migration
 * introduces a floating-point or arbitrary-precision numeric column, which is
 * how rounding error gets into a ledger.
 *
 * `numeric` is included deliberately: it is exact, but it invites JS code to
 * read it as a string and then parseFloat it, which is the actual failure we
 * are guarding against.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = /\b(real|double\s+precision|float4|float8|float\s*\(|numeric\s*\(|decimal\s*\()/gi;
const DIR = join(process.cwd(), 'drizzle');

let failures = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql'))) {
  const contents = readFileSync(join(DIR, file), 'utf8');
  contents.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('--')) return;
    const match = line.match(BANNED);
    if (match) {
      console.error(`${file}:${i + 1}  banned numeric type: ${match.join(', ')}`);
      console.error(`    ${line.trim()}`);
      failures += 1;
    }
  });
}

if (failures > 0) {
  console.error(
    `\n${failures} banned column type(s). Money is bigint paise — see src/lib/money.ts.\n`,
  );
  process.exit(1);
}
console.log('[check:no-float] no floating-point or numeric columns in migrations');
