/**
 * Checkout re-prices every line from the product documents, and that is also
 * where it decides whether the line can be bought at all. It could, when it
 * should not have:
 *
 * - a product with no published row (a draft, or one that was unpublished) was
 *   still found by slug, through a `?? rows[0]` fallback;
 * - a disabled variation was sold;
 * - `availability: 'out-of-stock'` on an untracked product was ignored;
 * - an `external` (affiliate) product, which has no checkout, was sold;
 * - a `variationId` that matched nothing was charged the base price.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { needsVariationChoice, orderableRow, lineUnavailableReason } from '@/cms/modules/commerce/orderable';

describe('orderableRow', () => {
  const row = (id: number, status: string, locale: string) => ({ id, status, locale });

  test('prefers the published row in the shopper locale, then any published row', () => {
    assert.equal(orderableRow([row(1, 'published', 'en'), row(2, 'published', 'el')], 'el')?.id, 2);
    assert.equal(orderableRow([row(1, 'draft', 'el'), row(2, 'published', 'en')], 'el')?.id, 2);
  });

  test('finds nothing when no row is published', () => {
    assert.equal(orderableRow([row(1, 'draft', 'el'), row(2, 'draft', 'en')], 'el'), undefined);
    assert.equal(orderableRow([], 'el'), undefined);
  });
});

describe('lineUnavailableReason', () => {
  const base = { title: 'Mug', price: 10 };

  test('a plain in-stock product is fine', () => {
    assert.equal(lineUnavailableReason(base, undefined), null);
    assert.equal(lineUnavailableReason({ ...base, availability: 'preorder' }, undefined), null);
  });

  test('refuses an external product', () => {
    assert.ok(lineUnavailableReason({ ...base, productType: 'external' }, undefined));
  });

  test('refuses out-of-stock availability when stock is not tracked', () => {
    assert.ok(lineUnavailableReason({ ...base, availability: 'out-of-stock' }, undefined));
  });

  test('leaves tracked stock to the stock check', () => {
    assert.equal(lineUnavailableReason({ ...base, availability: 'out-of-stock', stock: 3 }, undefined), null);
    const withVariationStock = {
      ...base,
      availability: 'out-of-stock',
      variations: [{ id: 'v1', stock: 2 }],
    };
    assert.equal(lineUnavailableReason(withVariationStock, 'v1'), null);
  });

  test('refuses a variation id that matches nothing', () => {
    assert.ok(lineUnavailableReason({ ...base, variations: [{ id: 'v1' }] }, 'nope'));
    assert.ok(lineUnavailableReason(base, 'nope'));
  });

  // The storefront disables Add to cart until every option is picked, but the
  // checkout body comes from the browser: a line that names a variable product
  // and no variation used to be sold at the base price with no variant on the
  // order, leaving the shop to phone the customer to ask which one they meant.
  test('refuses a product with variations when no variation is chosen', () => {
    const variable = {
      ...base,
      attributes: [{ id: 'colour', name: 'Colour', values: [{ id: 'black', label: 'Black' }] }],
      variations: [{ id: 'v1' }],
    };
    assert.equal(lineUnavailableReason(variable, undefined), 'variation_required');
    assert.equal(lineUnavailableReason(variable, ''), 'variation_required');
    assert.equal(lineUnavailableReason(variable, 'v1'), null);
  });

  test('variation rows without attributes are not a choice (the product page offers none)', () => {
    assert.equal(lineUnavailableReason({ ...base, variations: [{ id: 'v1' }] }, undefined), null);
    assert.equal(needsVariationChoice({ ...base, variations: [{ id: 'v1' }] }), false);
    assert.equal(needsVariationChoice({ ...base, attributes: [{ id: 'a' }] }), false);
    assert.equal(needsVariationChoice({ ...base, attributes: [{ id: 'a' }], variations: [{ id: 'v1' }] }), true);
  });

  test('refuses a disabled variation and accepts an enabled one', () => {
    const data = { ...base, variations: [{ id: 'off', enabled: false }, { id: 'on', enabled: true }, { id: 'unset' }] };
    assert.ok(lineUnavailableReason(data, 'off'));
    assert.equal(lineUnavailableReason(data, 'on'), null);
    assert.equal(lineUnavailableReason(data, 'unset'), null);
  });
});

test('createOrder uses both guards and no longer falls back to an unpublished row', () => {
  const orders = readFileSync(new URL('../../src/cms/modules/commerce/orders.ts', import.meta.url), 'utf8');
  assert.match(orders, /orderableRow\(rows, line\.locale\)/);
  assert.match(orders, /lineUnavailableReason\(data, line\.variationId\)/);
  assert.doesNotMatch(orders, /\?\?\s*rows\[0\]/);
});
