import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  emptySelection,
  selectionReducer,
  selectionSize,
  toSelectionPayload,
} from '@/cms/admin/transfer/wizard-state';
import { planChunks } from '@/cms/admin/transfer/chunked-upload';

/**
 * What the user has ticked, kept as plain data so both wizards (export and
 * import) share one set of rules and the request body is derived, not
 * duplicated.
 */

describe('selectionReducer', () => {
  test('a group can be taken whole, in part, or not at all', () => {
    let s = emptySelection();
    s = selectionReducer(s, { type: 'mode', group: 'media', mode: 'all' });
    s = selectionReducer(s, { type: 'toggle', group: 'documents:product', key: 'doc:product:a' });
    s = selectionReducer(s, { type: 'toggle', group: 'documents:product', key: 'doc:product:b' });
    s = selectionReducer(s, { type: 'toggle', group: 'documents:product', key: 'doc:product:a' });
    assert.deepEqual(toSelectionPayload(s), {
      groups: { media: 'all', 'documents:product': ['doc:product:b'] },
      optOut: [],
    });
  });

  test('ticking an item switches its group to "chosen items"; emptying it leaves the group out', () => {
    let s = selectionReducer(emptySelection(), {
      type: 'toggle',
      group: 'settings',
      key: 'setting:a',
    });
    assert.equal(s.groups.settings.mode, 'some');
    s = selectionReducer(s, { type: 'toggle', group: 'settings', key: 'setting:a' });
    assert.deepEqual(toSelectionPayload(s).groups, {});
  });

  test('switching a group off forgets its items', () => {
    let s = selectionReducer(emptySelection(), {
      type: 'toggle',
      group: 'settings',
      key: 'setting:a',
    });
    s = selectionReducer(s, { type: 'mode', group: 'settings', mode: 'none' });
    s = selectionReducer(s, { type: 'mode', group: 'settings', mode: 'some' });
    assert.deepEqual(s.groups.settings.keys, []);
  });

  test('a dependency can be left out and brought back', () => {
    let s = selectionReducer(emptySelection(), { type: 'optOut', key: 'doc:tag:x' });
    assert.deepEqual(toSelectionPayload(s).optOut, ['doc:tag:x']);
    s = selectionReducer(s, { type: 'optOut', key: 'doc:tag:x' });
    assert.deepEqual(toSelectionPayload(s).optOut, []);
  });

  test('selectionSize counts groups taken whole separately', () => {
    let s = selectionReducer(emptySelection(), { type: 'mode', group: 'media', mode: 'all' });
    s = selectionReducer(s, { type: 'toggle', group: 'settings', key: 'setting:a' });
    assert.deepEqual(selectionSize(s), { wholeGroups: 1, items: 1 });
  });
});

describe('planChunks', () => {
  test('covers the file in order from where the server says it is', () => {
    assert.deepEqual(planChunks(25, 10, 0), [
      { offset: 0, end: 10 },
      { offset: 10, end: 20 },
      { offset: 20, end: 25 },
    ]);
    assert.deepEqual(planChunks(25, 10, 20), [{ offset: 20, end: 25 }]);
    assert.deepEqual(planChunks(25, 10, 25), []);
  });

  test('refuses a nonsensical chunk size', () => {
    assert.throws(() => planChunks(10, 0, 0));
  });
});

describe('describeSelection', () => {
  test('says in words what is chosen, with correct plurals', async () => {
    const { describeSelection } = await import('@/cms/admin/transfer/wizard-state');
    assert.equal(describeSelection({ wholeGroups: 0, items: 0 }), 'Nothing chosen yet');
    assert.equal(describeSelection({ wholeGroups: 1, items: 0 }), 'Everything in 1 group');
    assert.equal(describeSelection({ wholeGroups: 2, items: 0 }), 'Everything in 2 groups');
    assert.equal(describeSelection({ wholeGroups: 0, items: 1 }), '1 chosen item');
    assert.equal(
      describeSelection({ wholeGroups: 1, items: 3 }),
      'Everything in 1 group, plus 3 chosen items'
    );
  });
});

describe('sectionChosen', () => {
  test('counts the groups of a section that will take something', async () => {
    const { sectionChosen } = await import('@/cms/admin/transfer/wizard-state');
    let s = emptySelection();
    s = selectionReducer(s, { type: 'mode', group: 'a', mode: 'all' });
    s = selectionReducer(s, { type: 'mode', group: 'b', mode: 'some' });
    s = selectionReducer(s, { type: 'toggle', group: 'c', key: 'x' });
    assert.equal(sectionChosen(s, ['a', 'b', 'c', 'd']), 2, 'an empty "choose items" takes nothing');
  });
});

describe('selectionReducer, a whole module at once', () => {
  test('sets every listed group to everything, leaving the others alone', () => {
    let s = emptySelection();
    s = selectionReducer(s, { type: 'toggle', group: 'a', key: 'x' });
    s = selectionReducer(s, { type: 'mode', group: 'other', mode: 'all' });
    s = selectionReducer(s, { type: 'modeMany', groups: ['a', 'b'], mode: 'all' });
    assert.deepEqual(s.groups.a, { mode: 'all', keys: [] });
    assert.deepEqual(s.groups.b, { mode: 'all', keys: [] });
    assert.deepEqual(s.groups.other, { mode: 'all', keys: [] });
  });

  test('clears every listed group, including items chosen one by one', () => {
    let s = emptySelection();
    s = selectionReducer(s, { type: 'toggle', group: 'a', key: 'x' });
    s = selectionReducer(s, { type: 'mode', group: 'b', mode: 'all' });
    s = selectionReducer(s, { type: 'modeMany', groups: ['a', 'b'], mode: 'none' });
    assert.deepEqual(toSelectionPayload(s), { groups: {}, optOut: [] });
  });
});
