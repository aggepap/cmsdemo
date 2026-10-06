import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  actionsFor,
  classifyDocumentGroup,
  nextFreeName,
  nextFreeSlug,
  resolveAction,
} from '@/cms/core/transfer/conflicts';

describe('classifyDocumentGroup', () => {
  test('no match on the target is new', () => {
    assert.equal(classifyDocumentGroup([], false), 'new');
  });

  test('matches that all belong to one target group are a conflict', () => {
    assert.equal(
      classifyDocumentGroup(
        [
          { locale: 'el', slug: 'a', id: 1, groupId: 'g' },
          { locale: 'en', slug: 'a', id: 2, groupId: 'g' },
        ],
        false
      ),
      'conflict'
    );
  });

  test('matches spread over two target groups are ambiguous', () => {
    assert.equal(
      classifyDocumentGroup(
        [
          { locale: 'el', slug: 'a', id: 1, groupId: 'g1' },
          { locale: 'en', slug: 'a', id: 2, groupId: null },
        ],
        false
      ),
      'ambiguous'
    );
  });

  test('a URL already owned by another collection is flagged', () => {
    assert.equal(classifyDocumentGroup([], true), 'pathTaken');
  });
});

describe('actionsFor / resolveAction', () => {
  const docs = ['skip', 'overwrite', 'copy'] as const;
  const people = ['skip', 'overwrite', 'merge'] as const;

  test('ambiguous and path-taken items can only be skipped or copied', () => {
    assert.deepEqual(actionsFor('ambiguous', docs), ['skip', 'copy']);
    assert.deepEqual(actionsFor('pathTaken', docs), ['skip', 'copy']);
    assert.deepEqual(actionsFor('conflict', docs), ['skip', 'overwrite', 'copy']);
  });

  test('a new item is always created', () => {
    assert.equal(resolveAction('new', docs, 'skip'), 'create');
  });

  test('an allowed override beats the default', () => {
    assert.equal(resolveAction('conflict', docs, 'skip', 'overwrite'), 'overwrite');
  });

  test('an override the group does not allow is refused', () => {
    assert.equal(resolveAction('conflict', people, 'skip', 'copy'), null);
    assert.equal(resolveAction('ambiguous', docs, 'skip', 'overwrite'), null);
  });

  test('a default the item cannot take falls back to skip', () => {
    assert.equal(resolveAction('ambiguous', docs, 'overwrite'), 'skip');
    assert.equal(resolveAction('conflict', people, 'copy'), 'skip');
  });
});

describe('nextFreeSlug', () => {
  test('appends the first free counter', () => {
    assert.equal(nextFreeSlug('shoe', new Set(['shoe'])), 'shoe-2');
    assert.equal(nextFreeSlug('shoe', new Set(['shoe', 'shoe-2', 'shoe-3'])), 'shoe-4');
    assert.equal(nextFreeSlug('shoe', new Set()), 'shoe-2');
  });

  test('stays within the maximum length', () => {
    const long = 'x'.repeat(96);
    const out = nextFreeSlug(long, new Set([long]), 96);
    assert.equal(out.length, 96);
    assert.ok(out.endsWith('-2'));
  });
});

describe('nextFreeName', () => {
  test('numbers a copy by name', () => {
    assert.equal(nextFreeName('Greece', new Set(['Greece'])), 'Greece (2)');
    assert.equal(nextFreeName('Greece', new Set(['Greece', 'Greece (2)'])), 'Greece (3)');
  });
});
