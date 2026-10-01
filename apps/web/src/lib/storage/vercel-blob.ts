import 'server-only';
import { del, get, put } from '@vercel/blob';
import type { StorageDriver } from './index';

/**
 * Vercel Blob, private.
 *
 * `access: 'private'` is the whole point: a public blob is readable by anyone
 * holding the URL, which is not a property an accounting document may have.
 * Reads are authenticated with BLOB_READ_WRITE_TOKEN, server-side only, and
 * the bytes are streamed back through our own route after a membership check.
 */
export function vercelBlobDriver(): StorageDriver {
  return {
    name: 'vercel-blob',

    async put({ key, bytes, mimeType }) {
      await put(key, bytes, {
        access: 'private',
        contentType: mimeType,
        // The key is already unique; adding a random suffix would make the
        // stored key differ from the one recorded in the documents row.
        addRandomSuffix: false,
      });
    },

    async get(key) {
      const result = await get(key, { access: 'private' });
      if (!result?.stream) throw new Error(`Stored object ${key} is missing`);
      // A web ReadableStream, not a Node one, so it is read with a reader
      // rather than with for-await.
      const reader = result.stream.getReader();
      const chunks: Buffer[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    },

    async remove(key) {
      await del(key);
    },
  };
}
