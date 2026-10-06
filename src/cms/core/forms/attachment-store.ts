/**
 * Contact-form attachments on disk (G-V2-01).
 *
 * One flat folder, outside `public/`, mode 0700; one file per upload, mode 0600,
 * named by a random uuid the server chose. The visitor's file name is kept only
 * in the database row — it never becomes a path — and a key that is not a uuid
 * is refused before it is joined to anything.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AttachmentStore {
  /** Writes the bytes and returns their key. */
  save(bytes: Uint8Array): Promise<string>;
  /** The file as a web stream, or `null` for a bad key or a missing file. */
  open(key: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null>;
  /** Deletes the file; a bad key or a missing file is not an error. */
  remove(key: string): Promise<void>;
}

export function createAttachmentStore({ root }: { root: string }): AttachmentStore {
  const pathFor = (key: string) => (KEY.test(key) ? join(root, key) : null);

  return {
    async save(bytes) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const key = randomUUID();
      // `wx`: never overwrite, even on the impossible uuid collision.
      await writeFile(join(root, key), bytes, { mode: 0o600, flag: 'wx' });
      return key;
    },

    async open(key) {
      const path = pathFor(key);
      if (!path) return null;
      try {
        const { size, isFile } = await stat(path).then((s) => ({
          size: s.size,
          isFile: s.isFile(),
        }));
        if (!isFile) return null;
        return {
          stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
          size,
        };
      } catch {
        return null;
      }
    },

    async remove(key) {
      const path = pathFor(key);
      if (path) await rm(path, { force: true });
    },
  };
}
