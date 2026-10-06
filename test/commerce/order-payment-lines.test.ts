/**
 * An order as the lines a gateway is told about, with VAT.
 *
 * Prices in this shop are VAT-inclusive and stay that way; what is new is
 * knowing WHICH rate is inside each one. The shop has a default rate
 * (Settings → Ecommerce → VAT rate, 24% unless changed) and a product can carry
 * its own (reduced rates: 13% food, 6% books).
 *
 * The rules, each a test below:
 *  - a product line carries its product's rate, or the shop default;
 *  - a gift card product is 0% — a multi-purpose voucher is not taxed when
 *    sold, only when spent;
 *  - a coupon discount reduces the taxable amount of each rate in proportion,
 *    so it is split into one discount line per rate, summing exactly;
 *  - shipping, gift wrap and the payment surcharge follow the main supply, at
 *    the default rate;
 *  - gift cards spent on the order are a 0% credit — a way of paying, not a
 *    price reduction;
 *  - and the lines always add up to exactly the amount charged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { ECOMMERCE_VAT_RATE_KEY, MANAGED_SETTINGS } from '@/cms/core/settings/schema';
import { orderLineLabels, orderPaymentLines, productVatBps } from '@/cms/modules/commerce/payment-lines';

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');

function fnBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = text.slice(start + 1).search(/\n(export )?(async )?function /);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

const labels = orderLineLabels('en');
const sum = (lines: { totalAmount: number }[]) => lines.reduce((s, l) => s + l.totalAmount, 0);

describe('productVatBps', () => {
  test('a product’s own rate wins, as a percentage', () => {
    assert.equal(productVatBps({ vatRate: 13 }, 2400), 1300);
    assert.equal(productVatBps({ vatRate: '6' }, 2400), 600);
  });

  test('no rate, or nonsense, is the shop default', () => {
    assert.equal(productVatBps({}, 2400), 2400);
    assert.equal(productVatBps({ vatRate: '' }, 2400), 2400);
    assert.equal(productVatBps({ vatRate: 'lots' }, 2400), 2400);
    assert.equal(productVatBps({ vatRate: -5 }, 2400), 2400);
    assert.equal(productVatBps({ vatRate: 150 }, 2400), 2400);
  });

  test('0% is a real rate, not "unset"', () => {
    assert.equal(productVatBps({ vatRate: 0 }, 2400), 0);
  });

  test('a gift card product is never taxed when sold', () => {
    assert.equal(productVatBps({ productType: 'giftcard', vatRate: 24 }, 2400), 0);
  });
});

describe('orderPaymentLines', () => {
  const items = [
    { name: 'Olive oil', sku: 'OIL', type: 'physical' as const, unitPrice: 1200, quantity: 2, lineTotal: 2400, vatRate: 1300 },
    { name: 'Mug', sku: null, type: 'physical' as const, unitPrice: 1600, quantity: 1, lineTotal: 1600, vatRate: 2400 },
  ];
  const full = {
    items,
    discount: 400,
    shipping: 350,
    surcharge: 120,
    giftWrap: 200,
    giftCards: 1000,
    defaultVatBps: 2400,
    labels,
  };
  const amountDue = 2400 + 1600 - 400 + 350 + 120 + 200 - 1000;
  const lines = orderPaymentLines(full);

  test('adds up to exactly what is charged', () => {
    assert.equal(sum(lines), amountDue);
  });

  test('each product is a line with its own rate and SKU', () => {
    assert.deepEqual(lines[0], {
      type: 'physical',
      name: 'Olive oil',
      reference: 'OIL',
      quantity: 2,
      unitPrice: 1200,
      totalAmount: 2400,
      vatRate: 1300,
    });
    assert.equal(lines[1].vatRate, 2400);
    assert.equal('reference' in lines[1], false);
  });

  test('the discount is split across the rates in proportion, summing exactly', () => {
    const discounts = lines.filter((l) => l.type === 'discount');
    assert.deepEqual(
      discounts.map((l) => [l.vatRate, l.totalAmount]),
      [
        [1300, -240], // 400 × 2400/4000
        [2400, -160], // 400 × 1600/4000
      ],
    );
  });

  test('an awkward discount still sums exactly — the remainder lands on one line', () => {
    const odd = orderPaymentLines({ ...full, discount: 333 });
    const discounts = odd.filter((l) => l.type === 'discount');
    assert.equal(sum(discounts), -333);
    assert.equal(sum(odd), amountDue + 400 - 333);
  });

  test('shipping, gift wrap and surcharge are at the default rate', () => {
    const byType = (t: string) => lines.find((l) => l.type === t);
    assert.deepEqual([byType('shipping_fee')?.totalAmount, byType('shipping_fee')?.vatRate], [350, 2400]);
    assert.deepEqual([byType('surcharge')?.totalAmount, byType('surcharge')?.vatRate], [120, 2400]);
    const wrap = lines.find((l) => l.name === labels.giftWrap);
    assert.deepEqual([wrap?.type, wrap?.totalAmount, wrap?.vatRate], ['physical', 200, 2400]);
  });

  test('gift cards spent are a 0% credit', () => {
    const credit = lines.find((l) => l.type === 'gift_card');
    assert.deepEqual([credit?.totalAmount, credit?.vatRate], [-1000, 0]);
  });

  test('nothing to add means no extra lines', () => {
    const bare = orderPaymentLines({ ...full, discount: 0, shipping: 0, surcharge: 0, giftWrap: 0, giftCards: 0 });
    assert.deepEqual(
      bare.map((l) => l.type),
      ['physical', 'physical'],
    );
  });

  test('a discount on 0%-only goods (gift cards) carries 0%', () => {
    const only = orderPaymentLines({
      ...full,
      items: [{ name: 'Gift card', sku: null, type: 'digital' as const, unitPrice: 5000, quantity: 1, lineTotal: 5000, vatRate: 0 }],
      discount: 500,
      shipping: 0,
      surcharge: 0,
      giftWrap: 0,
      giftCards: 0,
    });
    assert.deepEqual(
      only.filter((l) => l.type === 'discount').map((l) => [l.vatRate, l.totalAmount]),
      [[0, -500]],
    );
  });
});

describe('orderLineLabels', () => {
  test('Greek and English', () => {
    assert.equal(orderLineLabels('el').shipping, 'Μεταφορικά');
    assert.equal(orderLineLabels('en').shipping, 'Shipping');
    assert.equal(orderLineLabels('fr').shipping, 'Shipping');
  });
});

describe('wiring', () => {
  test('the shop has a VAT rate setting', () => {
    const def = MANAGED_SETTINGS.find((d) => d.key === ECOMMERCE_VAT_RATE_KEY);
    assert.ok(def);
    assert.equal(def.module, 'commerce');
  });

  test('a product can carry its own VAT rate', () => {
    assert.match(source('src/cms/modules/commerce/collection.ts'), /f\.number\('vatRate'/);
  });

  test('the order’s lines go to the gateway with the payment', () => {
    const fn = fnBody(source('src/cms/modules/commerce/orders.ts'), 'createOrder');
    assert.match(fn, /lines:\s*orderPaymentLines\(/);
  });

  test('cancelling an order closes its open payment sessions', () => {
    const fn = fnBody(source('src/cms/modules/commerce/orders.ts'), 'updateOrderStatus');
    assert.match(fn, /status === 'cancelled'[\s\S]*?closePaymentSessions\(/);
  });

  test('the cron route loads the gateways, so the stale-order job can close a Klarna session', () => {
    assert.match(source('src/app/api/cms/cron/[job]/route.ts'), /import '@\/cms\/core\/payments\/register'/);
  });
});
