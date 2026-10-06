import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  docRecordSchema,
  mediaRecordSchema,
  settingRecordSchema,
  stubsSchema,
} from '@/cms/core/transfer/records';

/**
 * Every record in a package is a user upload. Its shape is checked before any
 * of it is looked at, with column lengths taken from the database schema, so a
 * malformed or hostile package fails as "invalid record" instead of as a
 * database error half-way through an import.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

const row = {
  sourceId: 7,
  slug: 'shoe',
  locale: 'el',
  status: 'published',
  publishedAt: '2026-01-01T00:00:00.000Z',
  scheduledFor: null,
  modifiedAt: null,
  metaTitle: null,
  metaDescription: null,
  noindex: false,
  nofollow: false,
  includeInSitemap: true,
  ogImageUuid: UUID,
  data: { title: 'x' },
};

describe('docRecordSchema', () => {
  test('accepts a translation group of rows', () => {
    assert.equal(
      docRecordSchema.safeParse({ type: 'product', translationGroupId: UUID, rows: [row] }).success,
      true
    );
  });

  test('rejects oversized columns, unknown statuses and an empty group', () => {
    const bad = (over: object) =>
      docRecordSchema.safeParse({
        type: 'product',
        translationGroupId: null,
        rows: [{ ...row, ...over }],
      }).success;
    assert.equal(bad({ slug: 'x'.repeat(192) }), false);
    assert.equal(bad({ status: 'deleted' }), false);
    assert.equal(bad({ locale: 'x'.repeat(9) }), false);
    assert.equal(bad({ ogImageUuid: '../../etc/passwd' }), false);
    assert.equal(bad({ publishedAt: 'yesterday' }), false);
    assert.equal(
      docRecordSchema.safeParse({ type: 'product', translationGroupId: null, rows: [] }).success,
      false
    );
  });

  test('two rows of one group cannot share a locale', () => {
    const r = docRecordSchema.safeParse({
      type: 'product',
      translationGroupId: null,
      rows: [row, { ...row, sourceId: 8 }],
    });
    assert.equal(r.success, false);
  });
});

describe('mediaRecordSchema', () => {
  test('requires a real uuid and a sha256', () => {
    const ok = {
      uuid: UUID,
      hash: 'a'.repeat(64),
      originalName: 'a.webp',
      altText: null,
      folderPath: null,
      hasAvif: false,
    };
    assert.equal(mediaRecordSchema.safeParse(ok).success, true);
    assert.equal(mediaRecordSchema.safeParse({ ...ok, uuid: '../x' }).success, false);
    assert.equal(mediaRecordSchema.safeParse({ ...ok, hash: 'nothex' }).success, false);
  });
});

describe('settingRecordSchema', () => {
  test('a key and any JSON value — the value is validated by the settings rules on write', () => {
    assert.equal(settingRecordSchema.safeParse({ key: 'site.name', value: 'x' }).success, true);
    assert.equal(settingRecordSchema.safeParse({ key: '', value: 'x' }).success, false);
  });
});

describe('stubsSchema', () => {
  test('describes referenced documents and media by natural key', () => {
    const ok = stubsSchema.safeParse({
      documents: [
        { sid: 3, type: 'category', slug: 'shoes', locale: 'el', translationGroupId: null },
      ],
      media: [{ uuid: UUID, hash: 'b'.repeat(64) }],
    });
    assert.equal(ok.success, true);
  });
});

describe('recordMatchesKey', () => {
  test('a record must be the thing its key names — the run re-checks what analysis checked', async () => {
    const { recordMatchesKey } = await import('@/cms/core/transfer/records');
    assert.equal(recordMatchesKey('doc:product:g', { type: 'product' }), true);
    assert.equal(recordMatchesKey('doc:product:g', { type: 'page' }), false);
    assert.equal(recordMatchesKey('setting:a.b', { key: 'a.b' }), true);
    assert.equal(recordMatchesKey('setting:a.b', { key: 'module.x' }), false);
    assert.equal(recordMatchesKey(`media:${UUID}`, { uuid: UUID }), true);
    assert.equal(
      recordMatchesKey(`media:${UUID}`, { uuid: '22222222-2222-4222-8222-222222222222' }),
      false
    );
  });
});
