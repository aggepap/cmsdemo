/**
 * Once a shop defines delivery methods, the customer's choice is what the order
 * is shipped and charged by — on the server and on the checkout summary alike.
 *
 * Two ways that did not hold:
 *
 * - **An order without a method fell back to the old flat rate.** `createOrder`
 *   only looked at methods when the body named one, so a body that left
 *   `shippingMethodId` out (an old tab, a script) was charged the legacy
 *   flat/zone price and shipped with no courier — although the admin says "the
 *   moment one method exists, checkout offers these instead".
 * - **The summary showed a different price from the one charged.** The picker
 *   listed each method at its own cost ("Free shipping") while the order total
 *   underneath used the legacy estimate (5 €); the server then charged the
 *   method's cost. The summary now uses the chosen method.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { overweightForEveryMethod, shippingChoiceMissing } from '@/cms/modules/commerce/shipping-methods';
import { checkoutShippingCharge } from '@/components/checkout/shipping-charge';

describe('shippingChoiceMissing', () => {
  const base = { allVirtual: false, wantsPickup: false, shippingMethodId: undefined, choiceCount: 2 };

  test('a delivered order must name one of the methods on offer', () => {
    assert.equal(shippingChoiceMissing(base), true);
  });

  test('a named method is not missing', () => {
    assert.equal(shippingChoiceMissing({ ...base, shippingMethodId: 4 }), false);
  });

  test('no methods for this destination: the legacy calculation still applies', () => {
    assert.equal(shippingChoiceMissing({ ...base, choiceCount: 0 }), false);
  });

  test('nothing to ship, or collected in store, needs no delivery method', () => {
    assert.equal(shippingChoiceMissing({ ...base, allVirtual: true }), false);
    assert.equal(shippingChoiceMissing({ ...base, wantsPickup: true }), false);
  });
});

describe('checkoutShippingCharge', () => {
  const quote = { shipping: 500, surcharge: 200 };

  test('without a chosen method, the estimate is shown', () => {
    assert.deepEqual(checkoutShippingCharge(quote, null), { shipping: 500, surcharge: 200 });
    assert.deepEqual(checkoutShippingCharge(null, null), { shipping: 0, surcharge: 0 });
  });

  test('a chosen method is what the summary charges — the same as the server', () => {
    assert.deepEqual(checkoutShippingCharge(quote, { cost: 0, surcharge: 150 }), { shipping: 0, surcharge: 150 });
    assert.deepEqual(checkoutShippingCharge(null, { cost: 350, surcharge: 0 }), { shipping: 350, surcharge: 0 });
  });
});

// A shop whose every method has a weight limit below this basket used to fall
// through to the legacy flat price — a heavy parcel shipped at the base rate,
// with no courier, by a method nobody offered. It is refused instead.
describe('overweightForEveryMethod', () => {
  test('methods exist for the address but none carries this weight', () => {
    assert.equal(overweightForEveryMethod({ choiceCount: 0, unweightedChoiceCount: 2 }), true);
  });

  test('some method carries it', () => {
    assert.equal(overweightForEveryMethod({ choiceCount: 1, unweightedChoiceCount: 2 }), false);
  });

  test('no methods for the address at all: the legacy calculation still applies', () => {
    assert.equal(overweightForEveryMethod({ choiceCount: 0, unweightedChoiceCount: 0 }), false);
  });
});

test('createOrder refuses an order too heavy for every delivery method', () => {
  const orders = readFileSync(new URL('../../src/cms/modules/commerce/orders.ts', import.meta.url), 'utf8');
  assert.match(orders, /overweightForEveryMethod\(/);
  assert.match(orders, /totalWeight: 0/);
});
