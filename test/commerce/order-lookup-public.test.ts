/**
 * What the guest order lookup returns (eyelike R3-3).
 *
 * `POST /api/cms/commerce/order-lookup` answers anyone holding a reference and
 * the email it was placed with. It used to spread the whole order: `metadata`
 * (the consent record, the phone, `codAmount`, the analytics context) and every
 * line's full product `snapshot` — every field, prices, stock. It is now an
 * allow-list, like the payments already were: what the order page shows, and
 * nothing a column added later can leak by default.
 *
 * It also carries the bank-transfer instructions while a transfer is still
 * owed, so the order page can show them again — the thank-you page had them,
 * and after that only the email did.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { publicOrder } from '@/cms/modules/commerce/order-public';

const order = {
  id: 41,
  reference: 'ORD-2026-ABC123',
  status: 'pending',
  email: 'maria@example.com',
  customerId: 7,
  shippingMethodId: 3,
  customerName: 'Μαρία',
  currency: 'EUR',
  subtotal: 12000,
  total: 13500,
  locale: 'el',
  notes: 'Χωρίς σακούλα',
  version: 4,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-01T10:05:00Z'),
  metadata: {
    shipping: {
      phone: '6900000000',
      address1: 'Ερμού 1',
      city: 'Αθήνα',
      postal: '10563',
      country: 'GR',
      method: 'ship',
      shippingMethod: { id: 3, name: 'ACS', courier: 'acs', kind: 'courier', cost: 350 },
    },
    costs: { shipping: 350, surcharge: 0, discount: 0, giftWrap: 0 },
    coupon: 'AUTUMN10',
    gift: { wrap: true, message: 'Χρόνια πολλά' },
    consent: { terms: true, marketing: false, at: '2026-10-01T10:00:00Z' },
    analytics: { fbp: 'fb.1.123', ip: '203.0.113.9' },
    codAmount: 13500,
    internalNote: 'x',
  },
  items: [
    {
      id: 90,
      orderId: 41,
      productId: 501,
      sku: 'RB-3025',
      name: 'Ray-Ban Aviator',
      variationId: 'v1',
      variantLabel: 'Gold',
      unitPrice: 12000,
      quantity: 1,
      lineTotal: 12000,
      createdAt: new Date('2026-10-01T10:00:00Z'),
      snapshot: {
        title: 'Ray-Ban Aviator',
        price: 120,
        costPrice: 55,
        stock: 3,
        gallery: [
          { image: 'uuid-front', alt: 'Front view' },
          { image: 'uuid-side', alt: 'Side' },
        ],
      },
    },
  ],
  payments: [
    {
      id: 1,
      orderId: 41,
      provider: 'bank_transfer',
      status: 'pending',
      amount: 13500,
      currency: 'EUR',
      method: null,
      createdAt: new Date('2026-10-01T10:00:00Z'),
      metadata: { secret: 'x' },
      error: null,
    },
  ],
};

describe('publicOrder', () => {
  const out = publicOrder(order, { paymentInstructions: 'IBAN GR00 0000' }) as unknown as Record<
    string,
    unknown
  >;

  test('keeps what the order page shows', () => {
    for (const key of [
      'reference',
      'status',
      'customerName',
      'currency',
      'subtotal',
      'total',
      'locale',
      'notes',
      'createdAt',
    ]) {
      assert.ok(key in out, key);
    }
  });

  test('drops the internal columns', () => {
    for (const key of ['id', 'customerId', 'shippingMethodId', 'version', 'updatedAt']) {
      assert.equal(key in out, false, key);
    }
  });

  test('metadata: shipping without the phone, costs, coupon and gift — and nothing else', () => {
    const meta = out.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(meta).sort(), ['costs', 'coupon', 'gift', 'shipping']);
    const shipping = meta.shipping as Record<string, unknown>;
    assert.equal(shipping.city, 'Αθήνα');
    assert.equal('phone' in shipping, false);
    assert.deepEqual(shipping.shippingMethod, {
      name: 'ACS',
      courier: 'acs',
      kind: 'courier',
      cost: 350,
    });
  });

  test('each line: what was bought, its image — and no snapshot', () => {
    const [line] = out.items as Record<string, unknown>[];
    assert.deepEqual(line, {
      id: 90,
      name: 'Ray-Ban Aviator',
      sku: 'RB-3025',
      variantLabel: 'Gold',
      unitPrice: 12000,
      quantity: 1,
      lineTotal: 12000,
      image: { uuid: 'uuid-front', alt: 'Front view' },
    });
  });

  test('a line without a gallery has no image', () => {
    const bare = { ...order, items: [{ ...order.items[0], snapshot: null }] };
    const [line] = publicOrder(bare, {}).items;
    assert.equal(line.image, null);
  });

  test('payments keep only their public fields', () => {
    const [payment] = out.payments as Record<string, unknown>[];
    assert.equal('metadata' in payment, false);
    assert.equal('error' in payment, false);
    assert.equal(payment.provider, 'bank_transfer');
  });

  test('the bank-transfer instructions ride along when given, and are null otherwise', () => {
    assert.equal(out.paymentInstructions, 'IBAN GR00 0000');
    assert.equal(publicOrder(order, {}).paymentInstructions, null);
  });
});

describe('lookupOrder', () => {
  const src = readFileSync(
    new URL('../../src/cms/modules/commerce/orders.ts', import.meta.url),
    'utf8'
  );
  const body = src.slice(
    src.indexOf('export async function lookupOrder'),
    src.indexOf('// ── Emails')
  );

  test('reads the instructions only while a bank transfer is still owed', () => {
    assert.match(body, /owesBankTransfer\(/);
    assert.match(body, /getBankTransferInstructions\(/);
    assert.match(body, /publicOrder\(/);
  });

  test('the old spread-everything publicOrder is gone from the order service', () => {
    assert.doesNotMatch(src, /function publicOrder\(/);
  });
});
