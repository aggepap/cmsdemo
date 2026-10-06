import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RedirectCsvRow } from '@/cms/core/seo/redirect-csv';
import { planRedirectImport, summarizeImport, type ExistingRedirect } from '@/cms/core/seo/redirect-import';

/**
 * What a CSV import would do, row by row — the preview the admin reads before
 * committing, and the exact plan the commit then carries out. Every row goes
 * through the same rules as a redirect typed into the form.
 */

let line = 0;
const row = (source: string, target: string, statusCode = '', notes = ''): RedirectCsvRow => ({
  line: ++line,
  source,
  target,
  statusCode,
  notes,
});

const existing = (over: Partial<ExistingRedirect> & { id: number; source: string }): ExistingRedirect => ({
  target: '/somewhere',
  kind: 'literal',
  active: true,
  ...over,
});

describe('planRedirectImport', () => {
  test('a valid new row is created, with its status and notes', () => {
    const [r] = planRedirectImport([row('/product/blue', '/shop/blue', '302', 'old shop')], []);
    assert.equal(r.outcome, 'create');
    assert.equal(r.source, '/product/blue');
    assert.equal(r.target, '/shop/blue');
    assert.equal(r.statusCode, 302);
    assert.equal(r.notes, 'old shop');
  });

  test('a blank status means 301', () => {
    assert.equal(planRedirectImport([row('/a', '/b')], [])[0].statusCode, 301);
  });

  test('a row without a target becomes a pending mapping', () => {
    const [r] = planRedirectImport([row('/product/discontinued', '')], []);
    assert.equal(r.outcome, 'pending');
  });

  test('a trailing slash on the source is stored the way the redirect can match it', () => {
    assert.equal(planRedirectImport([row('/product/blue/', '/shop/blue')], [])[0].source, '/product/blue');
  });

  test('a row that already exists with the same target is skipped as a duplicate', () => {
    const [r] = planRedirectImport([row('/a', '/b/')], [existing({ id: 1, source: '/a', target: '/b' })]);
    assert.equal(r.outcome, 'skip');
    assert.match(r.message ?? '', /already/i);
  });

  test('an existing redirect is never overwritten by an import', () => {
    const [r] = planRedirectImport([row('/a', '/c')], [existing({ id: 1, source: '/a', target: '/b' })]);
    assert.equal(r.outcome, 'skip');
    assert.match(r.message ?? '', /\/b/);
  });

  test('a target for a source that is pending completes that pending mapping', () => {
    const [r] = planRedirectImport(
      [row('/old', '/new')],
      [existing({ id: 7, source: '/old', target: '', active: false })],
    );
    assert.equal(r.outcome, 'complete');
    assert.equal(r.existingId, 7);
  });

  test('a pending row for a source that is already listed is skipped', () => {
    const [r] = planRedirectImport([row('/old', '')], [existing({ id: 7, source: '/old', target: '', active: false })]);
    assert.equal(r.outcome, 'skip');
  });

  test('the second appearance of a source in the same file is skipped and says which line won', () => {
    line = 0;
    const out = planRedirectImport([row('/a', '/b'), row('/a/', '/c')], []);
    assert.equal(out[1].outcome, 'skip');
    assert.match(out[1].message ?? '', /line 1/);
  });

  test('a row missing its source is an error', () => {
    const [r] = planRedirectImport([row('', '/b')], []);
    assert.equal(r.outcome, 'error');
  });

  test('targets the form would refuse are refused here too', () => {
    for (const bad of ['javascript:alert(1)', '//evil.example', 'not a path']) {
      const [r] = planRedirectImport([row('/a', bad)], []);
      assert.equal(r.outcome, 'error', bad);
      assert.ok(r.message, bad);
    }
  });

  test('an unknown status code is an error', () => {
    assert.equal(planRedirectImport([row('/a', '/b', '200')], [])[0].outcome, 'error');
  });

  test('a redirect onto itself is an error', () => {
    assert.match(planRedirectImport([row('/a', '/a/')], [])[0].message ?? '', /loop/);
  });

  test('a loop through an existing active rule is an error', () => {
    const [r] = planRedirectImport([row('/b', '/a')], [existing({ id: 1, source: '/a', target: '/b' })]);
    assert.equal(r.outcome, 'error');
  });

  test('a loop formed by two rows of the same file is an error on the row that closes it', () => {
    const out = planRedirectImport([row('/x', '/y'), row('/y', '/x')], []);
    assert.equal(out[0].outcome, 'create');
    assert.equal(out[1].outcome, 'error');
  });

  test('a disabled or pending rule does not count towards a loop', () => {
    const [r] = planRedirectImport(
      [row('/b', '/a')],
      [existing({ id: 1, source: '/a', target: '/b', active: false })],
    );
    assert.equal(r.outcome, 'create');
  });

  test('summarizeImport counts each outcome', () => {
    const out = planRedirectImport([row('/s1', '/t'), row('/s2', ''), row('', '/x')], []);
    assert.deepEqual(summarizeImport(out), { create: 1, pending: 1, complete: 0, skip: 0, error: 1 });
  });

  test('a few hundred rows plan quickly', () => {
    const many = Array.from({ length: 1000 }, (_, i) => row(`/product/p-${i}`, `/shop/p-${i}`));
    const rules = Array.from({ length: 1000 }, (_, i) => existing({ id: i + 1, source: `/legacy/${i}`, target: `/x/${i}` }));
    const started = Date.now();
    const out = planRedirectImport(many, rules);
    assert.equal(summarizeImport(out).create, 1000);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
  });
});
