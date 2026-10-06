import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { adminUsers, bookingSlots, customers, orders } from '@/cms/db/adapters/mysql/schema';
import { decodeRow, encodeRow } from '@/cms/core/transfer/tables/row-codec';

/**
 * Phase C moves whole database rows (customers, orders, reservations…). One
 * codec, driven by the table's own column definitions, turns a row into a
 * package record and back — and on the way back refuses anything the column
 * could not hold, because a package is a user upload.
 */

const created = new Date('2026-01-02T03:04:05.000Z');

describe('encodeRow', () => {
  test('keeps every column but the omitted ones, dates as ISO strings', () => {
    const r = encodeRow(
      customers,
      {
        id: 7,
        email: 'a@example.com',
        name: 'A',
        phone: null,
        locale: 'el',
        passwordHash: 'secret',
        emailVerifiedAt: null,
        status: 'active',
        tokenVersion: 3,
        marketingOptIn: true,
        lastLoginAt: created,
        deletedAt: null,
        createdAt: created,
        updatedAt: created,
      },
      ['id', 'passwordHash', 'tokenVersion', 'lastLoginAt']
    );
    assert.equal('id' in r, false);
    assert.equal('passwordHash' in r, false);
    assert.equal(r.createdAt, '2026-01-02T03:04:05.000Z');
    assert.equal(r.marketingOptIn, true);
  });

  test('never exports binary columns (encrypted secrets)', () => {
    const r = encodeRow(adminUsers, { email: 'a@x', totpSecretEncrypted: Buffer.from('x') } as never, []);
    assert.equal('totpSecretEncrypted' in r, false);
  });
});

describe('decodeRow', () => {
  const order = {
    reference: 'ORD-1',
    status: 'paid',
    email: 'a@example.com',
    customerName: 'A',
    currency: 'EUR',
    subtotal: 1000,
    total: 1200,
    locale: 'el',
    notes: null,
    metadata: { x: 1 },
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
  };
  const omit = ['id', 'customerId', 'shippingMethodId', 'version'];

  test('turns a record back into column values', () => {
    const r = decodeRow(orders, order, omit);
    assert.ok(r.ok);
    assert.ok(r.ok && r.values.createdAt instanceof Date);
    assert.equal(r.ok && r.values.total, 1200);
  });

  test('refuses what a column cannot hold', () => {
    const bad = (over: object) => decodeRow(orders, { ...order, ...over }, omit).ok;
    assert.equal(bad({ status: 'stolen' }), false, 'enum');
    assert.equal(bad({ reference: 'x'.repeat(33) }), false, 'length');
    assert.equal(bad({ total: 1.5 }), false, 'integer');
    assert.equal(bad({ createdAt: 'yesterday' }), false, 'timestamp');
    assert.equal(bad({ email: null }), false, 'not null');
    assert.equal(bad({ metadata: { big: 'x'.repeat(2_000_000) } }), false, 'json size');
  });

  test('a required column without a default must be present', () => {
    const rest: Record<string, unknown> = { ...order };
    delete rest.reference;
    const r = decodeRow(orders, rest, omit);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.errors.some((e) => e.includes('reference')));
  });

  test('omitted columns and unknown keys are ignored, never written', () => {
    const r = decodeRow(orders, { ...order, id: 99, customerId: 5, surprise: 1 }, omit);
    assert.ok(r.ok);
    assert.equal(r.ok && 'id' in r.values, false);
    assert.equal(r.ok && 'customerId' in r.values, false);
    assert.equal(r.ok && 'surprise' in r.values, false);
  });

  test('date-only columns must be YYYY-MM-DD', () => {
    assert.equal(decodeRow(bookingSlots, { slotKey: 'exp:x', slotDate: '2026-07-01', closed: false }, ['id']).ok, true);
    assert.equal(decodeRow(bookingSlots, { slotKey: 'exp:x', slotDate: '1/7/2026', closed: false }, ['id']).ok, false);
  });
});
