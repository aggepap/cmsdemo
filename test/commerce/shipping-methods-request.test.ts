/**
 * The checkout's delivery-method list and the route it asks.
 *
 * `ShippingMethodPicker` posted `{ country, subtotalCents }`, but the quote
 * route requires `locale` and `items` — so every request failed validation, the
 * picker read the error as "no methods", and a shop that had defined delivery
 * methods never showed them. The request is now built by one exported function
 * and checked here against the route's own schema, so the two cannot drift
 * apart again.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { shippingQuoteBody } from '@/cms/modules/commerce/shipping';
import { shippingMethodsRequest } from '@/components/checkout/shipping-methods-request';

describe('shippingMethodsRequest', () => {
  test('is accepted by the quote route', () => {
    const body = shippingMethodsRequest({ country: 'GR', subtotalCents: 5000, paymentMethod: 'klarna', locale: 'el' });
    const parsed = shippingQuoteBody.safeParse(body);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  });

  test('carries what the method list is priced on', () => {
    const body = shippingMethodsRequest({ country: 'GR', subtotalCents: 5000, paymentMethod: 'manual', locale: 'en' });
    assert.equal(body.country, 'GR');
    assert.equal(body.subtotalCents, 5000);
    // Decides whether cash-on-delivery methods are offered.
    assert.equal(body.paymentMethod, 'manual');
    assert.equal(body.locale, 'en');
  });

  // A method's weight tiers can only be priced when the route knows what is in
  // the basket; with `items: []` the list was always quoted at 0 kg while the
  // order was charged the real weight.
  test('carries the cart lines, so the route can price weight', () => {
    const items = [{ slug: 'frame', variationId: 'v1', quantity: 2 }];
    const body = shippingMethodsRequest({ country: 'GR', subtotalCents: 5000, paymentMethod: 'manual', locale: 'el', items });
    assert.deepEqual(body.items, items);
    assert.ok(shippingQuoteBody.safeParse(body).success);
  });

  test('the old body really was refused — this is the bug being fixed', () => {
    assert.equal(shippingQuoteBody.safeParse({ country: 'GR', subtotalCents: 5000 }).success, false);
  });
});
