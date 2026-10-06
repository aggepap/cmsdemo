import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import config from '@/site.config';
import { ApiError } from '@/cms/core/errors';
import { planBodySchema, selectionSchema, stagingToApiError } from '@/cms/core/transfer/routes';
import { StagingError } from '@/cms/core/transfer/staging';

/**
 * The transfer API moves a whole site's data in and out, so every door is
 * checked here the way the rest of the admin API is checked: each route has a
 * guard, the one hand-written route repeats `createRoute`'s protections, and a
 * download is never cached.
 */

const API = 'src/app/api/cms/transfer';

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routeFiles(path) : name === 'route.ts' ? [path] : [];
  });
}

describe('transfer route files', () => {
  const files = routeFiles(API);

  test('exist for every endpoint', () => {
    const rel = files.map((f) => f.slice(API.length + 1)).sort();
    assert.deepEqual(rel, [
      'catalog/route.ts',
      'exports/[id]/download/route.ts',
      'exports/[id]/route.ts',
      'exports/[id]/step/route.ts',
      'exports/preview/route.ts',
      'exports/route.ts',
      'imports/[id]/chunk/route.ts',
      'imports/[id]/complete/route.ts',
      'imports/[id]/items/route.ts',
      'imports/[id]/plan/route.ts',
      'imports/[id]/report/route.ts',
      'imports/[id]/route.ts',
      'imports/[id]/step/route.ts',
      'imports/route.ts',
      'jobs/route.ts',
    ]);
  });

  test('run on Node, uncached', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      assert.match(src, /export const runtime = 'nodejs'/, file);
      assert.match(src, /export const dynamic = 'force-dynamic'/, file);
    }
  });

  test('the chunk upload repeats the same-origin check, rate limit and permission before reading the body', () => {
    const src = readFileSync(`${API}/imports/[id]/chunk/route.ts`, 'utf8');
    const origin = src.indexOf('isSameOrigin(req)');
    const limit = src.indexOf('checkRateLimit(');
    const perm = src.indexOf('requireApiPerm(PERMISSIONS.transferImport)');
    const length = src.indexOf("req.headers.get('content-length')");
    const body = src.indexOf('req.arrayBuffer()');
    assert.ok(
      origin > 0 && limit > origin && perm > limit && length > perm && body > length,
      'order of checks'
    );
  });
});

describe('transfer route factories', () => {
  const src = readFileSync('src/cms/core/transfer/routes.ts', 'utf8');

  test('every route has a guard on a transfer permission', () => {
    const factories = src
      .split(/\nexport function /)
      .slice(1)
      .filter((body) => /^\w+Route\(/.test(body));
    assert.ok(factories.length >= 15);
    for (const body of factories) {
      const name = body.slice(0, body.indexOf('('));
      assert.match(body, /guard: (exportGuard|importGuard)/, name);
    }
  });

  test('a download is an attachment and never cached', () => {
    assert.match(src, /'Content-Disposition': `attachment; filename=/);
    assert.match(src, /'Cache-Control': 'no-store'/);
  });

  test('downloading an export is audited', () => {
    assert.match(src, /action: 'transfer\.export'/);
  });
});

describe('request bodies', () => {
  test('a selection names groups and item keys, bounded', () => {
    assert.equal(selectionSchema.safeParse({ groups: { media: 'all' }, optOut: [] }).success, true);
    assert.equal(selectionSchema.safeParse({ groups: { media: 'some' } }).success, false);
    assert.equal(
      selectionSchema.safeParse({ groups: { media: ['x'.repeat(400)] } }).success,
      false
    );
  });

  test('a plan names only real actions', () => {
    const body = {
      decisions: {
        selection: { groups: { media: 'all' }, optOut: [] },
        defaults: { media: 'delete' },
        overrides: {},
      },
      options: { localeMap: { el: 'el' }, keepStatus: true, copiesAsDrafts: true },
    };
    assert.equal(planBodySchema.safeParse(body).success, false);
    body.decisions.defaults = { media: 'skip' };
    assert.equal(planBodySchema.safeParse(body).success, true);
  });
});

describe('stagingToApiError', () => {
  test("another user's job looks exactly like a missing one", () => {
    const a = stagingToApiError(new StagingError('forbidden', 'x'));
    const b = stagingToApiError(new StagingError('not_found', 'x'));
    assert.ok(a instanceof ApiError && b instanceof ApiError);
    assert.equal(a.status, 404);
    assert.equal(a.message, b.message);
  });

  test('an out-of-order chunk is a conflict that says where to resume', () => {
    const e = stagingToApiError(new StagingError('offset_mismatch', 'x', 42));
    assert.equal(e.status, 409);
    assert.deepEqual(e.issues, { offset: 42 });
  });
});

describe('the admin screen folder', () => {
  test('does not shadow a collection', () => {
    assert.equal(config.collectionByKey.has('transfer'), false);
    assert.equal(config.collectionKeyByAlias.has('transfer'), false);
  });
});
