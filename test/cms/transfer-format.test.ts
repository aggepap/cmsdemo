import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  checkCompatibility,
  FORMAT_VERSION,
  manifestSchema,
  type TransferManifest,
} from '@/cms/core/transfer/format';

const manifest = (over: Partial<TransferManifest> = {}): TransferManifest => ({
  format: 'cms-transfer',
  formatVersion: FORMAT_VERSION,
  cmsVersion: '1.0.0',
  createdAt: '2026-09-29T10:00:00.000Z',
  source: {
    siteName: 'Shop',
    origin: 'https://shop.example',
    defaultLocale: 'el',
    locales: ['el', 'en'],
    modules: {},
  },
  containsPii: false,
  containsPasswordHashes: false,
  files: [
    {
      path: 'data/documents/product/0001.jsonl',
      group: 'documents:product',
      count: 3,
      sha256: 'a'.repeat(64),
      bytes: 10,
    },
  ],
  media: { count: 0, bytes: 0 },
  counts: { 'documents:product': 3 },
  customFields: {},
  ...over,
});

describe('manifestSchema', () => {
  test('accepts a well-formed manifest', () => {
    assert.equal(manifestSchema.safeParse(manifest()).success, true);
  });

  test('rejects another format, or a file outside data/', () => {
    assert.equal(manifestSchema.safeParse({ ...manifest(), format: 'other' }).success, false);
    const bad = manifest({
      files: [
        {
          path: '../x.jsonl',
          group: 'documents:product',
          count: 1,
          sha256: 'a'.repeat(64),
          bytes: 1,
        },
      ],
    });
    assert.equal(manifestSchema.safeParse(bad).success, false);
  });
});

describe('checkCompatibility', () => {
  const target = { cmsVersion: '1.0.0', locales: ['el', 'en'] };

  test('the same version and locales is clean', () => {
    assert.deepEqual(checkCompatibility(manifest(), target), { blockers: [], warnings: [] });
  });

  test('a package from a newer format version is blocked', () => {
    const r = checkCompatibility(manifest({ formatVersion: FORMAT_VERSION + 1 }), target);
    assert.equal(r.blockers.length, 1);
  });

  test('a different CMS version and missing locales are warnings', () => {
    const r = checkCompatibility(
      manifest({ cmsVersion: '0.9.0', source: { ...manifest().source, locales: ['el', 'fr'] } }),
      target
    );
    assert.equal(r.blockers.length, 0);
    assert.equal(r.warnings.length, 2);
  });
});
