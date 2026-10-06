/**
 * Where contact-form attachments live on disk (G-V2-01).
 *
 * Outside `public/`, named by a random key the server chose — never by anything
 * the visitor sent — and only readable by the app's own user. A key that is not
 * one the store could have made is never turned into a path.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createAttachmentStore } from '@/cms/core/forms/attachment-store';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'form-uploads-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createAttachmentStore', () => {
  test('saves under a random key and reads the same bytes back', async () => {
    const store = createAttachmentStore({ root: join(root, 'a') });
    const key = await store.save(new TextEncoder().encode('%PDF-1.7'));
    assert.match(key, /^[0-9a-f-]{36}$/);
    const opened = await store.open(key);
    assert.ok(opened);
    assert.equal(opened.size, 8);
    assert.equal(await new Response(opened.stream).text(), '%PDF-1.7');
  });

  test('two saves never share a key', async () => {
    const store = createAttachmentStore({ root: join(root, 'b') });
    const a = await store.save(new Uint8Array([1]));
    const b = await store.save(new Uint8Array([1]));
    assert.notEqual(a, b);
  });

  test(
    'the folder and the files are private to the app user',
    { skip: process.platform === 'win32' },
    async () => {
      const dir = join(root, 'c');
      const store = createAttachmentStore({ root: dir });
      const key = await store.save(new Uint8Array([1, 2, 3]));
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(dir, key))).mode & 0o777, 0o600);
    }
  );

  test('a key that is not a uuid is never opened', async () => {
    const store = createAttachmentStore({ root: join(root, 'd') });
    await store.save(new Uint8Array([1]));
    assert.equal(await store.open('../../etc/passwd'), null);
    assert.equal(await store.open(''), null);
    assert.equal(await store.open('00000000-0000-0000-0000-000000000000/../x'), null);
  });

  test('a missing file opens as null', async () => {
    const store = createAttachmentStore({ root: join(root, 'e') });
    assert.equal(await store.open('3f2a1b4c-0d9e-4f8a-9b7c-6d5e4f3a2b1c'), null);
  });

  test('remove deletes the file and ignores a bad key', async () => {
    const dir = join(root, 'f');
    const store = createAttachmentStore({ root: dir });
    const key = await store.save(new Uint8Array([1]));
    await store.remove('../nope');
    await store.remove(key);
    assert.deepEqual(await readdir(dir), []);
    await assert.rejects(readFile(join(dir, key)));
  });
});
