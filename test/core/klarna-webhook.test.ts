/**
 * Klarna's status callback and the customer's return from Klarna.
 *
 * Klarna does not sign its HPP status callback. Anyone who learns the URL can
 * post to it, so — as with Viva — the body only ever names a session to go and
 * READ. The session and the Klarna order are fetched with our credentials, and
 * `klarnaOutcome` decides. Klarna retries a callback only three times, so the
 * success redirect goes through a return route that runs the same
 * reconciliation before sending the customer on.
 *
 * These are wiring assertions on source, the same style the other webhook tests
 * use: the routes need a database and a network, and what matters here is which
 * calls are made, and in what order.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { parseKlarnaCallback } from '@/cms/core/payments/klarna';

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

describe('parseKlarnaCallback', () => {
  test('reads the session id from the body Klarna posts', () => {
    const raw = JSON.stringify({ event_id: 'e1', session: { session_id: 'abc-123', status: 'COMPLETED' } });
    assert.equal(parseKlarnaCallback(raw, null), 'abc-123');
  });

  test('falls back on the id in our own callback URL', () => {
    assert.equal(parseKlarnaCallback('', 'abc-123'), 'abc-123');
  });

  test('the body and the URL must agree when both are present', () => {
    const raw = JSON.stringify({ session: { session_id: 'abc-123' } });
    assert.equal(parseKlarnaCallback(raw, 'other-999'), null);
  });

  test('refuses anything that is not a plausible session id', () => {
    assert.equal(parseKlarnaCallback(JSON.stringify({ session: { session_id: '../../x' } }), null), null);
    assert.equal(parseKlarnaCallback(JSON.stringify({ session: { session_id: 'a'.repeat(200) } }), null), null);
    assert.equal(parseKlarnaCallback('not json', null), null);
    assert.equal(parseKlarnaCallback('', null), null);
  });
});

describe('reconcileKlarnaSession', () => {
  const webhooks = source('src/cms/core/payments/webhooks.ts');
  const fn = fnBody(webhooks, 'reconcileKlarnaSession');

  test('looks for our own payment row BEFORE calling Klarna', () => {
    // A made-up session id must cost a database lookup, not a Klarna API call.
    const lookup = fn.search(/expectedPaymentFor\(\s*KLARNA_PROVIDER_KEY/);
    const read = fn.indexOf('readKlarnaSession(');
    assert.ok(lookup >= 0, 'the payment row is not looked up');
    assert.ok(read > lookup, 'Klarna is called before the row is found');
  });

  test('re-reads the session AND the Klarna order, and lets klarnaOutcome decide', () => {
    assert.match(fn, /readKlarnaSession\(/);
    assert.match(fn, /readKlarnaOrder\(/);
    assert.match(fn, /klarnaOutcome\(/);
  });

  test('records the Klarna order id, which is what a refund is issued against', () => {
    assert.match(fn, /klarnaOrderId/);
    assert.match(fn, /applyOutcome\(/);
  });
});

describe('the Klarna callback route', () => {
  const webhooks = source('src/cms/core/payments/webhooks.ts');
  const fn = fnBody(webhooks, 'klarnaWebhookRoute');

  test('is a server-to-server endpoint, rate limited', () => {
    assert.match(fn, /sameOrigin:\s*false/);
    assert.match(fn, /rateLimit:/);
  });

  test('never trusts the body — it only reads the session id from it', () => {
    assert.match(fn, /parseKlarnaCallback\(/);
    assert.match(fn, /reconcileKlarnaSession\(/);
    assert.doesNotMatch(fn, /captured_amount|order_amount/);
  });

  test('answers 500 when Klarna cannot be reached, so Klarna retries', () => {
    assert.match(fn, /status:\s*500/);
  });

  test('the route file is gated on the shop OR bookings, and registers the gateways', () => {
    const path = 'src/app/api/cms/payments/webhooks/klarna/route.ts';
    assert.ok(existsSync(new URL(`../../${path}`, import.meta.url)), `${path} is missing`);
    const route = source(path);
    assert.match(route, /import '@\/cms\/core\/payments\/register'/);
    assert.match(route, /isModuleEnabled\(config, 'commerce'\)/);
    assert.match(route, /isModuleEnabled\(config, 'booking'\)/);
    assert.match(route, /export async function POST/);
  });
});

describe('the Klarna return route', () => {
  const webhooks = source('src/cms/core/payments/webhooks.ts');
  const fn = fnBody(webhooks, 'klarnaReturnRoute');

  test('reconciles before redirecting, so a lost callback does not lose the payment', () => {
    const reconcile = fn.indexOf('reconcileKlarnaSession(');
    const redirect = fn.search(/status:\s*303/);
    assert.ok(reconcile >= 0, 'the return does not reconcile');
    assert.ok(redirect > reconcile, 'the redirect happens before reconciling');
  });

  test('redirects only to the return URL stored at start, checked by klarnaReturnTarget', () => {
    assert.match(fn, /klarnaReturnTarget\(/);
  });

  test('the route file answers GET and is gated on both modules', () => {
    const path = 'src/app/api/cms/payments/webhooks/klarna/return/route.ts';
    assert.ok(existsSync(new URL(`../../${path}`, import.meta.url)), `${path} is missing`);
    const route = source(path);
    assert.match(route, /import '@\/cms\/core\/payments\/register'/);
    assert.match(route, /isModuleEnabled\(config, 'commerce'\)/);
    assert.match(route, /isModuleEnabled\(config, 'booking'\)/);
    assert.match(route, /export async function GET/);
  });
});

describe('what start() hands back is stored on the payment row', () => {
  test('orders keep the provider metadata', () => {
    const fn = fnBody(source('src/cms/modules/commerce/orders.ts'), 'createOrder');
    assert.match(fn, /metadata:\s*init\.metadata/);
  });

  test('reservations keep the provider metadata', () => {
    const fn = fnBody(source('src/cms/modules/booking/payments.ts'), 'bookingPayStartRoute');
    assert.match(fn, /metadata:\s*result\.metadata/);
  });
});
