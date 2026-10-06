/**
 * Bank transfer vs cash on delivery at checkout, in the email and on the
 * thank-you page.
 *
 * Only `cod` is collected by the courier: it alone narrows the shipping methods
 * to COD-capable ones, records `codAmount` for the voucher and carries the COD
 * surcharge. A bank transfer order stays `pending` until an admin marks it paid
 * — and the customer is told how to pay it (bank, IBAN, beneficiary), in their
 * language, in the confirmation email and on the page they land on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { OFFLINE_PROVIDER_KEYS } from '@/cms/core/payments';
import {
  bankTransferInstructionsHtml,
  orderPaymentInstructions,
  owesBankTransfer,
  pickBankTransferInstructions,
} from '@/cms/modules/commerce/bank-transfer';
import { paymentSurchargeCents } from '@/cms/modules/commerce/shipping';
import {
  codAmountFor,
  quoteMethods,
  type ShippingMethodRow,
  type ShippingZoneRow,
} from '@/cms/modules/commerce/shipping-methods';
import {
  OFFLINE_ORDER_PROVIDERS,
  planStaleOrderCancellations,
} from '@/cms/modules/commerce/stale-orders';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('surcharges are per method', () => {
  const entries = [
    { provider: 'cod', charge: 2 },
    { provider: 'stripe', charge: 0.5 },
  ];

  test('the COD fee is charged on cash on delivery and not on a bank transfer', () => {
    assert.equal(paymentSurchargeCents(entries, 'cod'), 200);
    assert.equal(paymentSurchargeCents(entries, 'bank_transfer'), 0);
  });

  test('a bank transfer fee, if the shop sets one, is its own', () => {
    assert.equal(
      paymentSurchargeCents(
        [...entries, { provider: 'bank_transfer', charge: 1 }],
        'bank_transfer'
      ),
      100
    );
  });

  test('a fee saved against legacy manual keeps applying to cash on delivery only', () => {
    // `manual` always meant cash on delivery to the shipping rules, so its fee was
    // a COD fee. A bank transfer starts free rather than inheriting it.
    const legacy = [{ provider: 'manual', charge: 1.5 }];
    assert.equal(paymentSurchargeCents(legacy, 'cod'), 150);
    assert.equal(paymentSurchargeCents(legacy, 'bank_transfer'), 0);
    assert.equal(paymentSurchargeCents(legacy, 'manual'), 150);
    assert.equal(paymentSurchargeCents([...legacy, { provider: 'cod', charge: 3 }], 'cod'), 300);
  });
});

describe('cash on delivery only for cod', () => {
  test('a bank transfer order gives the courier nothing to collect', () => {
    assert.equal(
      codAmountFor({ online: false, cashOnDelivery: false, delivered: true, amountDue: 4250 }),
      undefined
    );
    assert.equal(
      codAmountFor({ online: false, cashOnDelivery: true, delivered: true, amountDue: 4250 }),
      4250
    );
  });

  const zone: ShippingZoneRow = {
    id: 1,
    name: 'Greece',
    countries: ['GR'],
    sort: 0,
  } as ShippingZoneRow;
  const method = {
    id: 1,
    zoneId: 1,
    name: 'ACS',
    courier: 'acs',
    kind: 'home',
    cost: 350,
    freeThreshold: null,
    weightTiers: [],
    etaMinDays: null,
    etaMaxDays: null,
    codAllowed: false,
    active: true,
    sort: 0,
    pickupLocationId: null,
  } as unknown as ShippingMethodRow;

  test('a courier that refuses COD is still offered to a bank transfer', () => {
    const out = quoteMethods([method], [zone], {
      country: 'GR',
      subtotalCents: 1000,
      totalWeight: 0,
      paymentProvider: 'bank_transfer',
      codSelected: false,
    });
    assert.equal(out.length, 1);
  });
});

describe('bank transfer orders wait for the admin', () => {
  test('the stale-order job never cancels an offline order of either kind', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    const old = new Date(now.getTime() - 100 * 3_600_000);
    const orders = ['bank_transfer', 'cod', 'manual'].map((provider, i) => ({
      id: i + 1,
      status: 'pending' as const,
      createdAt: old,
      payments: [{ provider, status: 'pending' as const }],
    }));
    assert.deepEqual(planStaleOrderCancellations(orders, { now, ttlHours: 48 }), []);
  });

  test("the job's offline list is the registry's", () => {
    assert.deepEqual([...OFFLINE_ORDER_PROVIDERS].sort(), [...OFFLINE_PROVIDER_KEYS].sort());
  });
});

describe('the instructions text', () => {
  const values = { el: 'Τράπεζα Πειραιώς\nIBAN GR00 0000', en: 'Piraeus Bank\nIBAN GR00 0000' };

  test("the customer's language is used", () => {
    assert.equal(pickBankTransferInstructions(values, 'el'), values.el);
    assert.equal(pickBankTransferInstructions(values, 'en'), values.en);
  });

  test('a language left empty falls back to the other, rather than showing nothing', () => {
    assert.equal(pickBankTransferInstructions({ el: '  ', en: values.en }, 'el'), values.en);
    assert.equal(pickBankTransferInstructions({ el: values.el }, 'en'), values.el);
    assert.equal(pickBankTransferInstructions({ el: values.el, en: values.en }, 'de'), values.el);
  });

  test('nothing set is empty', () => {
    assert.equal(pickBankTransferInstructions({}, 'el'), '');
    assert.equal(pickBankTransferInstructions({ el: ' \n ' }, 'el'), '');
  });

  test('only a bank transfer with money still owed gets them', () => {
    assert.equal(
      orderPaymentInstructions({ provider: 'bank_transfer', amountDue: 1000, text: 'IBAN' }),
      'IBAN'
    );
    assert.equal(
      orderPaymentInstructions({ provider: 'cod', amountDue: 1000, text: 'IBAN' }),
      null
    );
    assert.equal(
      orderPaymentInstructions({ provider: 'stripe', amountDue: 1000, text: 'IBAN' }),
      null
    );
    assert.equal(
      orderPaymentInstructions({ provider: 'manual', amountDue: 1000, text: 'IBAN' }),
      null
    );
    assert.equal(
      orderPaymentInstructions({ provider: 'bank_transfer', amountDue: 0, text: 'IBAN' }),
      null
    );
    assert.equal(
      orderPaymentInstructions({ provider: 'bank_transfer', amountDue: 1000, text: '   ' }),
      null
    );
  });

  test('an order owes a bank transfer while its bank_transfer payment is pending', () => {
    assert.equal(owesBankTransfer([{ provider: 'bank_transfer', status: 'pending' }]), true);
    assert.equal(owesBankTransfer([{ provider: 'bank_transfer', status: 'captured' }]), false);
    assert.equal(owesBankTransfer([{ provider: 'cod', status: 'pending' }]), false);
    assert.equal(owesBankTransfer([{ provider: 'giftcard', status: 'captured' }]), false);
  });
});

describe('the email block', () => {
  test('is escaped, keeps line breaks, and carries a localised heading', () => {
    const html = bankTransferInstructionsHtml('Bank <b>&</b> "Co"\r\nIBAN GR12', 'en');
    assert.match(html, /How to pay by bank transfer/);
    assert.match(html, /Bank &lt;b&gt;&amp;&lt;\/b&gt; &quot;Co&quot;<br>IBAN GR12/);
    assert.doesNotMatch(html, /<b>/);
    assert.match(bankTransferInstructionsHtml('IBAN', 'el'), /τραπεζική κατάθεση/i);
  });

  test('is nothing when there is nothing to say', () => {
    assert.equal(bankTransferInstructionsHtml('', 'en'), '');
    assert.equal(bankTransferInstructionsHtml('  \n', 'el'), '');
  });
});

describe('wiring', () => {
  const orders = read('src/cms/modules/commerce/orders.ts');
  const shipping = read('src/cms/modules/commerce/shipping.ts');
  const service = read('src/cms/modules/commerce/shipping-service.ts');

  test('checkout narrows couriers and records codAmount only for cash on delivery', () => {
    assert.match(orders, /codSelected: isCashOnDelivery\(provider\.key\)/);
    assert.match(orders, /cashOnDelivery: isCashOnDelivery\(provider\.key\)/);
    assert.doesNotMatch(orders, /codSelected: !isOnlineProvider/);
  });

  test('the shipping estimate applies the same rule', () => {
    assert.match(shipping, /codSelected: isCashOnDelivery\(provider\.key\)/);
    assert.doesNotMatch(shipping, /codSelected: !isOnlineProvider/);
  });

  test('both shipping engines price the surcharge through the one helper', () => {
    assert.doesNotMatch(shipping, /paymentSurcharges\.find/);
    assert.match(service, /paymentSurchargeCents\(/);
  });

  test('the customer email carries the instructions for an unpaid bank transfer', () => {
    const fn = orders.slice(orders.indexOf('export async function sendOrderEmails'));
    assert.match(fn, /owesBankTransfer\(order\.payments\)/);
    assert.match(fn, /bankTransferInstructionsHtml\(/);
  });

  test('checkout returns the instructions to the thank-you page', () => {
    assert.match(orders, /paymentInstructions: order\.paymentInstructions/);
    assert.match(orders, /orderPaymentInstructions\(\{/);
  });

  test('the shop setting is read with the legacy manual migration', () => {
    const payments = read('src/cms/modules/commerce/payments.ts');
    assert.match(payments, /ECOMMERCE_PAYMENT_PROVIDER_KEYS,\s*SHOP_PAYMENT_PROVIDER_RULES/);
  });
});
