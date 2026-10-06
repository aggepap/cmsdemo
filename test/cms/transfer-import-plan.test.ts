import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PERMISSIONS } from '@/cms/modules/auth/permissions';
import { buildPlan, makeResolver, type ImportIndexItem } from '@/cms/core/transfer/import/plan';

/**
 * The plan is the dry run: everything an import will do, decided before a single
 * row is written. What the user sees on the confirmation screen is this object,
 * and the run executes exactly it.
 */

const item = (over: Partial<ImportIndexItem> & Pick<ImportIndexItem, 'key'>): ImportIndexItem => ({
  label: over.key,
  state: 'new',
  deps: [],
  ...over,
});

const index: ImportIndexItem[] = [
  item({ key: 'media:m1' }),
  item({ key: 'media:m2' }),
  item({ key: 'setting:brand.identity', state: 'conflict', deps: ['media:m2'] }),
  item({ key: 'doc:category:c1', deps: ['media:m1'] }),
  item({
    key: 'doc:product:p1',
    state: 'conflict',
    deps: ['doc:category:c1', 'media:m1', 'doc:product:p2'],
  }),
  item({ key: 'doc:product:p2', deps: ['doc:product:p1'] }),
  item({ key: 'doc:product:p3', state: 'ambiguous' }),
  item({ key: 'doc:product:bad', invalid: 'data.price: expected a number' }),
];

const all = ['*'];
let n = 0;
const ctx = (perms: string[] = all) => ({ perms, newGroupId: () => `g${++n}` });
const decisions = (over: Partial<Parameters<typeof buildPlan>[1]> = {}) => ({
  selection: {
    groups: { 'documents:product': ['doc:product:p1'] as string[] | 'all' },
    optOut: [] as string[],
  },
  defaults: {},
  overrides: {},
  ...over,
});

