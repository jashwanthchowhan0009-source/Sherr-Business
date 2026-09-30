import { config } from 'dotenv';
import { existsSync } from 'node:fs';

/** Loads .env.local then .env, without overriding anything already exported. */
export function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) config({ path: file, override: false, quiet: true });
  }
}
