import 'server-only';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { StorageDriver } from './index';

/**
 * Development and CI only.
 *
 * Writes under .storage/, which is gitignored. It exists so the upload path is
 * exercised by the test suite and by `pnpm dev` without anyone needing a blob
 * token; it is never selected when BLOB_READ_WRITE_TOKEN is set.
 */
const ROOT = resolve(process.cwd(), '.storage');

/**
 * Resolves a key to a path inside ROOT, or refuses.
 *
 * Keys are built by buildStorageKey and never come from a user, but a path
 * join that trusts its input is the kind of thing that stops being true later,
 * and `../` traversal here would read any file the process can.
 */
function pathFor(key: string): string {
  const full = resolve(ROOT, normalize(key));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error(`Refusing a storage key that escapes the store: ${key}`);
  }
  return full;
}

export function localDriver(): StorageDriver {
  return {
    name: 'local',

    async put({ key, bytes }) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },

    async get(key) {
      return readFile(pathFor(key));
    },

    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export const LOCAL_STORAGE_ROOT = join(ROOT);
