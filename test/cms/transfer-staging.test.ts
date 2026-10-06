import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { createStaging, StagingError } from '@/cms/core/transfer/staging';

/**
 * Uploads arrive in chunks over separate requests. A chunk can be retried after
 * a dropped connection, so appending must be idempotent by OFFSET: a repeated
 * chunk overwrites itself instead of duplicating bytes.
 */

const root = mkdtempSync(join(tmpdir(), 'staging-'));
after(() => rmSync(root, { recursive: true, force: true }));
const staging = createStaging({ root, maxBytes: 100, ttlMs: 60_000 });

describe('staging', () => {
  test('creates a job owned by one user, with metadata', async () => {
    const job = await staging.create('import', 7, { filename: 'a.zip', size: 10 });
    assert.match(job.id, /^[0-9a-f-]{36}$/);
    const meta = await staging.meta(job.id, 7);
    assert.equal(meta.ownerId, 7);
    assert.equal(meta.kind, 'import');
    await assert.rejects(
      staging.meta(job.id, 8),
      (e: unknown) => e instanceof StagingError && e.code === 'forbidden'
    );
  });

  test('rejects ids that are not uuids (no path games)', async () => {
    await assert.rejects(
      staging.meta('../../etc', 7),
      (e: unknown) => e instanceof StagingError && e.code === 'not_found'
    );
  });

  test('appends by offset: append, retry-overwrite, and gap refused', async () => {
    const job = await staging.create('import', 7, { filename: 'a.zip', size: 6 });
    assert.equal(await staging.appendChunk(job.id, 7, 0, Buffer.from('abc')), 3);
    // retry of the same chunk
    assert.equal(await staging.appendChunk(job.id, 7, 0, Buffer.from('abc')), 3);
    await assert.rejects(
      staging.appendChunk(job.id, 7, 5, Buffer.from('z')),
      (e: unknown) => e instanceof StagingError && e.code === 'offset_mismatch' && e.offset === 3
    );
    assert.equal(await staging.appendChunk(job.id, 7, 3, Buffer.from('def')), 6);
    assert.equal(readFileSync(staging.filePath(job.id, 'upload.zip'), 'utf8'), 'abcdef');
  });

  test('once the package has been analysed, it can no longer be changed', async () => {
    const job = await staging.create('import', 7, {
      filename: 'a.zip',
      size: 3,
      phase: 'uploading',
    });
    await staging.appendChunk(job.id, 7, 0, Buffer.from('ab'));
    await staging.updateInfo(job.id, 7, { phase: 'analyzed' });
    await assert.rejects(
      staging.appendChunk(job.id, 7, 2, Buffer.from('c')),
      (e: unknown) => e instanceof StagingError && e.code === 'closed'
    );
  });

  test('refuses to grow past the declared size or the cap', async () => {
    await assert.rejects(
      staging.create('import', 7, { filename: 'a.zip', size: 101 }),
      /too large/
    );
    const job = await staging.create('import', 7, { filename: 'a.zip', size: 2 });
    await assert.rejects(staging.appendChunk(job.id, 7, 0, Buffer.from('abc')), /declared size/);
  });

  test('JSON documents are written atomically and read back', async () => {
    const job = await staging.create('export', 7, {});
    await staging.writeJson(job.id, 'state.json', { cursor: 3 });
    assert.deepEqual(await staging.readJson(job.id, 'state.json'), { cursor: 3 });
    assert.equal(await staging.readJson(job.id, 'missing.json'), null);
    assert.throws(() => staging.filePath(job.id, '../x'), StagingError);
  });

  test('one import at a time: the lock is exclusive until released or stale', async () => {
    const a = await staging.acquireLock('j1', 1_000);
    assert.equal(a, true);
    assert.equal(await staging.acquireLock('j2', 1_000), false);
    assert.equal(await staging.acquireLock('j1', 1_000), true, 're-entrant for the holder');
    await staging.releaseLock('j1');
    assert.equal(await staging.acquireLock('j2', 1_000), true);
    // stale after the timeout
    utimesSync(join(root, 'import.lock'), new Date(0), new Date(0));
    assert.equal(await staging.acquireLock('j3', 1_000), true);
    await staging.releaseLock('j3');
  });

  test('named locks are independent — one per job keeps two tabs from stepping the same job at once', async () => {
    const job = await staging.create('import', 7, {});
    const name = `step-${job.id}.lock`;
    assert.equal(await staging.acquireLock('request-a', 60_000, name), true);
    assert.equal(await staging.acquireLock('request-b', 60_000, name), false);
    assert.equal(
      await staging.acquireLock('j9', 60_000),
      true,
      'the import lock is a different lock'
    );
    await staging.releaseLock('request-a', name);
    assert.equal(await staging.acquireLock('request-b', 60_000, name), true);
    await staging.releaseLock('request-b', name);
    await staging.releaseLock('j9');
    await assert.rejects(staging.acquireLock('x', 1, '../escape.lock'), StagingError);
  });

  test('a cancel request is a flag the running step picks up', async () => {
    const job = await staging.create('import', 7, {});
    assert.equal(await staging.isCancelRequested(job.id), false);
    await staging.requestCancel(job.id, 7);
    assert.equal(await staging.isCancelRequested(job.id), true);
    await assert.rejects(staging.requestCancel(job.id, 8), StagingError);
  });

  test('cleanup removes jobs older than the TTL and keeps fresh ones', async () => {
    const old = await staging.create('export', 7, {});
    const fresh = await staging.create('export', 7, {});
    const oldDir = join(root, old.id);
    utimesSync(join(oldDir, 'meta.json'), new Date(0), new Date(0));
    const removed = await staging.cleanupExpired(Date.now());
    assert.ok(removed >= 1);
    assert.equal(existsSync(oldDir), false);
    assert.ok(statSync(join(root, fresh.id)).isDirectory());
  });

  test('remove deletes a job', async () => {
    const job = await staging.create('export', 7, {});
    await staging.remove(job.id, 7);
    await assert.rejects(
      staging.meta(job.id, 7),
      (e: unknown) => e instanceof StagingError && e.code === 'not_found'
    );
  });
});
