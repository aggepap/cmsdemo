import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PERMISSIONS } from '@/cms/modules/auth/permissions';
import {
  canExportGroup,
  canImportGroup,
  docGroupKey,
  groupDef,
  groupOfItem,
  itemKey,
  parseItemKey,
} from '@/cms/core/transfer/groups';

/**
 * The group registry is the one place that says what may move and who may move
 * it. The transfer permission alone is never enough: exporting products also
 * needs the right to read content, so the tool cannot become a way round the
 * normal admin.
 */

describe('item keys', () => {
  test('are stable, typed and reversible', () => {
    assert.equal(itemKey.media('abc'), 'media:abc');
    assert.equal(itemKey.setting('brand.identity'), 'setting:brand.identity');
    assert.equal(itemKey.doc('product', 'g-1'), 'doc:product:g-1');
    assert.deepEqual(parseItemKey('doc:product:g-1'), {
      family: 'documents',
      type: 'product',
      id: 'g-1',
    });
    assert.deepEqual(parseItemKey('setting:a.b'), { family: 'settings', id: 'a.b' });
    assert.deepEqual(parseItemKey('media:u'), { family: 'media', id: 'u' });
    assert.equal(parseItemKey('nonsense'), null);
  });

  test('an item belongs to its group', () => {
    assert.equal(groupOfItem('doc:product:g-1'), 'documents:product');
    assert.equal(groupOfItem('media:u'), 'media');
    assert.equal(groupOfItem('setting:x'), 'settings');
  });

  test('a document without a translation group is keyed by its row id', () => {
    assert.equal(docGroupKey({ id: 5, translationGroupId: null }), 'id-5');
    assert.equal(docGroupKey({ id: 5, translationGroupId: 'abc' }), 'abc');
  });
});

describe('group permissions', () => {
  const exporter = [PERMISSIONS.transferExport, PERMISSIONS.contentRead];

  test('exporting a group needs the transfer permission AND the area read permission', () => {
    assert.equal(canExportGroup(exporter, 'documents:product'), true);
    assert.equal(canExportGroup([PERMISSIONS.transferExport], 'documents:product'), false);
    assert.equal(canExportGroup([PERMISSIONS.contentRead], 'documents:product'), false);
    assert.equal(canExportGroup(exporter, 'settings'), false);
  });

  test('importing a group needs the transfer permission AND the area write permission', () => {
    assert.equal(
      canImportGroup([PERMISSIONS.transferImport, PERMISSIONS.mediaWrite], 'media'),
      true
    );
    assert.equal(
      canImportGroup([PERMISSIONS.transferImport, PERMISSIONS.mediaRead], 'media'),
      false
    );
    assert.equal(canImportGroup(['*'], 'settings'), true);
  });

  test('every group declares actions, a rank and both permission sets', () => {
    for (const g of ['media', 'settings', 'documents:page'] as const) {
      const def = groupDef(g);
      assert.ok(def.rank > 0, g);
      assert.ok(def.exportPerms.includes(PERMISSIONS.transferExport), g);
      assert.ok(def.importPerms.includes(PERMISSIONS.transferImport), g);
      assert.ok(def.actions.includes(def.defaultAction) || def.actions.length === 0, g);
    }
  });

  test('media is written first, then settings, then documents', () => {
    assert.ok(groupDef('media').rank < groupDef('settings').rank);
    assert.ok(groupDef('settings').rank < groupDef('documents:page').rank);
  });

  test('documents can be skipped, overwritten or copied; settings cannot be copied', () => {
    assert.deepEqual(groupDef('documents:page').actions, ['skip', 'overwrite', 'copy']);
    assert.equal(groupDef('settings').actions.includes('copy'), false);
  });

  test('the transfer permissions are registered and none is granted to editors by default', async () => {
    const { DEFAULT_ROLES } = await import('@/cms/db/seeds/roles');
    const editor = DEFAULT_ROLES.find((r) => r.name === 'editor');
    for (const key of [
      PERMISSIONS.transferExport,
      PERMISSIONS.transferImport,
      PERMISSIONS.transferUsers,
    ]) {
      assert.match(key, /^cms\.transfer\./);
      assert.equal(editor?.permissions.includes(key), false, key);
    }
  });
});

