import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { openZip, ZipFileWriter, ZipLimitError } from '@/cms/core/transfer/zip-file';
import { readZip, writeZip } from '@/cms/update/zip.mjs';

/**
 * An import package is uploaded by a user and unpacked by the server, so the
 * reader is an attack surface: names that climb out of the folder, entries that
 * inflate a few KB into gigabytes, and files that lie about their contents all
 * have to be refused before they cost anything.
 */

const dir = mkdtempSync(join(tmpdir(), 'zip-file-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `t${++n}.zip`);

describe('ZipFileWriter + openZip', () => {
  test('round-trips stored and deflated entries', async () => {
    const path = file();
    const w = await ZipFileWriter.create(path);
    await w.add('manifest.json', Buffer.from('{"a":1}'));
    await w.add('data/docs/0001.jsonl', Buffer.from('x\n'.repeat(1000)));
    await w.add('media/11111111-1111-4111-8111-111111111111', Buffer.from([1, 2, 3]), {
      store: true,
    });
    await w.close();

    const zip = await openZip(path);
    try {
      assert.deepEqual(
        zip.entries.map((e) => e.name),
        ['manifest.json', 'data/docs/0001.jsonl', 'media/11111111-1111-4111-8111-111111111111']
      );
      assert.equal((await zip.read('manifest.json')).toString(), '{"a":1}');
      assert.equal((await zip.read('data/docs/0001.jsonl')).length, 2000);
      assert.deepEqual(
        [...(await zip.read('media/11111111-1111-4111-8111-111111111111'))],
        [1, 2, 3]
      );
      await assert.rejects(zip.read('nope'), /not in the archive/);
    } finally {
      await zip.close();
    }
  });

  test('can be continued by a later request from its saved state', async () => {
    const path = file();
    const first = await ZipFileWriter.create(path);
    await first.add('a.txt', Buffer.from('one'));
    const state = await first.suspend();
    const again = await ZipFileWriter.resume(path, JSON.parse(JSON.stringify(state)));
    await again.add('b.txt', Buffer.from('two'));
    await assert.rejects(again.add('a.txt', Buffer.from('dup')), /Duplicate/);
    const third = await ZipFileWriter.resume(path, await again.suspend());
    await third.add('c.txt', Buffer.from('three'));
    await third.close();
    const zip = await openZip(path);
    assert.deepEqual(
      zip.entries.map((e) => e.name),
      ['a.txt', 'b.txt', 'c.txt']
    );
    assert.equal((await zip.read('c.txt')).toString(), 'three');
    assert.equal((await zip.read('a.txt')).toString(), 'one');
    assert.equal((await zip.read('b.txt')).toString(), 'two');
    await zip.close();
  });

  test('its output is a standard zip (the update reader can read it)', async () => {
    const path = file();
    const w = await ZipFileWriter.create(path);
    await w.add('a.txt', Buffer.from('hello'));
    await w.close();
    assert.equal(readZip(readFileSync(path))[0].data.toString(), 'hello');
  });

  test('refuses a name that would leave the folder', async () => {
    const path = file();
    writeFileSync(
      path,
      writeZip([{ path: '../evil.txt', data: Buffer.from('x') }], { unsafe: true })
    );
    await assert.rejects(openZip(path), ZipLimitError);
    const w = await ZipFileWriter.create(file());
    await assert.rejects(w.add('../evil', Buffer.from('x')));
    await w.close();
  });

  test('refuses more entries than allowed', async () => {
    const path = file();
    writeFileSync(
      path,
      writeZip([1, 2, 3].map((i) => ({ path: `f${i}`, data: Buffer.from('x') })))
    );
    await assert.rejects(openZip(path, { maxEntries: 2 }), /too many entries/);
  });

  test('refuses a zip bomb before inflating it', async () => {
    const path = file();
    writeFileSync(path, writeZip([{ path: 'bomb', data: Buffer.alloc(5_000_000) }]));
    await assert.rejects(openZip(path, { maxRatio: 100 }), /compression ratio/);
    const zip = await openZip(path, { maxRatio: 1_000_000, maxEntryBytes: 1_000_000 });
    await assert.rejects(zip.read('bomb'), /too large/);
    await zip.close();
    await assert.rejects(openZip(path, { maxRatio: 1_000_000, maxTotalBytes: 1_000 }), /too large/);
  });

  test('detects corrupted content', async () => {
    const path = file();
    const buf = writeZip([{ path: 'a.bin', data: Buffer.from([9, 9, 9, 9, 9, 9, 9, 7]) }]);
    buf[30 + 'a.bin'.length] ^= 0xff; // first body byte of the stored entry
    writeFileSync(path, buf);
    const zip = await openZip(path);
    await assert.rejects(zip.read('a.bin'), /corrupted/);
    await zip.close();
  });

  test('refuses a truncated file and something that is not a zip', async () => {
    const path = file();
    writeFileSync(path, writeZip([{ path: 'a', data: Buffer.from('hello world') }]));
    truncateSync(path, 20);
    await assert.rejects(openZip(path), ZipLimitError);
    const junk = file();
    writeFileSync(junk, 'not a zip at all');
    await assert.rejects(openZip(junk), ZipLimitError);
  });

  test('refuses duplicate names', async () => {
    const path = file();
    writeFileSync(
      path,
      writeZip([
        { path: 'a', data: Buffer.from('1') },
        { path: 'a', data: Buffer.from('2') },
      ])
    );
    await assert.rejects(openZip(path), /duplicate/);
  });
});
