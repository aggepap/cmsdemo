/**
 * Klarna, integrated on its own API — never through Stripe.
 *
 * Greek sites cannot rely on Stripe (no IRIS), so Klarna has to work next to
 * whatever else a site uses: Viva, PayPal or bank transfer. The flow is Klarna
 * Payments + the Hosted Payment Page, with `CAPTURE_ORDER`: the customer is
 * redirected to Klarna, and Klarna places and captures the order itself.
 *
 * The status callback Klarna sends is NOT signed. Like Viva's webhook, it is
 * treated as "go and look at session X": the session and the Klarna order are
 * re-read with our credentials, and a capture is only believed when Klarna says
 * CAPTURED for the amount and currency this site charged. `klarnaOutcome` is
 * that decision.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { canRefundOnline, getPaymentProvider, isOnlineProvider, paymentProviderKeys } from '@/cms/core/payments';
import {
  buildKlarnaHppSession,
  buildKlarnaPaymentSession,
  KLARNA_PROVIDER_KEY,
  klarnaApiBase,
  klarnaLocale,
  klarnaOutcome,
  klarnaProvider,
  klarnaReturnTarget,
} from '@/cms/core/payments/klarna';
import { refundTargetRef } from '@/cms/core/payments/refunds';

const ENV_KEYS = ['KLARNA_USERNAME', 'KLARNA_PASSWORD', 'KLARNA_ENV', 'KLARNA_PURCHASE_COUNTRY', 'NEXT_PUBLIC_SITE_URL'];
let savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.KLARNA_USERNAME = 'user-uuid';
  process.env.KLARNA_PASSWORD = 'klarna_test_api_secret';
  delete process.env.KLARNA_ENV;
  delete process.env.KLARNA_PURCHASE_COUNTRY;
  process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Replace `fetch` with a script of canned answers, recording every call. */
function stubFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses[i++];
    if (!next) throw new Error(`unexpected fetch #${i}: ${String(input)}`);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return calls;
}

const ctx = {
  subject: 'order' as const,
  subjectId: 42,
  reference: 'ORD-2026-ABCDEFGHJK',
  amount: 12_345,
  currency: 'EUR',
  email: 'buyer@example.com',
  locale: 'el',
  returnUrl: 'https://shop.example/order?ref=ORD-2026-ABCDEFGHJK',
};

describe('the Klarna provider in the registry', () => {
  test('is registered, online, and refundable', async () => {
    await import('@/cms/core/payments/register');
    assert.ok(paymentProviderKeys().includes(KLARNA_PROVIDER_KEY));
    const provider = getPaymentProvider('klarna');
    assert.equal(provider.key, 'klarna');
    assert.equal(isOnlineProvider(provider), true);
    assert.equal(canRefundOnline(provider), true);
  });
});

describe('environment', () => {
  test('stays on the playground unless KLARNA_ENV is exactly live', () => {
    assert.equal(klarnaApiBase(), 'https://api.playground.klarna.com');
    process.env.KLARNA_ENV = 'production';
    assert.equal(klarnaApiBase(), 'https://api.playground.klarna.com');
    process.env.KLARNA_ENV = 'live';
    assert.equal(klarnaApiBase(), 'https://api.klarna.com');
  });

  test('missing credentials fail when a payment starts, naming what is missing', async () => {
    delete process.env.KLARNA_PASSWORD;
    stubFetch([]);
    await assert.rejects(klarnaProvider.start(ctx), /KLARNA_PASSWORD/);
  });
});

describe('klarnaLocale', () => {
  test('Greek pages get el-GR, everything else en-GR', () => {
    assert.equal(klarnaLocale('el', 'GR'), 'el-GR');
    assert.equal(klarnaLocale('en', 'GR'), 'en-GR');
    assert.equal(klarnaLocale(undefined, 'GR'), 'en-GR');
  });

  test('follows the purchase country, which Klarna requires to align', () => {
    assert.equal(klarnaLocale('en', 'DE'), 'en-DE');
  });
});

describe('buildKlarnaPaymentSession', () => {
  test('is one line for the total, so the amounts always reconcile', () => {
    const body = buildKlarnaPaymentSession(ctx, { country: 'GR' });
    assert.equal(body.purchase_country, 'GR');
    assert.equal(body.purchase_currency, 'EUR');
    assert.equal(body.locale, 'el-GR');
    assert.equal(body.intent, 'buy');
    assert.equal(body.order_amount, 12_345);
    assert.equal(body.order_tax_amount, 0);
    assert.equal(body.merchant_reference1, 'ORD-2026-ABCDEFGHJK');
    assert.equal(body.order_lines.length, 1);
    const [line] = body.order_lines;
    assert.equal(line.quantity, 1);
    assert.equal(line.unit_price, 12_345);
    assert.equal(line.total_amount, 12_345);
    assert.equal(line.tax_rate, 0);
    assert.equal(line.total_tax_amount, 0);
    assert.match(line.name, /ORD-2026-ABCDEFGHJK/);
  });

  test('carries the subject for a human reading the Klarna portal', () => {
    const body = buildKlarnaPaymentSession({ ...ctx, subject: 'reservation', subjectId: 7 }, { country: 'GR' });
    assert.equal(body.merchant_reference2, 'reservation:7');
  });

  test('upper-cases the currency', () => {
    assert.equal(buildKlarnaPaymentSession({ ...ctx, currency: 'eur' }, { country: 'GR' }).purchase_currency, 'EUR');
  });
});

