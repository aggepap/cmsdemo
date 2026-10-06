/**
 * "You may also like" on a product page.
 *
 * An editor picks the products by hand (`related`, shared across languages like
 * every other relation on a product). Until they do, the page falls back to
 * other products in the same category — so the section is useful on day one
 * and an editor's choice always wins.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { RelationField } from '@/cms/config';
import { f } from '@/cms/config/fields';
import { buildDataSchema } from '@/cms/config/zod';
import { productCollection } from '@/cms/modules/commerce/collection';
import {
  RELATED_PRODUCTS_LIMIT,
  resolveRelatedProducts,
  type RelatedCandidate,
} from '@/cms/modules/commerce/read';

const row = (id: number, slug: string, over: Partial<RelatedCandidate> = {}): RelatedCandidate => ({
  id,
  slug,
  status: 'published',
  scheduledFor: null,
  data: {},
  ...over,
});

const self = { id: 1, slug: 'shirt', data: { related: [11, 12, 13], categories: [100] } };

/** Loaders that record what they were asked for. */
function loaders(manual: RelatedCandidate[], refs: { id: number; slug: string }[], sameCategory: RelatedCandidate[] = []) {
  const calls = { manual: [] as number[][], sameCategory: [] as number[][] };
  return {
    calls,
    load: {
      manual: async (ids: number[]) => {
        calls.manual.push(ids);
        return { refs, rows: manual };
      },
      sameCategory: async (categoryIds: number[]) => {
        calls.sameCategory.push(categoryIds);
        return sameCategory;
      },
    },
  };
}

describe('the related field', () => {
  const field = productCollection().fields.find((x) => x.key === 'related') as RelationField | undefined;

  test('is a bounded, shared, many-product relation with help text', () => {
    assert.ok(field, 'product has a `related` field');
    assert.equal(field.kind, 'relation');
    assert.equal(field.to, 'product');
    assert.equal(field.many, true);
    assert.equal(field.shared, true);
    assert.equal(field.max, RELATED_PRODUCTS_LIMIT);
    assert.ok(field.label);
    assert.ok(String(field.description ?? '').trim());
  });

  test('a relation with a max refuses more than that many ids', () => {
    const s = buildDataSchema([f.relation('r', { to: 'x', many: true, max: 2 })], ['en']);
    assert.equal(s.safeParse({ r: [1, 2] }).success, true);
    assert.equal(s.safeParse({ r: [1, 2, 3] }).success, false);
  });
});

describe('resolveRelatedProducts — picked by hand', () => {
  test('keeps the editor’s order, through each id’s slug', async () => {
    const { load } = loaders(
      [row(23, 'c'), row(21, 'a'), row(22, 'b')],
      [{ id: 11, slug: 'a' }, { id: 12, slug: 'b' }, { id: 13, slug: 'c' }],
    );
    const res = await resolveRelatedProducts(self, load);
    assert.equal(res.source, 'manual');
    assert.deepEqual(res.products.map((p) => p.slug), ['a', 'b', 'c']);
  });

  test('drops the product itself, unpublished ones, deleted ones and hidden ones', async () => {
    const { load } = loaders(
      [
        row(1, 'shirt'),
        row(21, 'draft', { status: 'draft' }),
        row(22, 'later', { status: 'scheduled', scheduledFor: new Date(Date.now() + 86_400_000) }),
        row(23, 'hidden', { data: { visibility: 'hidden' } }),
        row(24, 'ok'),
      ],
      [
        { id: 1, slug: 'shirt' },
        { id: 11, slug: 'draft' },
        { id: 12, slug: 'later' },
        { id: 13, slug: 'hidden' },
        { id: 14, slug: 'ok' },
        // 15 was deleted: no ref, no row.
      ],
    );
    const res = await resolveRelatedProducts({ ...self, data: { related: [1, 11, 12, 13, 15, 14] } }, load);
    assert.deepEqual(res.products.map((p) => p.slug), ['ok']);
  });

  test('loads every picked product in one batch, and never the fallback', async () => {
    const { load, calls } = loaders([row(21, 'a')], [{ id: 11, slug: 'a' }]);
    await resolveRelatedProducts({ ...self, data: { related: [11, 11, 'x', -3, 12], categories: [100] } }, load);
    assert.deepEqual(calls.manual, [[11, 12]]);
    assert.equal(calls.sameCategory.length, 0);
  });

  test('never shows more than the limit', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => 1000 + i);
    const { load, calls } = loaders(
      ids.map((id) => row(id, `p${id}`)),
      ids.map((id) => ({ id, slug: `p${id}` })),
    );
    const res = await resolveRelatedProducts({ ...self, data: { related: ids } }, load);
    assert.equal(res.products.length, RELATED_PRODUCTS_LIMIT);
    assert.ok((calls.manual[0]?.length ?? 0) <= RELATED_PRODUCTS_LIMIT * 2);
  });
});

describe('resolveRelatedProducts — same-category fallback', () => {
  test('with nothing picked, shows other products in the same categories', async () => {
    const { load, calls } = loaders([], [], [row(1, 'shirt'), row(31, 'x'), row(32, 'y'), row(31, 'x')]);
    const res = await resolveRelatedProducts({ ...self, data: { categories: [100, 101] } }, load);
    assert.equal(res.source, 'category');
    assert.deepEqual(res.products.map((p) => p.slug), ['x', 'y']);
    assert.deepEqual(calls.manual, []);
    assert.deepEqual(calls.sameCategory, [[100, 101]]);
  });

  test('when every pick is gone, it falls back rather than showing nothing', async () => {
    const { load } = loaders([], [], [row(31, 'x')]);
    const res = await resolveRelatedProducts(self, load);
    assert.equal(res.source, 'category');
    assert.deepEqual(res.products.map((p) => p.slug), ['x']);
  });

  test('the fallback is bounded too', async () => {
    const many = Array.from({ length: 40 }, (_, i) => row(100 + i, `c${i}`));
    const { load } = loaders([], [], many);
    const res = await resolveRelatedProducts({ ...self, data: { categories: [100] } }, load);
    assert.equal(res.products.length, RELATED_PRODUCTS_LIMIT);
  });

  test('no picks and no categories: nothing, and no query for it', async () => {
    const { load, calls } = loaders([], []);
    const res = await resolveRelatedProducts({ ...self, data: {} }, load);
    assert.deepEqual(res, { source: 'none', products: [] });
    assert.equal(calls.sameCategory.length, 0);
  });
});

describe('wiring', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

  test('the database loaders query by batch (inArray), not one row at a time', () => {
    const src = read('src/cms/modules/commerce/read.ts');
    const start = src.indexOf('async function readRelatedProducts(');
    assert.ok(start > 0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(body, /inArray\(schema\.documents\.id, /);
    assert.match(body, /inArray\(schema\.documents\.slug, /);
    assert.doesNotMatch(body, /for \(/);
    assert.match(body, /\.limit\(/);
  });

  test('the product page renders the related products', () => {
    const page = read('src/app/[locale]/shop/[slug]/page.tsx');
    assert.match(page, /getRelatedProducts\(doc, locale\)/);
    assert.match(page, /<RelatedProducts /);
  });
});
