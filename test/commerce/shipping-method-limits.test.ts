/**
 * The admin side of shipping methods: what a method may weigh, what it charges
 * by weight, and what a shopper is told it costs.
 *
 * - **A heavy parcel was quoted a method that cannot carry it.** A locker takes
 *   a few kilos; a method now has an optional `maxWeight` and is not offered
 *   (so `createOrder`, which re-quotes, refuses it) above that.
 * - **Weight tiers existed only in the database.** The quote priced them, but
 *   the admin API rejected them as an unknown key, so nobody could set them.
 * - **A method at 0 € is shown to customers as free.** Usually a slip — a price
 *   not typed in yet — so the admin is warned unless it is a store pickup.
 * - **The checkout started with no country**, so the delivery options were
 *   hidden until the customer typed one; it now starts at the shop's own.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  FREE_METHOD_WARNING,
  quoteMethods,
  showsAsFree,
  storeCountryCode,
  type ShippingMethodRow,
  type ShippingZoneRow,
} from '@/cms/modules/commerce/shipping-methods';
import { shippingMethodBody } from '@/cms/modules/commerce/shipping-service';
import { shippingMethods } from '@/cms/db/adapters/mysql/schema/shipping';

const zone: ShippingZoneRow = { id: 1, name: 'Greece', countries: ['GR'], sort: 0 };

const method = (over: Partial<ShippingMethodRow> = {}): ShippingMethodRow => ({
  id: 1,
  zoneId: 1,
  name: 'BoxNow',
  courier: 'boxnow',
  kind: 'locker',
  cost: 250,
  freeThreshold: null,
  etaMinDays: 1,
  etaMaxDays: 2,
  codAllowed: true,
  active: true,
  sort: 0,
  pickupLocationId: null,
  ...over,
});

const ctx = (totalWeight: number) => ({
  country: 'GR',
  subtotalCents: 2000,
  totalWeight,
  paymentProvider: 'stripe',
});

describe('maxWeight', () => {
  test('a method is not offered for an order heavier than its limit', () => {
    assert.deepEqual(quoteMethods([method({ maxWeight: 5 })], [zone], ctx(5.5)), []);
  });

  test('an order weighing exactly the limit is still offered the method', () => {
    assert.equal(quoteMethods([method({ maxWeight: 5 })], [zone], ctx(5)).length, 1);
  });

  test('no limit (null, or absent on an old row) offers it at any weight', () => {
    assert.equal(quoteMethods([method({ maxWeight: null })], [zone], ctx(500)).length, 1);
    assert.equal(quoteMethods([method()], [zone], ctx(500)).length, 1);
  });

  test('only the method over its limit drops out; the others stay', () => {
    const out = quoteMethods(
      [
        method({ id: 1, maxWeight: 2 }),
        method({ id: 2, courier: 'acs', kind: 'address', maxWeight: null }),
      ],
      [zone],
      ctx(3)
    );
    assert.deepEqual(
      out.map((m) => m.id),
      [2]
    );
  });

  test('is a nullable column on shipping_methods', () => {
    assert.equal(shippingMethods.maxWeight.name, 'max_weight');
    assert.equal(shippingMethods.maxWeight.notNull, false);
  });
});

describe('showsAsFree', () => {
  test('a delivered method at 0 is shown to customers as free', () => {
    assert.equal(showsAsFree({ cost: 0, kind: 'address' }), true);
    assert.equal(showsAsFree({ cost: 0, kind: 'locker' }), true);
  });

  test('a priced method, or a store pickup at 0, is not flagged', () => {
    assert.equal(showsAsFree({ cost: 350, kind: 'address' }), false);
    assert.equal(showsAsFree({ cost: 0, kind: 'pickup' }), false);
  });

  test('the warning says what the customer sees', () => {
    assert.match(FREE_METHOD_WARNING, /shown to customers as free/i);
  });
});

describe('the admin method body', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    zoneId: 1,
    name: 'ACS',
    courier: 'acs',
    kind: 'address',
    cost: 350,
    ...over,
  });
  const parse = (over: Record<string, unknown> = {}) => shippingMethodBody.safeParse(body(over));

  test('accepts weight tiers in ascending order', () => {
    const res = parse({
      weightTiers: [
        { minWeight: 2, charge: 150 },
        { minWeight: 5.5, charge: 400 },
      ],
    });
    assert.equal(res.success, true);
    if (res.success)
      assert.deepEqual(res.data.weightTiers, [
        { minWeight: 2, charge: 150 },
        { minWeight: 5.5, charge: 400 },
      ]);
  });

  test('leaving weight tiers out leaves them unchanged (not wiped)', () => {
    const res = parse();
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.weightTiers, undefined);
  });

  test('refuses tiers out of order or repeating a weight', () => {
    assert.equal(
      parse({
        weightTiers: [
          { minWeight: 5, charge: 400 },
          { minWeight: 2, charge: 150 },
        ],
      }).success,
      false
    );
    assert.equal(
      parse({
        weightTiers: [
          { minWeight: 2, charge: 150 },
          { minWeight: 2, charge: 400 },
        ],
      }).success,
      false
    );
  });

  test('refuses negative weights or charges, fractional cents and unknown keys', () => {
    assert.equal(parse({ weightTiers: [{ minWeight: -1, charge: 150 }] }).success, false);
    assert.equal(parse({ weightTiers: [{ minWeight: 1, charge: -5 }] }).success, false);
    assert.equal(parse({ weightTiers: [{ minWeight: 1, charge: 1.5 }] }).success, false);
    assert.equal(
      parse({ weightTiers: [{ minWeight: 1, charge: 100, extra: true }] }).success,
      false
    );
  });

  test('refuses an unbounded list of tiers', () => {
    const tiers = Array.from({ length: 21 }, (_, i) => ({ minWeight: i + 1, charge: 100 }));
    assert.equal(parse({ weightTiers: tiers }).success, false);
    assert.equal(parse({ weightTiers: tiers.slice(0, 20) }).success, true);
  });

  test('accepts a positive weight limit, or null for none', () => {
    assert.equal(parse({ maxWeight: 5 }).success, true);
    assert.equal(parse({ maxWeight: 0.5 }).success, true);
    const none = parse({ maxWeight: null });
    assert.equal(none.success, true);
    if (none.success) assert.equal(none.data.maxWeight, null);
  });

  test('refuses a zero or negative weight limit', () => {
    assert.equal(parse({ maxWeight: 0 }).success, false);
    assert.equal(parse({ maxWeight: -2 }).success, false);
  });
});

describe('the store’s country at checkout', () => {
  test('a recognisable store country becomes the ISO code zones match', () => {
    assert.equal(storeCountryCode('Greece'), 'GR');
    assert.equal(storeCountryCode('Ελλάδα'), 'GR');
    assert.equal(storeCountryCode('cy'), 'CY');
  });

  test('an empty or unrecognised country starts the field empty rather than guessing', () => {
    assert.equal(storeCountryCode(''), '');
    assert.equal(storeCountryCode('Somewhere far'), '');
  });

  const strip = (path: string) =>
    readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');

  test('the page passes the store’s country from the brand address', () => {
    const page = strip('src/app/[locale]/checkout/page.tsx');
    assert.match(page, /storeCountryCode\([^)]*address\.country\)/);
    assert.match(page, /storeCountry=\{/);
  });

  test('the form starts at the customer’s own country, else the store’s', () => {
    const client = strip('src/app/[locale]/checkout/CheckoutClient.tsx');
    assert.match(client, /country:\s*account\?\.prefill\?\.country\s*\|\|\s*storeCountry/);
  });
});
