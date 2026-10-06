import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PERMISSIONS } from '@/cms/modules/auth/permissions';
import {
  checkGrantable,
  fillMissing,
  mapBookingGroupId,
  mapSlotKey,
  peopleDeps,
  peopleKey,
} from '@/cms/core/transfer/tables/people';

/**
 * Phase C: people and transactions. Rows keyed by an email or a reference,
 * linked to documents (a reservation's experience, an order's products) whose
 * ids and translation groups differ on the target.
 */

describe('peopleKey', () => {
  test('keys rows by what identifies them on any site, emails lower-cased', () => {
    assert.equal(peopleKey.customer('A@Example.com'), 'customer:a@example.com');
    assert.equal(peopleKey.subscriber('B@x.gr'), 'subscriber:b@x.gr');
    assert.equal(peopleKey.suppression('c@x.gr'), 'suppression:c@x.gr');
    assert.equal(peopleKey.order('ORD-1'), 'order:ORD-1');
    assert.equal(peopleKey.reservation('R-9'), 'reservation:R-9');
    assert.equal(peopleKey.role('editor'), 'role:editor');
    assert.equal(peopleKey.user('Admin@x.gr'), 'user:admin@x.gr');
    assert.match(peopleKey.slot('exp:g', '2026-07-01'), /^slot:[0-9a-f]{24}$/);
    assert.match(peopleKey.productReview('g', 'a@x', '2026-01-01T00:00:00.000Z'), /^preview:[0-9a-f]{24}$/);
  });
});

describe('booking keys follow their documents', () => {
  const maps = { group: (g: string) => ({ src: 'tgt' })[g] ?? null, doc: (id: number) => (id === 7 ? 70 : null), option: (o: string) => ({ o1: 'n1' })[o] ?? null };

  test('an experience slot follows its translation group, an option slot its (copied) option id', () => {
    assert.equal(mapSlotKey('exp:src', maps), 'exp:tgt');
    assert.equal(mapSlotKey('res:o1', maps), 'res:n1');
    assert.equal(mapSlotKey('res:o2', maps), 'res:o2', 'an option not copied keeps its id');
    assert.equal(mapSlotKey('exp:unknown', maps), null, 'an experience not on this site has no calendar here');
  });

  test('a booking group id may be a translation group or the doc:<id> fallback', () => {
    assert.equal(mapBookingGroupId('src', maps), 'tgt');
    assert.equal(mapBookingGroupId('doc:7', maps), 'doc:70');
    assert.equal(mapBookingGroupId('doc:8', maps), null);
  });
});

describe('fillMissing', () => {
  test('merge keeps what this site has and fills only what it lacks', () => {
    assert.deepEqual(fillMissing({ name: 'Here', phone: null, locale: 'el' }, { name: 'There', phone: '69', locale: 'en' }), {
      name: 'Here',
      phone: '69',
      locale: 'el',
    });
  });
});

describe('checkGrantable', () => {
  test('keeps known permissions the importer holds, drops unknown ones, refuses the rest', () => {
    const r = checkGrantable(
      [PERMISSIONS.contentRead, 'cms.made.up', PERMISSIONS.usersManage],
      [PERMISSIONS.contentRead, PERMISSIONS.rolesManage]
    );
    assert.deepEqual(r.kept, [PERMISSIONS.contentRead]);
    assert.deepEqual(r.unknown, ['cms.made.up']);
    assert.deepEqual(r.refused, [PERMISSIONS.usersManage]);
  });

  test('full access and wildcards are real permissions, grantable only by someone who has them', () => {
    assert.deepEqual(checkGrantable(['*'], [PERMISSIONS.rolesManage]).refused, ['*']);
    assert.deepEqual(checkGrantable(['*', 'cms.seo.*'], ['*']).kept, ['*', 'cms.seo.*']);
    assert.deepEqual(checkGrantable(['cms.nothing.*'], ['*']).unknown, ['cms.nothing.*']);
  });
});

describe('peopleDeps', () => {
  test('what each row needs to come along', () => {
    assert.deepEqual(
      peopleDeps('orders', {
        customerEmail: 'A@x.gr',
        shippingMethodRef: { zone: 'Greece', name: 'ACS' },
        items: [{ productSid: 5 }, { productSid: null }],
      }),
      [{ kind: 'customer', value: 'a@x.gr' }, { kind: 'zone', value: 'Greece' }, { kind: 'doc', value: 5 }]
    );
    assert.deepEqual(peopleDeps('reservations', { bookingSid: 3, resourceSid: 4 }), [
      { kind: 'doc', value: 3 },
      { kind: 'doc', value: 4 },
    ]);
    assert.deepEqual(peopleDeps('customers', { wishlist: [{ productSid: 9 }] }), [{ kind: 'doc', value: 9 }]);
    assert.deepEqual(peopleDeps('users', { roles: ['editor'] }), [{ kind: 'role', value: 'editor' }]);
    assert.deepEqual(peopleDeps('productReviews', { productSid: 2 }), [{ kind: 'doc', value: 2 }]);
    assert.deepEqual(peopleDeps('bookingSlots', { bookingSid: 3 }), [{ kind: 'doc', value: 3 }]);
    assert.deepEqual(peopleDeps('subscribers', {}), []);
  });
});
