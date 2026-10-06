/**
 * The shop's checkout with several payment methods switched on.
 *
 * The customer's choice decides everything the single configured provider used
 * to: which gateway starts the payment, which payment surcharge applies, and
 * whether a shipping method that forbids cash on delivery is on offer. The
 * shipping quote must use the same choice as the order, or the total the
 * customer is shown is not the total they are charged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

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

describe('resolving the customer’s method', () => {
  const payments = source('src/cms/modules/commerce/payments.ts');

  test('checks the request against the methods the admin enabled', () => {
    const fn = fnBody(payments, 'resolveCheckoutProvider');
    assert.match(fn, /getEnabledPaymentProviderKeys\(/);
    assert.match(fn, /choosePaymentProvider\(/);
    // A refused choice is the customer's error, not a server fault.
    assert.match(fn, /badRequest\(/);
  });

  test('the enabled list is read from the shop setting, through the shared parser', () => {
    const fn = fnBody(payments, 'getEnabledPaymentProviderKeys');
    assert.match(fn, /ECOMMERCE_PAYMENT_PROVIDER_KEY/);
    assert.match(fn, /enabledPaymentProviderKeys\(/);
  });

  test('the single "configured provider" reader is gone', () => {
    assert.doesNotMatch(payments, /getConfiguredPaymentProvider/);
    assert.doesNotMatch(source('src/cms/modules/commerce/orders.ts'), /getConfiguredPaymentProvider/);
    assert.doesNotMatch(source('src/cms/modules/commerce/shipping.ts'), /getConfiguredPaymentProvider/);
  });
});

describe('placing an order', () => {
  const orders = source('src/cms/modules/commerce/orders.ts');

  test('the checkout body accepts a payment method', () => {
    assert.match(orders, /paymentMethod:\s*z\.string\(\)\.trim\(\)\.max\(32\)\.optional\(\)/);
  });

  test('the order is paid through the method the customer chose', () => {
    const fn = fnBody(orders, 'createOrder');
    assert.match(fn, /resolveCheckoutProvider\(input\.paymentMethod\)/);
  });
});

describe('the shipping quote', () => {
  const shipping = source('src/cms/modules/commerce/shipping.ts');

  test('takes the chosen method, so the surcharge shown is the one charged', () => {
    assert.match(shipping, /paymentMethod:\s*z\.string\(\)\.trim\(\)\.max\(32\)\.optional\(\)/);
    assert.match(fnBody(shipping, 'quoteShipping'), /quoteProvider\(paymentMethod\)/);
  });

  test('offers cash-on-delivery methods according to the chosen method', () => {
    const fn = fnBody(shipping, 'createShippingQuoteRoute');
    assert.match(fn, /quoteProvider\(input\.paymentMethod\)/);
  });
});

describe('the checkout page', () => {
  const page = source('src/app/[locale]/checkout/page.tsx');
  const client = source('src/app/[locale]/checkout/CheckoutClient.tsx');

  test('hands the enabled methods to the client', () => {
    assert.match(page, /getEnabledPaymentProviderKeys\(\)/);
    assert.match(page, /paymentMethods=\{/);
  });

  test('shows the picker, and sends the choice with the order and the quote', () => {
    assert.match(client, /<PaymentMethodPicker/);
    // Once in the order body, once in the quote body.
    assert.ok((client.match(/paymentMethod,/g) ?? []).length >= 2, 'paymentMethod is not sent with both requests');
  });

  test('the delivery options are re-quoted for the chosen method', () => {
    assert.match(client, /<ShippingMethodPicker[\s\S]*?paymentMethod=\{paymentMethod\}/);
    assert.match(source('src/components/checkout/ShippingMethodPicker.tsx'), /paymentMethod/);
  });
});
