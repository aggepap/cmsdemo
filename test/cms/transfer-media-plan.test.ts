import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { planMediaImport } from '@/cms/core/transfer/media-plan';

/**
 * Imported media is stored byte-for-byte (re-encoding would change its hash and
 * its quality), so the checks the upload route does on the way in are done here:
 * the TYPE comes from the bytes, never from the package, and a file the library
 * already holds is reused rather than stored twice.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const SRC = '11111111-1111-4111-8111-111111111111';
const NEW = '99999999-9999-4999-8999-999999999999';

describe('planMediaImport', () => {
  test('reuses a file this site already holds, by content', () => {
    assert.deepEqual(
      planMediaImport({
        sourceUuid: SRC,
        bytes: PNG,
        existingByHash: 'aaaa',
        sourceUuidTaken: true,
        newUuid: () => NEW,
      }),
      { kind: 'reuse', uuid: 'aaaa' }
    );
  });

  test('keeps the source uuid when it is free, so links in text keep working', () => {
    assert.deepEqual(
      planMediaImport({
        sourceUuid: SRC,
        bytes: PNG,
        existingByHash: null,
        sourceUuidTaken: false,
        newUuid: () => NEW,
      }),
      { kind: 'store', uuid: SRC, mime: 'image/png' }
    );
  });

  test('mints a new uuid when the source one is taken by other bytes', () => {
    assert.deepEqual(
      planMediaImport({
        sourceUuid: SRC,
        bytes: PNG,
        existingByHash: null,
        sourceUuidTaken: true,
        newUuid: () => NEW,
      }),
      { kind: 'store', uuid: NEW, mime: 'image/png' }
    );
  });

  test('refuses bytes that are not an allowed type, whatever the package says', () => {
    const plan = planMediaImport({
      sourceUuid: SRC,
      bytes: SVG,
      existingByHash: null,
      sourceUuidTaken: false,
      newUuid: () => NEW,
    });
    assert.equal(plan.kind, 'reject');
  });

  test('refuses a source uuid that is not a uuid', () => {
    const plan = planMediaImport({
      sourceUuid: '../x',
      bytes: PNG,
      existingByHash: null,
      sourceUuidTaken: false,
      newUuid: () => NEW,
    });
    assert.deepEqual(plan, { kind: 'store', uuid: NEW, mime: 'image/png' });
  });

  test('the media service stores imports without re-encoding and without trusting the declared type', () => {
    const src = readFileSync('src/cms/core/media/service.ts', 'utf8');
    const fn = src.slice(src.indexOf('export async function importMediaFile'));
    assert.ok(fn.length > 0, 'importMediaFile exists');
    assert.match(fn, /planMediaImport\(/);
    assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}\n')), /prepareUpload\(/);
  });
});
