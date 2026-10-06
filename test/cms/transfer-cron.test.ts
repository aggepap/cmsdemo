import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * Staged packages can hold customer data. They must not outlive their use just
 * because nobody pressed "Delete": the scheduler removes them after the TTL.
 */
describe('transfer-cleanup cron job', () => {
  test('is registered with the scheduler and runs the staging cleanup', () => {
    const src = readFileSync('src/app/api/cms/cron/[job]/route.ts', 'utf8');
    assert.match(src, /'transfer-cleanup': \{ run: cleanupTransfers \}/);
    const runtime = readFileSync('src/cms/core/transfer/runtime.ts', 'utf8');
    assert.match(runtime, /export async function cleanupTransfers\(/);
    assert.match(runtime, /cleanupExpired\(Date\.now\(\)\)/);
  });
});
