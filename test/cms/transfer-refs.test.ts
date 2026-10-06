import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildDataSchema } from '@/cms/config';
import { f, type Field } from '@/cms/config/fields';
import {
  collectRefs,
  pruneToSchema,
  rewriteData,
  type RefResolver,
} from '@/cms/core/transfer/refs';

/**
 * The reference walker is what makes an import land on the RIGHT documents.
 * Relation ids and media uuids in `data` are the source site's; written as-is on
 * another site they point at whatever happens to hold that id there — which is
 * exactly the bug `db:seed-content` shipped with.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

const productFields: Field[] = [
  f.text('title', { localized: true }),
  f.image('hero'),
  f.relation('categories', { to: 'category', many: true }),
  f.relation('sizeChart', { to: 'sizechart' }),
  f.repeater('gallery', [f.image('image', { required: true }), f.text('caption')]),
  f.repeater('components', [
    f.relation('product', { to: 'product', required: true }),
    f.number('qty'),
  ]),
  f.group('seo', [f.image('ogImage'), f.text('title')]),
  f.image('banner', { localized: true }),
  f.variations('variations'),
  f.textarea('notes'),
  f.group('custom', [f.relation('brand', { to: 'brand' })], { strict: false }),
];

const data = {
  title: { el: 'Τίτλος', en: 'Title' },
  hero: UUID_A,
  categories: [10, 11],
  sizeChart: 12,
  gallery: [{ image: UUID_B, caption: 'one' }],
  components: [{ product: 13, qty: 2 }],
  seo: { ogImage: UUID_C, title: 'x' },
  banner: { el: UUID_A, en: UUID_B },
  variations: [{ id: 'v1', options: { Size: 'M' }, image: UUID_C }],
  notes: `See /api/cms/media/file/${UUID_A} for details`,
  custom: { brand: 14, legacy: 'kept' },
};

describe('collectRefs', () => {
  test('finds every document id and media uuid, however deeply nested', () => {
    const refs = collectRefs(productFields, data);
    const docs = refs
      .filter((r) => r.kind === 'doc')
      .map((r) => `${r.path}=${r.value}@${r.collection}`);
    assert.deepEqual(docs.sort(), [
      'categories.0=10@category',
      'categories.1=11@category',
      'components.0.product=13@product',
      'custom.brand=14@brand',
      'sizeChart=12@sizechart',
    ]);
    const media = refs.filter((r) => r.kind === 'media').map((r) => `${r.path}=${r.value}`);
    assert.deepEqual(media.sort(), [
      `banner.el=${UUID_A}`,
      `banner.en=${UUID_B}`,
      `gallery.0.image=${UUID_B}`,
      `hero=${UUID_A}`,
      `notes=${UUID_A}`,
      `seo.ogImage=${UUID_C}`,
      `variations.0.image=${UUID_C}`,
    ]);
  });

  test('ignores values that are not references (strings in relation fields, junk uuids)', () => {
    const refs = collectRefs([f.relation('r', { to: 'x' }), f.image('i')], {
      r: 'abc',
      i: 'not-a-uuid',
    });
    assert.deepEqual(refs, []);
  });
});

describe('rewriteData', () => {
  const resolver: RefResolver = {
    doc: (id) => ({ 10: 110, 11: null, 12: 112, 13: 113, 14: null })[id] ?? null,
    media: (uuid) => (uuid === UUID_A ? UUID_C : uuid === UUID_B ? null : uuid),
  };

  test('maps every reference through the resolver', () => {
    const { data: out } = rewriteData(productFields, data, resolver);
    assert.deepEqual(out.categories, [110]);
    assert.equal(out.sizeChart, 112);
    assert.deepEqual(out.components, [{ product: 113, qty: 2 }]);
    assert.equal(out.hero, UUID_C);
    assert.deepEqual(out.banner, { el: UUID_C });
    assert.equal(out.notes, `See /api/cms/media/file/${UUID_C} for details`);
  });

  test('an unresolved single reference is removed (the validator refuses null) and a list drops it; both are reported', () => {
    const { data: out, dropped } = rewriteData(productFields, data, resolver);
    assert.deepEqual(out.custom, { legacy: 'kept' });
    assert.equal('custom' in out && 'brand' in (out.custom as object), false);
    const paths = dropped.map((d) => d.path).sort();
    assert.ok(paths.includes('categories.1'));
    assert.ok(paths.includes('custom.brand'));
    assert.ok(paths.includes('banner.en'));
  });

  test('a repeater row whose REQUIRED reference was dropped is removed, not left invalid', () => {
    const { data: out } = rewriteData(productFields, data, resolver);
    assert.deepEqual(out.gallery, []);
  });

  test('a repeater row whose relation was dropped is removed — a component without its product means nothing', () => {
    const fields = [
      f.repeater('components', [f.relation('product', { to: 'product' }), f.number('quantity')]),
    ];
    const { data: out } = rewriteData(
      fields,
      {
        components: [
          { product: 1, quantity: 2 },
          { product: 2, quantity: 1 },
        ],
      },
      { doc: (id) => (id === 1 ? null : id), media: (u) => u }
    );
    assert.deepEqual(out.components, [{ product: 2, quantity: 1 }]);
  });

  test('whatever is dropped, the result still passes the real validator', () => {
    const fields = [
      f.relation('sizeChart', { to: 'sizechart' }),
      f.image('hero'),
      f.image('banner', { localized: true }),
      f.relation('categories', { to: 'category', many: true }),
      f.repeater('gallery', [f.image('image'), f.text('alt')]),
      f.repeater('components', [f.relation('product', { to: 'product' }), f.number('quantity')]),
    ];
    const input = {
      sizeChart: 5,
      hero: UUID_A,
      banner: { el: UUID_A, en: UUID_B },
      categories: [5, 6],
      gallery: [{ image: UUID_A, alt: 'x' }],
      components: [{ product: 5, quantity: 1 }],
    };
    const { data: out } = rewriteData(fields, input, { doc: () => null, media: () => null });
    const schema = buildDataSchema(fields, ['el', 'en'], {
      enforceRequired: true,
      defaultLocale: 'el',
    });
    const parsed = schema.safeParse(out);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
  });

  test('does not mutate its input', () => {
    const copy = structuredClone(data);
    rewriteData(productFields, data, resolver);
    assert.deepEqual(data, copy);
  });

  test('the identity resolver leaves data unchanged', () => {
    const { data: out, dropped } = rewriteData(productFields, data, {
      doc: (id) => id,
      media: (u) => u,
    });
    assert.deepEqual(out, data);
    assert.deepEqual(dropped, []);
  });
});

describe('pruneToSchema', () => {
  test('drops keys the target schema does not declare, and says which', () => {
    const { data: out, droppedKeys } = pruneToSchema(
      [f.text('title'), f.group('seo', [f.text('title')])],
      { title: 'x', obsolete: 1, seo: { title: 'y', gone: true } },
      { el: 'el' }
    );
    assert.deepEqual(out, { title: 'x', seo: { title: 'y' } });
    assert.deepEqual(droppedKeys.sort(), ['obsolete', 'seo.gone']);
  });

  test('keeps unknown keys inside a non-strict group', () => {
    const { data: out } = pruneToSchema(
      [f.group('custom', [], { strict: false })],
      { custom: { a: 1 } },
      {}
    );
    assert.deepEqual(out, { custom: { a: 1 } });
  });

  test('re-keys localized values through the locale map, inside repeaters too', () => {
    const fields = [
      f.text('title', { localized: true }),
      f.repeater('rows', [f.text('t', { localized: true })]),
    ];
    const { data: out } = pruneToSchema(
      fields,
      { title: { el: 'a', en: 'b' }, rows: [{ t: { el: 'c', en: 'd' } }] },
      { el: 'el', en: null }
    );
    assert.deepEqual(out, { title: { el: 'a' }, rows: [{ t: { el: 'c' } }] });
  });
});
