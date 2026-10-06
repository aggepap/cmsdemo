import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  cookieRecordSchema,
  planChildren,
  redirectRecordSchema,
  reviewLocationRecordSchema,
  rewriteRedirect,
  rewriteReviewPhotos,
  rewriteSeoMeta,
  scriptRecordSchema,
  seoMetaRecordSchema,
  tableDeps,
  tableKey,
  zoneRecordSchema,
} from '@/cms/core/transfer/tables/rules';

/**
 * Phase B: the site-configuration tables. Each row travels with its child rows
 * (a cookie category with its services, a shipping zone with its methods, a
 * review location with its synced reviews), is matched on the target by its
 * natural key, and has its references — a redirect's document, an image URL —
 * rewritten like a document's.
 */

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('tableKey', () => {
  test('names each row by what identifies it on any site', () => {
    assert.equal(tableKey.script('chat-widget'), 'script:chat-widget');
    assert.equal(tableKey.cookie('analytics'), 'cookie:analytics');
    assert.equal(tableKey.zone('Ελλάδα'), 'shipzone:Ελλάδα');
    assert.equal(tableKey.reviewLocation('athens'), 'reviewloc:athens');
    assert.equal(tableKey.seoMeta('/about', 'en'), 'seometa:en:/about');
  });

  test('a redirect is keyed by a digest: its source can be 512 characters of regex', () => {
    const a = tableKey.redirect('/old/*', 'wildcard');
    assert.match(a, /^redirect:[0-9a-f]{24}$/);
    assert.equal(a, tableKey.redirect('/old/*', 'wildcard'));
    assert.notEqual(a, tableKey.redirect('/old/*', 'literal'));
    assert.ok(tableKey.redirect('x'.repeat(512), 'regex').length < 64);
  });
});

describe('record schemas', () => {
  test('bound every column by the database schema', () => {
    const redirect = {
      source: '/a',
      target: '/b',
      statusCode: 301,
      kind: 'literal',
      active: true,
      notes: null,
      reason: null,
      documentSid: null,
    };
    assert.equal(redirectRecordSchema.safeParse(redirect).success, true);
    assert.equal(redirectRecordSchema.safeParse({ ...redirect, kind: 'glob' }).success, false);
    assert.equal(
      redirectRecordSchema.safeParse({ ...redirect, source: 'x'.repeat(513) }).success,
      false
    );

    const meta = {
      path: '/a',
      locale: 'el',
      title: 't',
      description: null,
      robots: null,
      canonical: null,
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
    };
    assert.equal(seoMetaRecordSchema.safeParse(meta).success, true);
    assert.equal(seoMetaRecordSchema.safeParse({ ...meta, title: 'x'.repeat(256) }).success, false);

    const cookie = {
      key: 'analytics',
      name: { el: 'Α' },
      description: null,
      required: false,
      sortOrder: 1,
      services: [{ name: 'GA', provider: 'Google', purpose: null, enabled: true }],
    };
    assert.equal(cookieRecordSchema.safeParse(cookie).success, true);

    const zone = {
      name: 'Greece',
      countries: ['GR'],
      sort: 0,
      methods: [
        {
          name: 'ACS',
          courier: 'acs',
          kind: 'address',
          cost: 300,
          freeThreshold: null,
          etaMinDays: 1,
          etaMaxDays: 3,
          codAllowed: true,
          pickupLocationId: null,
          active: true,
          sort: 0,
        },
      ],
    };
    assert.equal(zoneRecordSchema.safeParse(zone).success, true);
    assert.equal(
      zoneRecordSchema.safeParse({ ...zone, methods: [{ ...zone.methods[0], courier: 'dhl' }] })
        .success,
      false
    );

    const loc = {
      slug: 'athens',
      label: 'Athens',
      source: 'places',
      placeId: 'p',
      resourceName: null,
      enabled: true,
      reviews: [
        {
          externalId: 'r1',
          authorName: 'A',
          photoMediaId: U1,
          rating: 5,
          text: 'ok',
          publishedAt: '2026-01-01T00:00:00.000Z',
          ownerReply: null,
          ownerReplyAt: null,
          hidden: false,
        },
      ],
    };
    assert.equal(reviewLocationRecordSchema.safeParse(loc).success, true);
    assert.equal(
      reviewLocationRecordSchema.safeParse({ ...loc, slug: 'Not A Slug' }).success,
      false
    );
  });

  test('a script is checked in its own shape by the snippet rules at write time, but must at least name a valid slug', () => {
    assert.equal(
      scriptRecordSchema.safeParse({ slug: 'chat', name: 'Chat', kind: 'inline', code: 'x()' })
        .success,
      true
    );
    assert.equal(
      scriptRecordSchema.safeParse({ slug: '../x', name: 'Chat', kind: 'inline', code: 'x()' })
        .success,
      false
    );
  });
});

describe('planChildren', () => {
  test('updates child rows matched by name and adds the rest; rows only this site has are kept', () => {
    const plan = planChildren(
      [
        { id: 1, name: 'GA' },
        { id: 2, name: 'Hotjar' },
      ],
      [
        { name: 'GA', x: 1 },
        { name: 'Meta pixel', x: 2 },
      ]
    );
    assert.deepEqual(plan.update, [{ id: 1, row: { name: 'GA', x: 1 } }]);
    assert.deepEqual(plan.insert, [{ name: 'Meta pixel', x: 2 }]);
  });
});

