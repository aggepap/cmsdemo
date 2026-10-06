import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { publishFieldsFor } from '@/cms/core/transfer/publish-fields';

/**
 * An import follows the same publishing rule as the editor
 * (`documents/publish-rights.ts`): without publish rights you may change a live
 * document's text, but not put anything live — by status or by date — and not
 * take anything down. An overwrite without "keep status" must therefore leave
 * the document's status alone, not turn a live page into a draft.
 */

const row = {
  status: 'published' as const,
  publishedAt: '2026-01-01T00:00:00.000Z',
  scheduledFor: null,
};
const opts = (over: Partial<Parameters<typeof publishFieldsFor>[0]> = {}) => ({
  canPublish: true,
  keepStatus: true,
  copiesAsDrafts: true,
  ...over,
});

describe('publishFieldsFor', () => {
  test('a publisher keeping status gets the source status and dates', () => {
    const f = publishFieldsFor(opts(), 'create', 'create', row);
    assert.equal(f.status, 'published');
    assert.ok(f.publishedAt instanceof Date);
  });

  test('without publish rights a new document is a draft with no publishing dates', () => {
    assert.deepEqual(publishFieldsFor(opts({ canPublish: false }), 'create', 'create', row), {
      status: 'draft',
      publishedAt: null,
      scheduledFor: null,
    });
  });

  test('without "keep status" a new document is a draft too', () => {
    assert.equal(
      publishFieldsFor(opts({ keepStatus: false }), 'create', 'create', row).status,
      'draft'
    );
  });

  test('a copy is a draft when "copies as drafts" is on, even for a publisher', () => {
    assert.equal(publishFieldsFor(opts(), 'copy', 'create', row).status, 'draft');
    assert.equal(
      publishFieldsFor(opts({ copiesAsDrafts: false }), 'copy', 'create', row).status,
      'published'
    );
  });

  test('an overwrite that may not publish leaves status and dates as they are on this site', () => {
    assert.deepEqual(publishFieldsFor(opts({ canPublish: false }), 'overwrite', 'update', row), {});
    assert.deepEqual(publishFieldsFor(opts({ keepStatus: false }), 'overwrite', 'update', row), {});
  });

  test('an overwrite by a publisher keeping status takes the source status', () => {
    assert.equal(publishFieldsFor(opts(), 'overwrite', 'update', row).status, 'published');
  });
});
