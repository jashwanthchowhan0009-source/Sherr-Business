import { config } from 'dotenv';
import { existsSync } from 'node:fs';

for (const file of ['.env.test.local', '.env.local', '.env']) {
  if (existsSync(file)) config({ path: file, override: false, quiet: true });
}
// NODE_ENV is typed readonly by @types/node; vitest already sets it to 'test'.
Object.assign(process.env, { NODE_ENV: process.env.NODE_ENV ?? 'test' });
