/**
 * Meta Conversions API (REQ-5 §6).
 *
 * Purchase, Lead and CompleteRegistration (and what the admin opens) also go
 * from the server — with the same event id as the browser, so Meta counts one.
 * Customer data only hashed (SHA-256, normalised), and only with Marketing
 * consent; without it, no server event at all. Failures retry from a queue
 * and never block the order.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  CAPI_MAX_ATTEMPTS,
  META_CAPI_KEY,
  buildCapiEvent,
  capiRequestBody,
  capiTarget,
  consentFromCookie,
  hashed,
  nextAttemptAt,
  normalizeEmail,
  normalizePhone,
  queueOutcome,
  readMetaCapi,
  requestAnalyticsContext,
} from '@/cms/core/analytics/meta-capi';
import { checkStructuredSetting } from '@/cms/core/settings/structured';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('normalising and hashing', () => {
  test('email: trimmed, lowercased, then SHA-256', () => {
    assert.equal(normalizeEmail('  Maria@Example.COM '), 'maria@example.com');
    assert.equal(hashed(normalizeEmail('Maria@Example.COM')), sha('maria@example.com'));
  });

  test('phone: digits only with the country code, no leading zeros or +', () => {
    assert.equal(normalizePhone('+30 210 123 4567', '30'), '302101234567');
    assert.equal(normalizePhone('0030 6912345678', '30'), '306912345678');
    assert.equal(normalizePhone('6912345678', '30'), '306912345678');
    assert.equal(normalizePhone('(210) 123-4567', '30'), '302101234567');
    assert.equal(normalizePhone('', '30'), null);
    assert.equal(normalizePhone('12', '30'), null);
  });
});

describe('buildCapiEvent', () => {
  const event = buildCapiEvent({
    eventName: 'Purchase',
    eventId: 'ORD-2026-ABC',
    eventTime: new Date('2026-10-02T10:00:00Z'),
    sourceUrl: 'https://example.gr/checkout',
    user: { email: 'Maria@Example.com', phone: '6912345678', fbp: 'fb.1.123.456', fbc: 'fb.1.123.abc', ip: '203.0.113.9', userAgent: 'Mozilla/5.0' },
    customData: { value: 124, currency: 'EUR', content_ids: ['MUG-1'] },
    phoneCountryCode: '30',
  });

  test('the shape Meta expects, with the browser event id', () => {
    assert.equal(event.event_name, 'Purchase');
    assert.equal(event.event_id, 'ORD-2026-ABC');
    assert.equal(event.event_time, 1790935200);
    assert.equal(event.action_source, 'website');
    assert.equal(event.event_source_url, 'https://example.gr/checkout');
    assert.deepEqual(event.custom_data, { value: 124, currency: 'EUR', content_ids: ['MUG-1'] });
  });

  test('email and phone only as hashes; cookies, IP and user agent as they are', () => {
    assert.deepEqual(event.user_data, {
      em: [sha('maria@example.com')],
      ph: [sha('306912345678')],
      fbp: 'fb.1.123.456',
      fbc: 'fb.1.123.abc',
      client_ip_address: '203.0.113.9',
      client_user_agent: 'Mozilla/5.0',
    });
    assert.doesNotMatch(JSON.stringify(event), /maria|6912345678"/i);
  });

  test('missing customer fields are left out, not sent empty', () => {
    const bare = buildCapiEvent({
      eventName: 'Lead',
      eventId: 'x',
      eventTime: new Date(0),
      sourceUrl: '',
      user: {},
      customData: {},
      phoneCountryCode: '30',
    });
    assert.deepEqual(bare.user_data, {});
  });
});

describe('capiTarget', () => {
  const ready = { token: 'EAAB', pixelId: '123456789012345', consent: true, settings: { events: ['Purchase', 'Lead'] } };

  test('needs the token, the Pixel, Marketing consent and the event switched on', () => {
    assert.ok(capiTarget('Purchase', ready));
    assert.equal(capiTarget('Purchase', { ...ready, consent: false }), null);
    assert.equal(capiTarget('Purchase', { ...ready, token: null }), null);
    assert.equal(capiTarget('Purchase', { ...ready, pixelId: null }), null);
    assert.equal(capiTarget('CompleteRegistration', ready), null);
  });

  test('says where to post', () => {
    assert.equal(capiTarget('Purchase', ready)?.url, 'https://graph.facebook.com/v21.0/123456789012345/events');
  });
});

describe('capiRequestBody', () => {
  test('the access token goes in the body, and the test code when set', () => {
    const body = capiRequestBody([{ event_name: 'Lead' }], 'EAAB', 'TEST123');
    assert.deepEqual(body, { data: [{ event_name: 'Lead' }], access_token: 'EAAB', test_event_code: 'TEST123' });
    assert.equal('test_event_code' in capiRequestBody([], 'EAAB', undefined), false);
  });
});

describe('consentFromCookie', () => {
  test('reads the banner mirror cookie', () => {
    assert.deepEqual(consentFromCookie('analytics,marketing'), { analytics: true, marketing: true });
    assert.deepEqual(consentFromCookie('analytics'), { analytics: true, marketing: false });
    assert.deepEqual(consentFromCookie(''), { analytics: false, marketing: false });
    assert.deepEqual(consentFromCookie(undefined), { analytics: false, marketing: false });
    assert.deepEqual(consentFromCookie('marketingx,analytic'), { analytics: false, marketing: false });
  });
});

describe('the retry queue', () => {
  const now = new Date('2026-10-02T10:00:00Z');

  test('backs off: 1 min, 5 min, 30 min, 2 h, 12 h', () => {
    const minutes = [1, 2, 3, 4, 5].map((a) => (nextAttemptAt(a, now).getTime() - now.getTime()) / 60_000);
    assert.deepEqual(minutes, [1, 5, 30, 120, 720]);
  });

  test('a success is sent; a failure retries until the last attempt, then fails for good', () => {
    assert.deepEqual(queueOutcome({ ok: true }, 0, now), { status: 'sent', attempts: 1, sentAt: now, lastError: null });
    const retry = queueOutcome({ ok: false, error: 'HTTP 500' }, 0, now);
    assert.equal(retry.status, 'pending');
    assert.equal(retry.attempts, 1);
    const last = queueOutcome({ ok: false, error: 'HTTP 500' }, CAPI_MAX_ATTEMPTS - 1, now);
    assert.equal(last.status, 'failed');
  });
});

describe('the marketing.metaCapi setting', () => {
  test('defaults to Purchase, Lead and CompleteRegistration', () => {
    assert.deepEqual(readMetaCapi(null).events, ['Purchase', 'Lead', 'CompleteRegistration']);
  });

  test('accepts Meta standard events and a test code; refuses anything else', () => {
    assert.equal(checkStructuredSetting(META_CAPI_KEY, { events: ['Purchase', 'AddToCart'], testEventCode: 'TEST12345' })?.ok, true);
    assert.equal(checkStructuredSetting(META_CAPI_KEY, { events: ['DropTables'] })?.ok, false);
    assert.equal(checkStructuredSetting(META_CAPI_KEY, { events: [], testEventCode: 'a b' })?.ok, false);
  });
});

describe('requestAnalyticsContext', () => {
  const headers = (cookie: string, extra: Record<string, string> = {}) =>
    new Headers({ cookie, 'x-real-ip': '203.0.113.9', 'user-agent': 'UA/1', referer: 'https://example.gr/contact?t=secret', ...extra });

  test('with Marketing consent: the Meta cookies, IP, UA and the page — scrubbed', () => {
    const ctx = requestAnalyticsContext(headers('cms_consent=analytics%2Cmarketing; _fbp=fb.1.1.2; _fbc=fb.1.1.abc; _ga=GA1.1.123456789.1690000000', { 'x-cms-event-id': 'b7e0c6f2-1d2a-4c55-9b1f-0d3e9f0a1b2c' }));
    assert.deepEqual(ctx, {
      marketing: true,
      analytics: true,
      fbp: 'fb.1.1.2',
      fbc: 'fb.1.1.abc',
      ip: '203.0.113.9',
      userAgent: 'UA/1',
      sourceUrl: 'https://example.gr/contact?t=redacted',
      gaClientId: '123456789.1690000000',
      eventId: 'b7e0c6f2-1d2a-4c55-9b1f-0d3e9f0a1b2c',
    });
  });

  test('without consent nothing personal is kept', () => {
    const ctx = requestAnalyticsContext(headers('_fbp=fb.1.1.2; _ga=GA1.1.1.2'));
    assert.deepEqual(ctx, { marketing: false, analytics: false, fbp: null, fbc: null, ip: null, userAgent: null, sourceUrl: null, gaClientId: null, eventId: null });
  });

  test('a malformed event id is ignored', () => {
    assert.equal(requestAnalyticsContext(headers('cms_consent=marketing', { 'x-cms-event-id': '<script>' })).eventId, null);
  });
});
