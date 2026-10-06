/**
 * Server-side Purchase (Meta Conversions API) and refund (GA4 Measurement
 * Protocol) for orders (REQ-5 §3, §6): built from what the order stored —
 * including the consent the shopper gave at checkout, which a payment webhook
 * arriving later has no other way to know.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ga4MeasurementProtocolRequest, ga4RefundEvent } from '@/cms/core/analytics/ga4-mp';
import { storedAnalyticsContext, toStoredAnalyticsContext } from '@/cms/core/analytics/meta-capi';
import { orderPurchaseCustomData } from '@/cms/modules/commerce/analytics';

describe('the consent context stored with an order', () => {
  const ctx = {
    analytics: true,
    marketing: true,
    fbp: 'fb.1.1.2',
    fbc: null,
    ip: '203.0.113.9',
    userAgent: 'UA/1',
    sourceUrl: 'https://example.gr/checkout',
    eventId: null,
    gaClientId: '123.456',
  };

  test('round-trips through the order metadata', () => {
    assert.deepEqual(storedAnalyticsContext(toStoredAnalyticsContext(ctx)), { ...ctx, eventId: null });
  });

  test('nothing is stored for a visitor who consented to nothing', () => {
    assert.equal(toStoredAnalyticsContext({ ...ctx, analytics: false, marketing: false }), null);
  });

  test('anything malformed reads as no consent', () => {
    assert.equal(storedAnalyticsContext({ marketing: 'yes' })?.marketing ?? false, false);
    assert.equal(storedAnalyticsContext(null), null);
  });
});

describe('orderPurchaseCustomData', () => {
  test('value, currency and the Meta content fields from the order lines', () => {
    assert.deepEqual(
      orderPurchaseCustomData({
        reference: 'ORD-1',
        total: 12400,
        currency: 'EUR',
        lines: [
          { sku: 'MUG-1', productId: 7, quantity: 2 },
          { sku: null, productId: 9, quantity: 1 },
        ],
      }),
      {
        value: 124,
        currency: 'EUR',
        order_id: 'ORD-1',
        content_type: 'product',
        content_ids: ['MUG-1', '9'],
        contents: [
          { id: 'MUG-1', quantity: 2 },
          { id: '9', quantity: 1 },
        ],
        num_items: 3,
      },
    );
  });
});

describe('GA4 Measurement Protocol', () => {
  test('refund: transaction id, value, currency', () => {
    assert.deepEqual(ga4RefundEvent({ transactionId: 'ORD-1', value: 1250, currency: 'EUR' }), {
      name: 'refund',
      params: { transaction_id: 'ORD-1', value: 12.5, currency: 'EUR' },
    });
  });

  test('the request: measurement id and secret in the query, client id in the body', () => {
    const req = ga4MeasurementProtocolRequest({
      measurementId: 'G-ABC123',
      apiSecret: 's3cr3t',
      clientId: '123.456',
      events: [{ name: 'refund', params: {} }],
    });
    const url = new URL(req.url);
    assert.equal(url.origin + url.pathname, 'https://www.google-analytics.com/mp/collect');
    assert.equal(url.searchParams.get('measurement_id'), 'G-ABC123');
    assert.equal(url.searchParams.get('api_secret'), 's3cr3t');
    assert.deepEqual(JSON.parse(req.body), { client_id: '123.456', events: [{ name: 'refund', params: {} }] });
  });
});