describe('site configuration groups (phase B)', () => {
  test('each table is its own group, named by its key prefix', () => {
    assert.equal(groupOfItem('script:chat'), 'scripts');
    assert.equal(groupOfItem('cookie:analytics'), 'cookies');
    assert.equal(groupOfItem('shipzone:Greece'), 'shipping');
    assert.equal(groupOfItem('reviewloc:athens'), 'reviewLocations');
    assert.equal(groupOfItem('redirect:abc'), 'redirects');
    assert.equal(groupOfItem('seometa:el:/a'), 'seoMeta');
    assert.deepEqual(parseItemKey('seometa:el:/a:b'), { family: 'seoMeta', id: 'el:/a:b' });
  });

  test('configuration is written before content, and what points at content after it', () => {
    for (const g of ['scripts', 'cookies', 'shipping', 'reviewLocations'] as const) {
      assert.ok(groupDef(g).rank > groupDef('settings').rank, g);
      assert.ok(groupDef(g).rank < groupDef('documents:page').rank, g);
    }
    for (const g of ['redirects', 'seoMeta'] as const) assert.ok(groupDef(g).rank > groupDef('documents:page').rank, g);
    assert.ok(groupDef('cookies').rank < groupDef('scripts').rank, 'a script names its consent category');
  });

  test('each needs the permission its admin screen needs', () => {
    const imp = (p: string) => [PERMISSIONS.transferImport, p];
    assert.equal(canImportGroup(imp(PERMISSIONS.settingsWrite), 'scripts'), false, 'running code needs Manage scripts');
    assert.equal(canImportGroup(imp(PERMISSIONS.scriptsManage), 'scripts'), true);
    assert.equal(canImportGroup(imp(PERMISSIONS.seoWrite), 'redirects'), true);
    assert.equal(canImportGroup(imp(PERMISSIONS.seoRead), 'seoMeta'), false);
    assert.equal(canImportGroup(imp(PERMISSIONS.settingsWrite), 'shipping'), true);
    assert.equal(canExportGroup([PERMISSIONS.transferExport, PERMISSIONS.settingsRead], 'cookies'), true);
  });

  test('rows keyed by an address or a key cannot be copied; named ones can', () => {
    assert.deepEqual(groupDef('redirects').actions, ['skip', 'overwrite']);
    assert.deepEqual(groupDef('seoMeta').actions, ['skip', 'overwrite']);
    assert.deepEqual(groupDef('cookies').actions, ['skip', 'overwrite']);
    assert.deepEqual(groupDef('scripts').actions, ['skip', 'overwrite', 'copy']);
    assert.deepEqual(groupDef('shipping').actions, ['skip', 'overwrite', 'copy']);
  });

  test('module-owned tables name their module', () => {
    assert.equal(groupDef('shipping').module, 'commerce');
    assert.equal(groupDef('reviewLocations').module, 'googleReviews');
    assert.equal(groupDef('scripts').module, undefined);
  });
});

describe('people and transactions (phase C)', () => {
  test('each has its group, by key prefix', () => {
    const cases: Array<[string, string]> = [
      ['customer:a@x', 'customers'],
      ['subscriber:a@x', 'subscribers'],
      ['suppression:a@x', 'suppressions'],
      ['preview:abc', 'productReviews'],
      ['order:O-1', 'orders'],
      ['reservation:R-1', 'reservations'],
      ['slot:abc', 'bookingSlots'],
      ['role:editor', 'roles'],
      ['user:a@x', 'users'],
    ];
    for (const [key, group] of cases) assert.equal(groupOfItem(key), group, key);
  });

  test('personal data is flagged', () => {
    for (const g of ['customers', 'subscribers', 'suppressions', 'productReviews', 'orders', 'reservations', 'users'] as const) {
      assert.equal(groupDef(g).pii, true, g);
    }
    assert.equal(groupDef('roles').pii, false);
    assert.equal(groupDef('bookingSlots').pii, false);
  });

  test('written after the content and configuration they point at, roles before users, customers before orders', () => {
    const r = (g: Parameters<typeof groupDef>[0]) => groupDef(g).rank;
    assert.ok(r('roles') > r('documents:page') && r('roles') < r('users'));
    assert.ok(r('customers') < r('orders'));
    assert.ok(r('shipping') < r('orders'));
    assert.ok(r('bookingSlots') > r('documents:page') && r('reservations') > r('documents:page'));
    assert.ok(r('productReviews') > r('documents:page'));
  });

  test('admin accounts and roles need the separate "move admin accounts" permission, both ways', () => {
    const base = [PERMISSIONS.transferImport, PERMISSIONS.usersManage, PERMISSIONS.rolesManage];
    assert.equal(canImportGroup(base, 'users'), false);
    assert.equal(canImportGroup(base, 'roles'), false);
    assert.equal(canImportGroup([...base, PERMISSIONS.transferUsers], 'users'), true);
    assert.equal(canExportGroup([PERMISSIONS.transferExport, PERMISSIONS.usersManage], 'users'), false);
  });

  test('each needs its area permission', () => {
    const imp = (p: string) => [PERMISSIONS.transferImport, p];
    assert.equal(canImportGroup(imp(PERMISSIONS.ordersWrite), 'orders'), true);
    assert.equal(canImportGroup(imp(PERMISSIONS.ordersRead), 'orders'), false);
    assert.equal(canImportGroup(imp(PERMISSIONS.customersWrite), 'customers'), true);
    assert.equal(canImportGroup(imp(PERMISSIONS.newsletterWrite), 'subscribers'), true);
    assert.equal(canImportGroup(imp(PERMISSIONS.reservationsWrite), 'reservations'), true);
    assert.equal(canImportGroup(imp(PERMISSIONS.scheduleWrite), 'bookingSlots'), true);
    assert.equal(canImportGroup(imp(PERMISSIONS.reviewsWrite), 'productReviews'), true);
  });

  test('customers can also be merged; transactions only skipped or overwritten; modules named', () => {
    assert.deepEqual(groupDef('customers').actions, ['skip', 'overwrite', 'merge']);
    assert.deepEqual(groupDef('orders').actions, ['skip', 'overwrite']);
    assert.equal(groupDef('orders').module, 'commerce');
    assert.equal(groupDef('customers').module, 'customers');
    assert.equal(groupDef('subscribers').module, 'newsletter');
    assert.equal(groupDef('reservations').module, 'booking');
    assert.equal(groupDef('roles').module, undefined);
  });
});

describe('personal data needs an explicit yes', () => {
  test('a selection with personal data is refused until it is acknowledged, and names what it holds', async () => {
    const { piiProblem } = await import('@/cms/core/transfer/groups');
    const keys = ['doc:page:x', 'customer:a@x', 'order:O-1', 'order:O-2'];
    assert.match(piiProblem(keys, false) ?? '', /Customer accounts.*Orders/);
    assert.equal(piiProblem(keys, true), null);
    assert.equal(piiProblem(['doc:page:x', 'role:editor'], false), null);
  });
});