describe('buildPlan', () => {
  test('selecting one product brings its category, the related product and their media', () => {
    const r = buildPlan(index, decisions(), ctx());
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.plan.items).sort(), [
      'doc:category:c1',
      'doc:product:p1',
      'doc:product:p2',
      'media:m1',
    ]);
    assert.deepEqual(r.plan.required['doc:category:c1'], ['doc:product:p1']);
  });

  test('writes media before documents and dependencies first, patching the cycle', () => {
    const r = buildPlan(index, decisions(), ctx());
    assert.ok(r.ok);
    const { order, patch } = r.plan;
    assert.equal(order[0], 'media:m1');
    assert.ok(order.indexOf('doc:category:c1') < order.indexOf('doc:product:p1'));
    assert.equal(patch.length, 1);
  });

  test('a conflict takes the group default, a new item is created with a fresh group id', () => {
    const r = buildPlan(
      index,
      decisions({ defaults: { 'documents:product': 'overwrite' } }),
      ctx()
    );
    assert.ok(r.ok);
    assert.equal(r.plan.items['doc:product:p1'].action, 'overwrite');
    assert.equal(r.plan.items['doc:product:p2'].action, 'create');
    assert.match(r.plan.items['doc:product:p2'].targetGroupId ?? '', /^g\d+$/);
    // An overwrite gets one too: used only if the item on this site has no translation group yet.
    assert.ok(r.plan.items['doc:product:p1'].targetGroupId);
  });

  test('a copy gets its own new group id', () => {
    const r = buildPlan(index, decisions({ overrides: { 'doc:product:p1': 'copy' } }), ctx());
    assert.ok(r.ok);
    assert.equal(r.plan.items['doc:product:p1'].action, 'copy');
    assert.ok(r.plan.items['doc:product:p1'].targetGroupId);
  });

  test('an override the item cannot take is refused, naming the item', () => {
    const r = buildPlan(
      index,
      decisions({
        selection: { groups: { 'documents:product': ['doc:product:p3'] }, optOut: [] },
        overrides: { 'doc:product:p3': 'overwrite' },
      }),
      ctx()
    );
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.errors.some((e) => e.includes('doc:product:p3')));
  });

  test('an opted-out dependency is not imported and is listed as external', () => {
    const r = buildPlan(
      index,
      decisions({
        selection: {
          groups: { 'documents:product': ['doc:product:p1'] },
          optOut: ['doc:category:c1'],
        },
      }),
      ctx()
    );
    assert.ok(r.ok);
    assert.equal('doc:category:c1' in r.plan.items, false);
    assert.deepEqual(r.plan.external['doc:category:c1'], ['doc:product:p1']);
  });

  test('invalid records are never imported, and are reported', () => {
    const r = buildPlan(
      index,
      decisions({ selection: { groups: { 'documents:product': 'all' }, optOut: [] } }),
      ctx()
    );
    assert.ok(r.ok);
    assert.equal('doc:product:bad' in r.plan.items, false);
    assert.deepEqual(r.plan.invalid, { 'doc:product:bad': 'data.price: expected a number' });
  });

  test('a group the user may not write is refused when selected, and not pulled in as a dependency', () => {
    const contentOnly = [PERMISSIONS.transferImport, PERMISSIONS.contentWrite];
    const refused = buildPlan(
      index,
      decisions({ selection: { groups: { settings: 'all' }, optOut: [] } }),
      ctx(contentOnly)
    );
    assert.equal(refused.ok, false);

    const r = buildPlan(index, decisions(), ctx(contentOnly));
    assert.ok(r.ok);
    assert.equal('media:m1' in r.plan.items, false, 'no media permission → media stays out');
    assert.ok(r.plan.external['media:m1']);
  });

  test('without the import permission nothing can be planned', () => {
    const r = buildPlan(index, decisions(), ctx([PERMISSIONS.contentWrite]));
    assert.equal(r.ok, false);
  });

  test('counts what will happen', () => {
    const r = buildPlan(
      index,
      decisions({ defaults: { 'documents:product': 'overwrite' } }),
      ctx()
    );
    assert.ok(r.ok);
    assert.deepEqual(r.plan.summary, {
      create: 3,
      reuse: 0,
      overwrite: 1,
      copy: 0,
      skip: 0,
      merge: 0,
    });
  });
});

test('a media file this site already holds is counted as reused, not created', () => {
  const idx = [
    item({ key: 'media:x', match: { id: 'y', label: 'Already here as a.webp' } }),
    item({ key: 'media:z' }),
  ];
  const r = buildPlan(
    idx,
    decisions({ selection: { groups: { media: 'all' }, optOut: [] } }),
    ctx()
  );
  assert.ok(r.ok);
  assert.equal(r.plan.summary.reuse, 1);
  assert.equal(r.plan.summary.create, 1);
});

describe('makeResolver', () => {
  test('prefers what this import wrote, then what already existed, else drops', () => {
    const resolve = makeResolver(
      { doc: { '1': 10 }, media: { a: 'A' } },
      { doc: { '1': 99, '2': 20 }, media: { b: 'B' } }
    );
    assert.equal(resolve.doc(1), 10);
    assert.equal(resolve.doc(2), 20);
    assert.equal(resolve.doc(3), null);
    assert.equal(resolve.media('a'), 'A');
    assert.equal(resolve.media('b'), 'B');
    assert.equal(resolve.media('c'), null);
  });
});

describe('failureMessage', () => {
  test('says which field failed and why, not just "Validation failed."', async () => {
    const { failureMessage } = await import('@/cms/core/transfer/import/run');
    const { invalidInput } = await import('@/cms/core/errors');
    const err = invalidInput({
      pathErrors: { 'components.0.product': ['Required'] },
      formErrors: [],
    });
    assert.equal(failureMessage(err), 'components.0.product: Required');
    assert.equal(failureMessage(invalidInput(undefined, 'Nope.')), 'Nope.');
    assert.match(failureMessage(new Error('x')), /server log/);
  });
});
