import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * The redirect import and the pending-mapping endpoint write redirects in bulk
 * or ahead of time, so they must be held to exactly what the one-at-a-time
 * create is held to: the same permission, the same audit trail, the same
 * validation.
 */

const API = 'src/app/api/cms/seo/redirects';
const routes = readFileSync('src/cms/core/routes/seo.ts', 'utf8');

function factory(name: string): string {
  const start = routes.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = routes.indexOf('\nexport ', start + 1);
  return routes.slice(start, next < 0 ? undefined : next);
}

describe('redirect import and pending route files', () => {
  for (const [file, exported] of [
    [`${API}/import/route.ts`, 'redirectImportRoute'],
    [`${API}/pending/route.ts`, 'redirectPendingCreateRoute'],
  ] as const) {
    test(`${file} is a POST on Node, uncached`, () => {
      const src = readFileSync(file, 'utf8');
      assert.match(src, new RegExp(`export const POST = ${exported}\\(\\)`));
      assert.match(src, /export const runtime = 'nodejs'/);
      assert.match(src, /export const dynamic = 'force-dynamic'/);
    });
  }
});

describe('redirect import and pending route factories', () => {
  const create = factory('redirectCreateRoute');
  const guard = /guard: \(\) => requireApiPerm\(PERMISSIONS\.seoWrite\)/;

  test('use the same permission check as creating one redirect', () => {
    assert.match(create, guard);
    assert.match(factory('redirectImportRoute'), guard);
    assert.match(factory('redirectPendingCreateRoute'), guard);
  });

  test('a committed import is audited; a preview writes nothing and is not', () => {
    const src = factory('redirectImportRoute');
    assert.match(src, /action: 'redirect\.import'/);
    const preview = src.indexOf('if (!input.commit)');
    const audit = src.indexOf("action: 'redirect.import'");
    const apply = src.indexOf('applyRedirectImport(');
    assert.ok(preview > 0 && apply > preview && audit > apply, 'preview returns before anything is written');
  });

  test('creating a pending mapping is audited', () => {
    assert.match(factory('redirectPendingCreateRoute'), /action: 'redirect\.pending'/);
  });

  test('the import bounds its input before parsing it', () => {
    assert.match(factory('redirectImportRoute'), /input: redirectImportBody/);
    assert.match(routes, /csv: z\.string\(\)\.max\(REDIRECT_CSV_MAX_BYTES\)/);
  });

  test('switching a rule on checks that it is not a pending mapping without a target', () => {
    assert.match(factory('redirectUpdateRoute'), /pendingActivationProblem\(/);
  });
});
