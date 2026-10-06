/**
 * Cached reads outside Next (F-002).
 *
 * `unstable_cache` throws "incrementalCache missing" when there is no Next server
 * around it — every seed CLI. `getSetting` caught that as a DB failure, logged it
 * for every read and returned null, so a CLI saw every setting as unset (custom
 * fields, SEO field overrides, module toggles). Outside Next there is nothing to
 * cache, so the read goes straight to the source instead.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { cmsCached } from '@/cms/core/cached-read';

describe('cmsCached', () => {
  test('outside a Next server it runs the read directly', async () => {
    let calls = 0;
    const read = cmsCached(async (key: string) => {
      calls += 1;
      return `value:${key}`;
    }, ['test-cached-read'], { tags: ['t'] });
    assert.equal(await read('a'), 'value:a');
    assert.equal(calls, 1);
  });

  test('a real failure of the read itself still throws', async () => {
    const read = cmsCached(async () => {
      throw new Error('db down');
    }, ['test-cached-read-fail'], { tags: ['t'] });
    await assert.rejects(read(), /db down/);
  });
});

describe('wiring', () => {
  test('settings read through it', () => {
    const src = readFileSync(new URL('../../src/cms/core/settings/index.ts', import.meta.url), 'utf8');
    assert.match(src, /cmsCached\(/);
    assert.doesNotMatch(src, /unstable_cache\(/);
  });
});
