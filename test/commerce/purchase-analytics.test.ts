/**
 * The `purchase` event's parameters, built by the server from the stored order
 * (REQ-5 §3): transaction id, value, tax, shipping, currency, coupon and items
 * all come from what the order actually charged — never from the browser's own
 * arithmetic. A gift card is an item like any other.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { purchaseAnalytics } from '@/cms/modules/commerce/analytics';

const base = {
  reference: 'ORD-2026-ABC123',
  currency: 'EUR',
  defaultVatBps: 2400,
  shipping: 0,
  surcharge: 0,
  discount: 0,
  coupon: null,
};

describe('purchaseAnalytics', () => {
  test('one line, VAT included: value is the order total and tax is the VAT inside it', () => {
    const out = purchaseAnalytics({
      ...base,
      total: 12400,
      lines: [{ itemId: 'MUG-1', name: 'Mug', variant: 'Blue', unitPrice: 6200, quantity: 2, lineTotal: 12400, vatBps: 2400, giftCard: false }],
    });
    assert.deepEqual(out, {
      transaction_id: 'ORD-2026-ABC123',
      value: 124,
      tax: 24,
      shipping: 0,
      currency: 'EUR',
      items: [{ item_id: 'MUG-1', item_name: 'Mug', item_variant: 'Blue', price: 62, quantity: 2 }],
    });
  });

  test('shipping and the payment surcharge are shipping; their VAT is in tax', () => {
    const out = purchaseAnalytics({
      ...base,
      total: 12400 + 620 + 124,
      shipping: 620,
      surcharge: 124,
      lines: [{ itemId: 'MUG-1', name: 'Mug', unitPrice: 12400, quantity: 1, lineTotal: 12400, vatBps: 2400, giftCard: false }],
    });
    assert.equal(out.shipping, 7.44);
    assert.equal(out.tax, 25.44);
  });

  test('a coupon is named and its discount lowers the tax in proportion', () => {
    const out = purchaseAnalytics({
      ...base,
      total: 6200,
      discount: 6200,
      coupon: 'HALF',
      lines: [{ itemId: 'MUG-1', name: 'Mug', unitPrice: 12400, quantity: 1, lineTotal: 12400, vatBps: 2400, giftCard: false }],
    });
    assert.equal(out.coupon, 'HALF');
    assert.equal(out.value, 62);
    assert.equal(out.tax, 12);
  });

  test('a gift card is an item, named by the product — never by its recipient', () => {
    const out = purchaseAnalytics({
      ...base,
      total: 5000,
      lines: [{ itemId: '42', name: 'Gift card', variant: '→ maria@example.com', unitPrice: 5000, quantity: 1, lineTotal: 5000, vatBps: 0, giftCard: true }],
    });
    assert.deepEqual(out.items, [{ item_id: '42', item_name: 'Gift card', item_category: 'gift_card', price: 50, quantity: 1 }]);
    assert.doesNotMatch(JSON.stringify(out), /maria/);
  });

  test('amounts are rounded to cents', () => {
    const out = purchaseAnalytics({
      ...base,
      total: 1000,
      lines: [{ itemId: 'X', name: 'X', unitPrice: 1000, quantity: 1, lineTotal: 1000, vatBps: 1300, giftCard: false }],
    });
    assert.equal(out.tax, 1.15);
  });
});
