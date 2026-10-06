/**
 * Cart lines as GA4 `items` (REQ-5 §3). A gift card is an item named by the
 * product — its label carries the recipient, which is never sent.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { bookingPurchasePayload, cartItemsPayload, productListPayload, toAnalyticsItem } from '@/lib/analytics/items';

describe('toAnalyticsItem', () => {
  test('a product line: SKU as id, options as variant, price in major units', () => {
    assert.deepEqual(
      toAnalyticsItem({ slug: 'mug', sku: 'MUG-1', title: 'Mug', optionsLabel: 'Blue', unitPrice: 12.5, quantity: 2 }),
      { item_id: 'MUG-1', item_name: 'Mug', item_variant: 'Blue', price: 12.5, quantity: 2 },
    );
  });

  test('without a SKU the slug identifies it', () => {
    assert.equal(toAnalyticsItem({ slug: 'mug', title: 'Mug', unitPrice: 1, quantity: 1 }).item_id, 'mug');
  });

  test('a gift card line never carries its recipient', () => {
    const item = toAnalyticsItem({
      slug: 'gift-card',
      title: 'Gift card',
      optionsLabel: '→ maria@example.com',
      unitPrice: 50,
      quantity: 1,
      giftCard: { recipientName: 'Maria' },
    });
    assert.deepEqual(item, { item_id: 'gift-card', item_name: 'Gift card', item_category: 'gift_card', price: 50, quantity: 1 });
  });
});

describe('productListPayload', () => {
  test('the list id and the products shown, in order', () => {
    assert.deepEqual(
      productListPayload('search', [{ slug: 'a', title: 'A', price: 10 }, { slug: 'b', title: 'B', price: 2.5 }]),
      {
        item_list_id: 'search',
        items: [
          { item_id: 'a', item_name: 'A', price: 10, index: 0 },
          { item_id: 'b', item_name: 'B', price: 2.5, index: 1 },
        ],
      },
    );
  });
});

describe('cartItemsPayload', () => {
  test('items, value and currency together', () => {
    assert.deepEqual(
      cartItemsPayload([{ slug: 'a', title: 'A', unitPrice: 10, quantity: 2 }, { slug: 'b', title: 'B', unitPrice: 0.1, quantity: 3 }], 'EUR'),
      {
        items: [
          { item_id: 'a', item_name: 'A', price: 10, quantity: 2 },
          { item_id: 'b', item_name: 'B', price: 0.1, quantity: 3 },
        ],
        value: 20.3,
        currency: 'EUR',
      },
    );
  });
});

describe('bookingPurchasePayload', () => {
  test('the reservation as one item, amounts from the server in minor units', () => {
    assert.deepEqual(
      bookingPurchasePayload({ reference: 'BKG-2026-ABCD', total: 25050, currency: 'EUR', itemId: 'sunset-cruise', itemName: 'Sunset cruise' }),
      {
        transaction_id: 'BKG-2026-ABCD',
        value: 250.5,
        currency: 'EUR',
        items: [{ item_id: 'sunset-cruise', item_name: 'Sunset cruise', item_category: 'booking', price: 250.5, quantity: 1 }],
      },
    );
  });
});