describe('references', () => {
  const resolver = {
    doc: (id: number) => (id === 7 ? 70 : null),
    media: (u: string) => (u === U1 ? U2 : null),
  };

  test("a redirect's document is mapped, or cut loose when it is not on this site", () => {
    const base = {
      source: '/a',
      target: '/b',
      statusCode: 301,
      kind: 'literal' as const,
      active: true,
      notes: null,
      reason: 'slug-change',
      documentSid: 7,
    };
    assert.equal(rewriteRedirect(base, resolver).documentId, 70);
    const lost = rewriteRedirect({ ...base, documentSid: 8 }, resolver);
    assert.equal(lost.documentId, null);
    assert.equal(lost.dropped, 1);
  });

  test('media URLs in SEO meta follow the file', () => {
    const r = rewriteSeoMeta(
      {
        path: '/a',
        locale: 'el',
        title: null,
        description: null,
        robots: null,
        canonical: null,
        ogTitle: null,
        ogDescription: null,
        ogImage: `https://x.example/api/cms/media/file/${U1}`,
      },
      resolver
    );
    assert.equal(r.record.ogImage, `https://x.example/api/cms/media/file/${U2}`);
  });

  test('review photos follow the file, and a missing one is removed rather than left pointing elsewhere', () => {
    const r = rewriteReviewPhotos(
      [
        {
          externalId: 'a',
          authorName: 'A',
          photoMediaId: U1,
          rating: 5,
          text: null,
          publishedAt: '2026-01-01T00:00:00.000Z',
          ownerReply: null,
          ownerReplyAt: null,
          hidden: false,
        },
        {
          externalId: 'b',
          authorName: 'B',
          photoMediaId: U2,
          rating: 4,
          text: null,
          publishedAt: '2026-01-01T00:00:00.000Z',
          ownerReply: null,
          ownerReplyAt: null,
          hidden: false,
        },
      ],
      resolver
    );
    assert.deepEqual(
      r.reviews.map((x) => x.photoMediaId),
      [U2, null]
    );
    assert.equal(r.dropped, 1);
  });

  test('dependencies: a script needs its consent category, a location its photos, meta its image, a redirect its document', () => {
    assert.deepEqual(
      tableDeps('scripts', {
        slug: 's',
        name: 'S',
        kind: 'inline',
        code: 'x',
        consentCategory: 'analytics',
      }),
      [{ kind: 'cookie', value: 'analytics' }]
    );
    assert.deepEqual(tableDeps('redirects', { documentSid: 7 }), [{ kind: 'doc', value: 7 }]);
    assert.deepEqual(
      tableDeps('seoMeta', { ogImage: `/api/cms/media/file/${U1}`, canonical: null }),
      [{ kind: 'media', value: U1 }]
    );
    assert.deepEqual(
      tableDeps('reviewLocations', { reviews: [{ photoMediaId: U1 }, { photoMediaId: null }] }),
      [{ kind: 'media', value: U1 }]
    );
    assert.deepEqual(tableDeps('cookies', {}), []);
  });
});

describe('tableLabel', () => {
  test('names each row the way its admin screen does', async () => {
    const { tableLabel } = await import('@/cms/core/transfer/tables/rules');
    assert.equal(tableLabel('redirects', { source: '/old', target: '/new' }), '/old → /new');
    assert.equal(tableLabel('seoMeta', { path: '/a', locale: 'el' }), '/a (el)');
    assert.equal(tableLabel('scripts', { name: 'Chat', slug: 'chat' }), 'Chat');
    assert.equal(
      tableLabel('cookies', { key: 'analytics', name: { en: 'Analytics' } }),
      'Analytics'
    );
    assert.equal(tableLabel('shipping', { name: 'Greece' }), 'Greece');
    assert.equal(tableLabel('reviewLocations', { label: 'Athens', slug: 'athens' }), 'Athens');
  });
});

describe('tableWriteMode', () => {
  test('a planned action becomes the right write, merge included', async () => {
    const { tableWriteMode } = await import('@/cms/core/transfer/tables/rules');
    assert.equal(tableWriteMode('merge', { exists: true, resumed: false }), 'merge');
    assert.equal(tableWriteMode('overwrite', { exists: true, resumed: false }), 'overwrite');
    assert.equal(tableWriteMode('create', { exists: false, resumed: false }), 'create');
    assert.equal(tableWriteMode('copy', { exists: true, resumed: false }), 'copy');
  });

  test('a row that appeared after the preview is left alone; one an interrupted attempt wrote is completed', async () => {
    const { tableWriteMode } = await import('@/cms/core/transfer/tables/rules');
    assert.equal(tableWriteMode('create', { exists: true, resumed: false }), 'skip-appeared');
    assert.equal(tableWriteMode('create', { exists: true, resumed: true }), 'overwrite');
    assert.equal(tableWriteMode('copy', { exists: true, resumed: true }), 'skip-interrupted-copy');
  });
});
