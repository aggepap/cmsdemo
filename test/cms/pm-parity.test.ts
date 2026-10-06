/**
 * Parity with what Product Manager actually sends and reads.
 *
 * Each case here is a shape PM's Laravel side really produces (or expects), and
 * which the bridge used to drop, refuse or — worst — coerce to an empty list
 * that wiped the stored value.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.NEXT_PUBLIC_SITE_URL = 'https://praion.gr';

import { defineCollection, defineConfig, f, resolveCollection } from '@/cms/config';
import { exposedCollections } from '@/cms/modules/pm/catalogue';
import {
  draftProductInput,
  mapWithLimit,
  parseCreateBody,
  pmImageHosts,
  uploadsToDiscard,
} from '@/cms/modules/pm/create';
import { translationLinks, wooCompat, type PmItem } from '@/cms/modules/pm/dto';
import { htmlToPlainText } from '@/cms/modules/pm/mapping';
import { __testables } from '@/cms/modules/pm/write';
import { productCollection } from '@/cms/modules/commerce';
import siteConfig from '@/site.config';

const { coerceSeoValue, imageAltEntries, parseSeoOverride } = __testables;

const UUID = '5c1e2a3b-1111-4222-8333-444455556666';

describe('repeater shapes PM sends', () => {
  test('focus_keywords accepts strings, {keyword} rows and a {rows} wrapper', () => {
    const want = [{ keyword: 'a' }, { keyword: 'b' }];
    assert.deepEqual(coerceSeoValue('focus_keywords', ['a', 'b']), want);
    assert.deepEqual(coerceSeoValue('focus_keywords', [{ keyword: 'a' }, { keyword: 'b' }]), want);
    assert.deepEqual(coerceSeoValue('focus_keywords', { rows: [{ keyword: 'a' }, 'b'] }), want);
  });

  test('key_facts accepts strings, {fact} rows and a {rows} wrapper', () => {
    const want = [{ fact: 'x' }];
    assert.deepEqual(coerceSeoValue('key_facts', ['x']), want);
    assert.deepEqual(coerceSeoValue('key_facts', [{ fact: 'x' }]), want);
    assert.deepEqual(coerceSeoValue('key_facts', { rows: [{ fact: 'x' }] }), want);
  });

  test('faqs and pros_cons unwrap {rows}', () => {
    assert.deepEqual(coerceSeoValue('faqs', { rows: [{ question: 'Q?', answer: 'A.' }] }), [
      { question: 'Q?', answer: 'A.' },
    ]);
    assert.deepEqual(coerceSeoValue('pros_cons', { rows: [{ pro: 'p', con: 'c' }] }), [{ pro: 'p', con: 'c' }]);
  });

  test('an empty list still clears the field — that is a real instruction', () => {
    assert.deepEqual(coerceSeoValue('faqs', []), []);
    assert.deepEqual(coerceSeoValue('focus_keywords', { rows: [] }), []);
  });

  test('a non-empty list in a shape we do not understand is refused, never written as []', () => {
    assert.throws(() => coerceSeoValue('focus_keywords', [{ term: 'a' }]), { name: 'FieldError' });
    assert.throws(() => coerceSeoValue('faqs', [{ q: 'Q', a: 'A' }]), { name: 'FieldError' });
    assert.throws(() => coerceSeoValue('key_facts', 'not a list'), { name: 'FieldError' });
  });

  test('FAQ answers and the answer summary arrive as HTML and are stored as plain text', () => {
    assert.deepEqual(
      coerceSeoValue('faqs', [{ question: 'Q?', answer: '<p>Yes, <strong>we</strong> ship &amp; deliver.</p>' }]),
      [{ question: 'Q?', answer: 'Yes, we ship & deliver.' }],
    );
    assert.equal(coerceSeoValue('answer_summary', '<p>One.</p><p>Two.</p>'), 'One.\n\nTwo.');
  });
});

describe('htmlToPlainText', () => {
  test('drops tags, decodes entities and keeps paragraph breaks', () => {
    assert.equal(htmlToPlainText('<p>a &lt;b&gt; &quot;c&quot; &#39;d&#39;</p><p>e<br>f</p>'), 'a <b> "c" \'d\'\n\ne\nf');
  });

  test('leaves plain text alone', () => {
    assert.equal(htmlToPlainText('just text'), 'just text');
  });
});

describe('image_alts inside values', () => {
  test('the id is the media uuid the read handed out', () => {
    assert.deepEqual(imageAltEntries([{ image_id: UUID, alt: 'Front' }, { id: UUID, alt: 'Side' }]), [
      { media_id: UUID, alt: 'Front' },
      { media_id: UUID, alt: 'Side' },
    ]);
  });

  test('a numeric id is never read as a position', () => {
    // PM's `(int)` cast turns "5c1e…" into 5; treating that as "the sixth image"
    // would put one image's alt on another. It is passed through as an id that
    // matches nothing, so the push reports it instead.
    assert.deepEqual(imageAltEntries([{ image_id: 5, alt: 'Side' }]), [{ media_id: '5', alt: 'Side' }]);
  });

  test('rows with no alt are dropped rather than blanking an existing alt', () => {
    assert.deepEqual(imageAltEntries([{ image_id: UUID, alt: '  ' }, { image_id: UUID }]), []);
  });

  test('anything but a list is refused', () => {
    assert.equal(imageAltEntries('nope'), null);
    assert.equal(imageAltEntries({ image_id: UUID }), null);
  });
});

describe('seo_override inside values', () => {
  test('accepts a boolean', () => {
    assert.equal(parseSeoOverride(true), true);
    assert.equal(parseSeoOverride(false), false);
  });

  test('refuses anything else', () => {
    assert.throws(() => parseSeoOverride('yes'), { name: 'FieldError' });
  });
});

const baseItem = (over: Partial<PmItem> = {}): PmItem => ({
  id: 7,
  remote_type: 'product',
  content_type: 'product',
  remote_id: 'doc:7',
  name: 'Mug',
  slug: 'mug',
  status: 'draft',
  permalink: 'https://praion.gr/shop/mug',
  locale: 'el',
  description: null,
  short_description: 'A mug',
  images: [],
  seo: {
    seo_title: 'Mug title',
    meta_description: 'Mug meta',
    focus_keywords: ['mug'],
    og_title: null,
    og_description: null,
    og_image: null,
    twitter_card: null,
    canonical_url: null,
    robots: 'index, follow',
    include_in_sitemap: true,
    schema_raw_override: null,
    faqs: [],
    key_facts: [],
    answer_summary: null,
    pros_cons: [],
  },
  modified_at: null,
  editable: [],
  formats: {},
  translation_group: null,
  translations: [],
  sku: 'M-1',
  price: 12.5,
  currency: 'EUR',
  categories: [],
  tags: [],
  ...over,
});

describe('product items in the shape ProductSyncService reads', () => {
  test('carry type, the pm{} field block and regular_price', () => {
    const item = wooCompat(baseItem());
    assert.equal(item.type, 'simple');
    assert.equal(item.regular_price, 12.5);
    assert.equal(item.pm?.seo_title, 'Mug title');
    assert.deepEqual(item.pm?.focus_keywords, ['mug']);
  });

  test('leave the existing keys untouched', () => {
    const item = wooCompat(baseItem());
    assert.equal(item.seo.seo_title, 'Mug title');
    assert.equal(item.price, 12.5);
  });

  test('other page types are not given product keys', () => {
    const item = wooCompat(baseItem({ remote_type: 'wp_post', content_type: 'booking' }));
    assert.equal(item.type, undefined);
    assert.equal(item.pm, undefined);
  });
});

describe('translationLinks', () => {
  test('lists every other language version of the same group', () => {
    const links = translationLinks({ id: 7, translationGroupId: 'g1' }, [
      { id: 7, locale: 'el' },
      { id: 9, locale: 'en' },
    ]);
    assert.deepEqual(links, { translation_group: 'g1', translations: [{ locale: 'en', remote_id: 'doc:9' }] });
  });

  test('a document without a group has no translations', () => {
    assert.deepEqual(translationLinks({ id: 7, translationGroupId: null }, []), {
      translation_group: null,
      translations: [],
    });
  });
});

describe('module gating', () => {
  const config = defineConfig({
    name: 'Test',
    locales: ['el'],
    defaultLocale: 'el',
    modules: { commerce: true, booking: true, pm: true },
    collections: [
      defineCollection({ key: 'product', label: 'P', module: 'commerce', pmPageType: 'product', fields: [f.text('title')] }),
      defineCollection({ key: 'booking', label: 'B', module: 'booking', pmPageType: 'wp_post', fields: [f.text('title')] }),
    ],
  });

  test('without flags, every collection with a page type is exposed', () => {
    assert.deepEqual(exposedCollections(config).map((c) => c.key).sort(), ['booking', 'product']);
  });

  test('a collection whose module is off is not exposed', () => {
    const keys = exposedCollections(config, { commerce: false, booking: true }).map((c) => c.key);
    assert.deepEqual(keys, ['booking']);
  });
});

describe('POST /products body', () => {
  test('requires a name and an idempotency key', () => {
    assert.equal(parseCreateBody({ idempotency_key: 'k' }).ok, false);
    assert.equal(parseCreateBody({ name: 'Mug' }).ok, false);
    assert.equal(parseCreateBody([]).ok, false);
  });

  test('rejects an oversized or odd idempotency key', () => {
    assert.equal(parseCreateBody({ name: 'Mug', idempotency_key: 'x'.repeat(200) }).ok, false);
    assert.equal(parseCreateBody({ name: 'Mug', idempotency_key: 'a b' }).ok, false);
  });

  test('keeps only images with a src, and at most 20', () => {
    const images = Array.from({ length: 25 }, (_, i) => ({ local_id: `L${i}`, src: `https://pm.test/i/${i}`, alt: 'a' }));
    const parsed = parseCreateBody({ name: 'Mug', idempotency_key: 'k1', images: [...images, { local_id: 'x' }] });
    assert.ok(parsed.ok);
    assert.equal(parsed.input.images.length, 20);
    assert.deepEqual(parsed.input.images[0], { localId: 'L0', src: 'https://pm.test/i/0', alt: 'a' });
  });
});

describe('the draft a create produces', () => {
  const collection = resolveCollection(productCollection());

  test('is always a draft, whatever status PM asked for', () => {
    const parsed = parseCreateBody({ name: 'Mug', idempotency_key: 'k', status: 'publish' });
    assert.ok(parsed.ok);
    const draft = draftProductInput(collection, parsed.input, 'el');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.locale, 'el');
  });

  test('derives the slug from the name when none is given', () => {
    const parsed = parseCreateBody({ name: 'Κούπα Mug', idempotency_key: 'k' });
    assert.ok(parsed.ok);
    assert.match(draftProductInput(collection, parsed.input, 'el').slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  test('maps name, sku and short description; ignores an HTML body for a rich-text field', () => {
    const parsed = parseCreateBody({
      name: 'Mug',
      sku: 'M-1',
      short_description: 'A mug',
      description: '<p>Long</p>',
      idempotency_key: 'k',
    });
    assert.ok(parsed.ok);
    const draft = draftProductInput(collection, parsed.input, 'el');
    assert.equal(draft.data.title, 'Mug');
    assert.equal(draft.data.sku, 'M-1');
    assert.equal(draft.data.subtitle, 'A mug');
    assert.equal(draft.data.description, undefined);
    assert.deepEqual(draft.ignored, ['description']);
  });
});

describe('pmImageHosts', () => {
  test('parses a comma list and drops blanks', () => {
    assert.deepEqual(pmImageHosts(' app.praion.ai , ,cdn.praion.ai'), ['app.praion.ai', 'cdn.praion.ai']);
  });

  test('unset means no host is allowed', () => {
    assert.deepEqual(pmImageHosts(undefined), []);
  });
});

describe('this site exposes its pages to PM', () => {
  test('the page collection is a wp_page', () => {
    const page = siteConfig.collectionByKey.get('page');
    assert.equal(page?.pmPageType, 'wp_page');
  });

  test('custom page-type collections stay valid', () => {
    const c = resolveCollection(
      defineCollection({ key: 'x', label: 'X', pmPageType: 'wp_page', fields: [f.text('title')] }),
    );
    assert.equal(c.pmPageType, 'wp_page');
  });
});

describe('mapWithLimit', () => {
  test('runs at most `limit` at once and keeps input order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running -= 1;
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 3);
  });

  test('runs in parallel rather than one after another', async () => {
    const started = Date.now();
    await mapWithLimit([1, 2, 3, 4], 4, () => new Promise((r) => setTimeout(r, 50)));
    assert.ok(Date.now() - started < 150, 'four 50ms jobs at limit 4 should take about 50ms');
  });

  test('an empty list does nothing', async () => {
    assert.deepEqual(await mapWithLimit([], 4, async () => 1), []);
  });
});

describe('uploadsToDiscard', () => {
  test('only files this create uploaded, never ones the library already had', () => {
    assert.deepEqual(
      uploadsToDiscard([
        { uuid: 'a', fresh: true },
        null,
        { uuid: 'b', fresh: false },
        { uuid: 'c', fresh: true },
      ]),
      ['a', 'c'],
    );
  });
});
