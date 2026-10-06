import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { closure, writeOrder } from '@/cms/core/transfer/closure';

/**
 * Picking one product must bring what it cannot live without — its categories,
 * its size chart, its images — and nothing else. Picking a category must NOT
 * bring every product in it: dependencies flow one way.
 */

const graph = new Map<string, string[]>([
  ['product:a', ['category:shoes', 'media:1', 'product:b']],
  ['product:b', ['category:shoes', 'product:a']],
  ['category:shoes', ['category:root', 'media:2']],
  ['category:root', []],
  ['product:c', ['category:shoes', 'tag:missing']],
]);
const available = new Set([...graph.keys(), 'media:1', 'media:2']);

describe('closure', () => {
  test('pulls every transitive dependency and says who needed it', () => {
    const r = closure(graph, available, ['product:a'], new Set());
    assert.deepEqual([...r.included].sort(), [
      'category:root',
      'category:shoes',
      'media:1',
      'media:2',
      'product:a',
      'product:b',
    ]);
    assert.deepEqual(r.required.get('category:shoes')?.sort(), ['product:a', 'product:b']);
    assert.equal(r.required.has('product:a'), false, 'a selected item is not a "required" one');
  });

  test('does not follow reverse dependencies', () => {
    const r = closure(graph, available, ['category:shoes'], new Set());
    assert.deepEqual([...r.included].sort(), ['category:root', 'category:shoes', 'media:2']);
  });

  test('an opted-out dependency is not entered, and is reported as external', () => {
    const r = closure(graph, available, ['product:a'], new Set(['category:shoes']));
    assert.equal(r.included.has('category:shoes'), false);
    assert.equal(r.included.has('category:root'), false);
    assert.deepEqual(r.external.get('category:shoes')?.sort(), ['product:a', 'product:b']);
  });

  test('an explicitly selected item wins over an opt-out', () => {
    const r = closure(
      graph,
      available,
      ['product:a', 'category:shoes'],
      new Set(['category:shoes'])
    );
    assert.equal(r.included.has('category:shoes'), true);
  });

  test('a reference to something not in the package is external', () => {
    const r = closure(graph, available, ['product:c'], new Set());
    assert.deepEqual(r.external.get('tag:missing'), ['product:c']);
  });
});

describe('writeOrder', () => {
  const rank = (k: string) => (k.startsWith('media:') ? 10 : 40);

  test('writes lower ranks first and dependencies before their dependents', () => {
    const r = closure(graph, available, ['product:a'], new Set());
    const { order } = writeOrder(r.included, graph, rank);
    const pos = (k: string) => order.indexOf(k);
    assert.ok(pos('media:1') < pos('category:root'));
    assert.ok(pos('category:root') < pos('category:shoes'));
    assert.ok(pos('category:shoes') < pos('product:a'));
    assert.ok(pos('category:shoes') < pos('product:b'));
    assert.equal(order.length, r.included.size);
  });

  test('a cycle is broken by patching whichever member was written first', () => {
    const r = closure(graph, available, ['product:a'], new Set());
    const { order, patch } = writeOrder(r.included, graph, rank);
    const first =
      order.indexOf('product:a') < order.indexOf('product:b') ? 'product:a' : 'product:b';
    assert.deepEqual([...patch], [first]);
  });

  test('a self-reference needs a patch too', () => {
    const g = new Map([['doc:x', ['doc:x']]]);
    const { patch } = writeOrder(new Set(['doc:x']), g, () => 1);
    assert.deepEqual([...patch], ['doc:x']);
  });

  test('a reference to a later rank is patched, not reordered', () => {
    const g = new Map([
      ['setting:customFields', ['doc:cat']],
      ['doc:cat', []],
    ]);
    const { order, patch } = writeOrder(new Set(g.keys()), g, (k) =>
      k.startsWith('setting') ? 20 : 40
    );
    assert.deepEqual(order, ['setting:customFields', 'doc:cat']);
    assert.deepEqual([...patch], ['setting:customFields']);
  });

  test('handles a long chain without recursion limits', () => {
    const g = new Map<string, string[]>();
    for (let i = 0; i < 20000; i++) g.set(`d:${i}`, i > 0 ? [`d:${i - 1}`] : []);
    const { order, patch } = writeOrder(new Set(g.keys()), g, () => 1);
    assert.equal(order[0], 'd:0');
    assert.equal(patch.size, 0);
  });
});
