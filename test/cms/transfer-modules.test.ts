import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sectionsByModule } from '@/cms/admin/transfer/sections';
import { allGroupKeys, moduleOfGroup } from '@/cms/core/transfer/groups';
import { summarizeGroups } from '@/cms/core/transfer/import/summary';

/**
 * Export / Import is laid out by module, and an import can switch on a module
 * the package needs. Both depend on knowing which module owns each group.
 */

const collections = new Map<string, { module?: string }>([
  ['page', {}],
  ['product', { module: 'commerce' }],
  ['category', { module: 'commerce' }],
  ['booking', { module: 'booking' }],
]);

describe('moduleOfGroup', () => {
  test('a collection belongs to the module it is gated on', () => {
    assert.equal(moduleOfGroup('documents:product', collections), 'commerce');
    assert.equal(moduleOfGroup('documents:booking', collections), 'booking');
  });

  test('an ungated collection, media and settings belong to no module', () => {
    assert.equal(moduleOfGroup('documents:page', collections), null);
    assert.equal(moduleOfGroup('media', collections), null);
    assert.equal(moduleOfGroup('settings', collections), null);
  });

  test('a table belongs to the module its group requires', () => {
    assert.equal(moduleOfGroup('orders', collections), 'commerce');
    assert.equal(moduleOfGroup('reservations', collections), 'booking');
    assert.equal(moduleOfGroup('subscribers', collections), 'newsletter');
    assert.equal(moduleOfGroup('redirects', collections), null);
  });

  test('a collection this site does not have belongs to no module', () => {
    assert.equal(moduleOfGroup('documents:unknown', collections), null);
  });
});

describe('allGroupKeys', () => {
  test('lists every group the site has, whether or not its module is on', () => {
    const keys = allGroupKeys([{ key: 'page' }, { key: 'product', module: 'commerce' }]);
    assert.ok(keys.includes('media'));
    assert.ok(keys.includes('settings'));
    assert.ok(keys.includes('orders'));
    assert.ok(keys.includes('documents:product'));
    assert.ok(keys.includes('documents:page'));
  });
});

describe('summarizeGroups', () => {
  const items = [
    { key: 'doc:page:a', label: 'Home', state: 'new' as const, deps: [] },
    {
      key: 'doc:product:p1',
      label: 'Shoe',
      state: 'new' as const,
      deps: [],
      invalid: 'The Commerce module is off on this site.',
    },
    {
      key: 'doc:product:p2',
      label: 'Hat',
      state: 'new' as const,
      deps: [],
      invalid: 'The Commerce module is off on this site.',
    },
    { key: 'doc:unknown:x', label: 'x', state: 'new' as const, deps: [], invalid: 'No such.' },
  ];
  const flags = { commerce: false, booking: true };

  test('each group names its module and whether that module is off here', () => {
    const groups = summarizeGroups(items, { collections, flags });
    const product = groups.find((g) => g.group === 'documents:product');
    assert.equal(product?.module, 'commerce');
    assert.equal(product?.moduleOff, true);
    assert.equal(product?.total, 2);
    assert.equal(product?.invalid, 2);
    const page = groups.find((g) => g.group === 'documents:page');
    assert.equal(page?.module, null);
    assert.equal(page?.moduleOff, false);
  });

  test('a collection this site lacks is not something a module switch can fix', () => {
    const groups = summarizeGroups(items, { collections, flags });
    const unknown = groups.find((g) => g.group === 'documents:unknown');
    assert.equal(unknown?.module, null);
    assert.equal(unknown?.moduleOff, false);
    assert.equal(unknown?.available, false);
  });

  test('a module that is on is not reported off', () => {
    const groups = summarizeGroups(items, { collections, flags: { commerce: true } });
    assert.equal(groups.find((g) => g.group === 'documents:product')?.moduleOff, false);
  });
});

describe('sectionsByModule', () => {
  const groups = [
    { key: 'media', label: 'Media files', pii: false, module: null },
    { key: 'documents:product', label: 'Products', pii: false, module: 'commerce' },
    { key: 'documents:page', label: 'Pages', pii: false, module: null },
    { key: 'orders', label: 'Orders', pii: true, module: 'commerce' },
    { key: 'reservations', label: 'Reservations', pii: true, module: 'booking', moduleOff: true },
  ];

  test('puts general groups first, then one section per module in the order met', () => {
    const sections = sectionsByModule(groups);
    assert.deepEqual(
      sections.map((s) => [s.module, s.label, s.groups.map((g) => g.key)]),
      [
        [null, 'General', ['media', 'documents:page']],
        ['commerce', 'Commerce', ['documents:product', 'orders']],
        ['booking', 'Booking', ['reservations']],
      ]
    );
  });

  test('a section is off when its module is off here', () => {
    const sections = sectionsByModule(groups);
    assert.equal(sections.find((s) => s.module === 'booking')?.off, true);
    assert.equal(sections.find((s) => s.module === 'commerce')?.off, false);
    assert.equal(sections.find((s) => s.module === null)?.off, false);
  });

  test('groups with no module field are general', () => {
    const sections = sectionsByModule([{ key: 'media', label: 'Media', pii: false }]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].module, null);
  });
});