describe('buildKlarnaHppSession', () => {
  const body = buildKlarnaHppSession({
    paymentSessionId: 'kp-session-1',
    returnUrl: ctx.returnUrl,
    origin: 'https://shop.example',
  });

  test('points at the payment session on the same Klarna environment', () => {
    assert.equal(body.payment_session_url, 'https://api.playground.klarna.com/payments/v1/sessions/kp-session-1');
  });

  test('has Klarna place AND capture the order', () => {
    assert.equal(body.options.place_order_mode, 'CAPTURE_ORDER');
  });

  test('success comes back through our return route, with the session id left for Klarna to fill in', () => {
    assert.equal(
      body.merchant_urls.success,
      'https://shop.example/api/cms/payments/webhooks/klarna/return?sid={{session_id}}',
    );
  });

  test('status updates go to our callback route', () => {
    assert.equal(
      body.merchant_urls.status_update,
      'https://shop.example/api/cms/payments/webhooks/klarna?sid={{session_id}}',
    );
  });

  test('cancel, back and failure land the customer where they started', () => {
    assert.equal(body.merchant_urls.cancel, ctx.returnUrl);
    assert.equal(body.merchant_urls.back, ctx.returnUrl);
    assert.equal(body.merchant_urls.failure, ctx.returnUrl);
  });
});

describe('klarnaProvider.start', () => {
  test('opens a payment session, then a hosted page, and sends the customer there', async () => {
    const calls = stubFetch([
      { status: 200, body: { session_id: 'kp-1', client_token: 'jwt' } },
      {
        status: 201,
        body: { session_id: 'hpp-1', redirect_url: 'https://pay.playground.klarna.com/eu/hpp/payments/abc' },
      },
    ]);

    const result = await klarnaProvider.start(ctx);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://api.playground.klarna.com/payments/v1/sessions');
    assert.equal(calls[1].url, 'https://api.playground.klarna.com/hpp/v1/sessions');
    assert.equal(
      (calls[1].body as { payment_session_url: string }).payment_session_url,
      'https://api.playground.klarna.com/payments/v1/sessions/kp-1',
    );

    // HTTP Basic with the API username and password, on every call.
    const basic = `Basic ${Buffer.from('user-uuid:klarna_test_api_secret').toString('base64')}`;
    assert.equal(calls[0].headers.authorization, basic);
    assert.equal(calls[1].headers.authorization, basic);

    assert.equal(result.status, 'pending');
    // The HPP session is what both the callback and the return route name.
    assert.equal(result.providerRef, 'hpp-1');
    assert.equal(result.redirectUrl, 'https://pay.playground.klarna.com/eu/hpp/payments/abc');
    assert.equal(result.method, 'klarna');
    // Kept so the return route can send the customer on without trusting the URL.
    assert.deepEqual(result.metadata, { returnUrl: ctx.returnUrl });
  });

  test('a refusal from Klarna is a failed start, not a throw', async () => {
    stubFetch([{ status: 400, body: { error_code: 'BAD_VALUE', error_messages: ['purchase_country'] } }]);
    const result = await klarnaProvider.start(ctx);
    assert.equal(result.status, 'failed');
    assert.ok(result.error);
  });

  test('a hosted page with no redirect link is a failed start', async () => {
    stubFetch([
      { status: 200, body: { session_id: 'kp-1' } },
      { status: 201, body: { session_id: 'hpp-1' } },
    ]);
    const result = await klarnaProvider.start(ctx);
    assert.equal(result.status, 'failed');
  });

  test('uses the configured purchase country', async () => {
    process.env.KLARNA_PURCHASE_COUNTRY = 'de';
    const calls = stubFetch([
      { status: 200, body: { session_id: 'kp-1' } },
      { status: 201, body: { session_id: 'hpp-1', redirect_url: 'https://pay.klarna.com/x' } },
    ]);
    await klarnaProvider.start({ ...ctx, locale: 'en' });
    const body = calls[0].body as { purchase_country: string; locale: string };
    assert.equal(body.purchase_country, 'DE');
    assert.equal(body.locale, 'en-DE');
  });
});

