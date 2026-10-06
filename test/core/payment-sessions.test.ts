/**
 * Closing a payment session when what it pays for is gone.
 *
 * An unpaid order is cancelled (by the stale-order job, an admin, or a failed
 * start) and a reservation is cancelled or expires — but a Klarna hosted page
 * lives for about 47 hours, so the customer could still pay into it. The money
 * would land on a closed order, be flagged for a refund, and need someone to
 * send it back. Now any still-pending session is closed at the gateway when its
 * order or reservation closes.
 *
 * Best effort by design: the cancellation has already happened and must not be
 * undone because a gateway was unreachable. A capture that still slips through
 * is caught by the existing late-capture flag.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { registerPaymentProvider, type PaymentProvider } from '@/cms/core/payments';
import { klarnaProvider } from '@/cms/core/payments/klarna';
import { closePaymentSessions } from '@/cms/core/payments/sessions';

const cancelled: string[] = [];
const closable: PaymentProvider = {
  key: 'test-closable',
  label: 'Closable',
  async start() {
    return { status: 'pending' };
  },
  async cancel(ref) {
    if (ref === 'boom') throw new Error('gateway down');
    cancelled.push(ref);
  },
};
const notClosable: PaymentProvider = {
  key: 'test-not-closable',
  label: 'Not closable',
  async start() {
    return { status: 'pending' };
  },
};
registerPaymentProvider(closable);
registerPaymentProvider(notClosable);

describe('closePaymentSessions', () => {
  beforeEach(() => {
    cancelled.length = 0;
  });

  test('closes every pending session whose provider can close one', async () => {
    await closePaymentSessions([
      { provider: 'test-closable', providerRef: 's1', status: 'pending' },
      { provider: 'test-closable', providerRef: 's2', status: 'pending' },
    ]);
    assert.deepEqual(cancelled, ['s1', 's2']);
  });

  test('leaves captured, failed and refunded payments alone', async () => {
    await closePaymentSessions([
      { provider: 'test-closable', providerRef: 'c', status: 'captured' },
      { provider: 'test-closable', providerRef: 'f', status: 'failed' },
      { provider: 'test-closable', providerRef: 'r', status: 'refunded' },
    ]);
    assert.deepEqual(cancelled, []);
  });

  test('skips rows with no reference and providers with nothing to close', async () => {
    await closePaymentSessions([
      { provider: 'test-closable', providerRef: null, status: 'pending' },
      { provider: 'test-not-closable', providerRef: 'x', status: 'pending' },
      { provider: 'manual', providerRef: 'y', status: 'pending' },
    ]);
    assert.deepEqual(cancelled, []);
  });

  test('one gateway failure neither throws nor stops the others', async () => {
    await closePaymentSessions([
      { provider: 'test-closable', providerRef: 'boom', status: 'pending' },
      { provider: 'test-closable', providerRef: 'after', status: 'pending' },
    ]);
    assert.deepEqual(cancelled, ['after']);
  });
});

describe('Klarna closes its hosted page', () => {
  const realFetch = globalThis.fetch;
  const saved = { u: process.env.KLARNA_USERNAME, p: process.env.KLARNA_PASSWORD, e: process.env.KLARNA_ENV };
  let calls: { url: string; method: string }[] = [];

  beforeEach(() => {
    process.env.KLARNA_USERNAME = 'u';
    process.env.KLARNA_PASSWORD = 'p';
    delete process.env.KLARNA_ENV;
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of [
      ['KLARNA_USERNAME', saved.u],
      ['KLARNA_PASSWORD', saved.p],
      ['KLARNA_ENV', saved.e],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const respond = (status: number) => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(null, { status });
    }) as typeof fetch;
  };

  test('by disabling the HPP session', async () => {
    respond(204);
    await klarnaProvider.cancel!('hpp-1');
    assert.deepEqual(calls, [{ url: 'https://api.playground.klarna.com/hpp/v1/sessions/hpp-1', method: 'DELETE' }]);
  });

  test('a session Klarna no longer has is already closed', async () => {
    respond(404);
    await klarnaProvider.cancel!('hpp-gone');
  });

  test('any other refusal is an error for the caller to log', async () => {
    respond(500);
    await assert.rejects(klarnaProvider.cancel!('hpp-1'), /500/);
  });
});

describe('Klarna calls are time-limited', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('every request carries an abort signal, so a hung Klarna cannot stall a cancellation', async () => {
    process.env.KLARNA_USERNAME = 'u';
    process.env.KLARNA_PASSWORD = 'p';
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await klarnaProvider.cancel!('hpp-1');
    assert.ok(signal instanceof AbortSignal, 'no timeout signal on the Klarna request');
  });
});
