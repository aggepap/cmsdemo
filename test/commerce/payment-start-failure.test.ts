/**
 * A gateway that refuses to start a payment.
 *
 * `createOrder` used to carry on regardless: the order was committed, a failed
 * payment row written, and the checkout received neither a redirect nor a
 * client secret — so it told the customer "order placed" for an order nothing
 * would ever charge, and the stale-order job cancelled it hours later. Klarna
 * makes this likelier (it refuses a session whose country, locale or amounts it
 * does not accept), so now the order is cancelled on the spot — gift card
 * balances go back, no stock was taken — and the customer gets an error with
 * their cart intact, free to try again or pick another method.
 *
 * The cancellation sends no email: the customer is looking at the error, and a
 * "your order was cancelled" mail for an order they never saw placed is noise.
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

const orders = source('src/cms/modules/commerce/orders.ts');

describe('createOrder when the gateway cannot start', () => {
  const fn = fnBody(orders, 'createOrder');

  test('a provider that throws is caught, not left as a 500 over a committed order', () => {
    assert.match(fn, /try\s*\{\s*init\s*=\s*await provider\.start\(/);
  });

  test('the failed attempt is still recorded on the order', () => {
    const failed = fn.indexOf("init.status === 'failed'");
    assert.ok(failed >= 0, 'a failed start is not checked');
    assert.ok(fn.indexOf('recordPayment(') < failed, 'the payment row is not written before deciding');
  });

  test('the order is cancelled through the normal path, quietly, and only if still pending', () => {
    assert.match(
      fn,
      /updateOrderStatus\(result\.id,\s*'cancelled',\s*\{\s*onlyFrom:\s*'pending',\s*notify:\s*false\s*\}\)/,
    );
  });

  test('the customer is told, so the checkout shows an error and keeps the cart', () => {
    const failed = fn.indexOf("init.status === 'failed'");
    assert.match(fn.slice(failed), /throw conflict\(/);
  });

  test('nothing after the payment start runs for a failed one — no stock, no newsletter', () => {
    const failed = fn.indexOf("init.status === 'failed'");
    assert.ok(failed < fn.indexOf('decrementStockForOrder('), 'stock is decremented before the failure check');
    assert.ok(failed < fn.indexOf('subscribeNewsletter('), 'the newsletter runs before the failure check');
  });

  test('only an online provider can fail this way — manual never refuses', () => {
    assert.match(fn, /isOnlineProvider\(provider\)\s*&&\s*init\.status === 'failed'/);
  });
});

describe('updateOrderStatus can stay quiet', () => {
  const fn = fnBody(orders, 'updateOrderStatus');

  test('takes a notify option', () => {
    assert.match(fn, /notify\?:\s*boolean/);
  });

  test('sends the status email unless told not to', () => {
    assert.match(fn, /if \(opts\.notify !== false\) await sendOrderStatusEmail\(id, status\)/);
  });
});