describe('klarnaOutcome — what Klarna itself says, checked against what we charged', () => {
  const expected = { amount: 12_345, currency: 'EUR' };
  const completed = { status: 'COMPLETED', order_id: 'ko-1' };
  const captured = { status: 'CAPTURED', captured_amount: 12_345, purchase_currency: 'EUR' };

  test('completed and captured in full is a capture, keyed to the Klarna order', () => {
    assert.deepEqual(klarnaOutcome({ session: completed, order: captured, expected }), {
      status: 'captured',
      orderId: 'ko-1',
    });
  });

  test('a captured amount that differs is refused', () => {
    assert.equal(klarnaOutcome({ session: completed, order: { ...captured, captured_amount: 100 }, expected }), null);
  });

  test('a different currency is refused', () => {
    assert.equal(klarnaOutcome({ session: completed, order: { ...captured, purchase_currency: 'SEK' }, expected }), null);
  });

  test('an order that is only authorized is not money yet', () => {
    assert.equal(klarnaOutcome({ session: completed, order: { ...captured, status: 'AUTHORIZED' }, expected }), null);
  });

  test('a completed session without an order id cannot be matched', () => {
    assert.equal(klarnaOutcome({ session: { status: 'COMPLETED' }, order: captured, expected }), null);
  });

  test('cancelled and disabled sessions are final failures', () => {
    assert.deepEqual(klarnaOutcome({ session: { status: 'CANCELLED' }, expected }), { status: 'failed' });
    assert.deepEqual(klarnaOutcome({ session: { status: 'DISABLED' }, expected }), { status: 'failed' });
  });

  test('sessions the customer can still retry change nothing', () => {
    for (const status of ['WAITING', 'IN_PROGRESS', 'FAILED', 'BACK', 'ERROR', 'MANUAL_ID_CHECK']) {
      assert.equal(klarnaOutcome({ session: { status }, expected }), null, status);
    }
  });
});

describe('klarnaProvider.refund', () => {
  test('refunds the Klarna ORDER, in minor units, with an idempotency key', async () => {
    const calls = stubFetch([{ status: 201, headers: { 'Refund-Id': 'rf-1' } }]);
    const result = await klarnaProvider.refund!({ providerRef: 'ko-1', amount: 500, currency: 'EUR' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://api.playground.klarna.com/ordermanagement/v1/orders/ko-1/refunds');
    assert.deepEqual(calls[0].body, { refunded_amount: 500 });
    assert.ok(calls[0].headers['klarna-idempotency-key']);
    assert.deepEqual(result, { status: 'refunded', providerRef: 'rf-1' });
  });

  test('a full refund sends back what is left of the capture', async () => {
    const calls = stubFetch([
      { status: 200, body: { captured_amount: 12_345, refunded_amount: 345 } },
      { status: 201, headers: { 'Refund-Id': 'rf-2' } },
    ]);
    await klarnaProvider.refund!({ providerRef: 'ko-1', currency: 'EUR' });
    assert.equal(calls[0].url, 'https://api.playground.klarna.com/ordermanagement/v1/orders/ko-1');
    assert.deepEqual(calls[1].body, { refunded_amount: 12_000 });
  });

  test('a refusal is reported, not thrown', async () => {
    stubFetch([{ status: 403, body: { error_code: 'REFUND_NOT_ALLOWED' } }]);
    const result = await klarnaProvider.refund!({ providerRef: 'ko-1', amount: 500, currency: 'EUR' });
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /403/);
  });

  test('refunds are pointed at the Klarna order the capture recorded, never the session', () => {
    assert.equal(
      refundTargetRef({ provider: 'klarna', providerRef: 'hpp-1', metadata: { klarnaOrderId: 'ko-1' } }),
      'ko-1',
    );
    assert.equal(refundTargetRef({ provider: 'klarna', providerRef: 'hpp-1', metadata: {} }), null);
  });
});

describe('klarnaReturnTarget — where the return route sends the customer', () => {
  const origin = 'https://shop.example';

  test('the stored return URL, when it is on this site', () => {
    assert.equal(klarnaReturnTarget({ returnUrl: `${origin}/order?ref=X` }, origin), `${origin}/order?ref=X`);
  });

  test('anything off-site becomes the home page — never an open redirect', () => {
    assert.equal(klarnaReturnTarget({ returnUrl: 'https://evil.example/phish' }, origin), `${origin}/`);
    assert.equal(klarnaReturnTarget({ returnUrl: '//evil.example' }, origin), `${origin}/`);
    assert.equal(klarnaReturnTarget({ returnUrl: 'javascript:alert(1)' }, origin), `${origin}/`);
  });

  test('missing or malformed metadata becomes the home page', () => {
    assert.equal(klarnaReturnTarget(null, origin), `${origin}/`);
    assert.equal(klarnaReturnTarget({}, origin), `${origin}/`);
    assert.equal(klarnaReturnTarget({ returnUrl: 42 }, origin), `${origin}/`);
  });
});
