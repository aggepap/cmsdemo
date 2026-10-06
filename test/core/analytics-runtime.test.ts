/**
 * The browser runtime that sends catalogue events (REQ-5 §3).
 *
 * Driven against a minimal fake `window`, because the order of things is what
 * matters: an event fired by a page before the loader has set up consent must
 * wait and then go; `purchase` must go once even when the thank-you page is
 * reloaded; the entry page_view must not double what the tags send themselves.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { resolveEventSwitches } from '@/cms/core/analytics/catalog';
import type { CustomEvent } from '@/cms/core/analytics/custom-events';
import {
  clickEventFor,
  configureAnalyticsRuntime,
  resetAnalyticsRuntimeForTests,
  track,
  trackCustomHits,
  trackPageView,
} from '@/lib/analytics/runtime';

interface FakeWindow {
  dataLayer: unknown[];
  gtag: (...args: unknown[]) => void;
  fbq: (...args: unknown[]) => void;
  location: { href: string; pathname: string };
  localStorage: Storage;
}

let gtagCalls: unknown[][];
let fbqCalls: unknown[][];
let store: Map<string, string>;

function fakeStorage(): Storage {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
}

beforeEach(() => {
  gtagCalls = [];
  fbqCalls = [];
  store = new Map();
  const win: FakeWindow = {
    dataLayer: [],
    gtag: (...args) => void gtagCalls.push(args),
    fbq: (...args) => void fbqCalls.push(args),
    location: { href: 'https://example.gr/order/ORD-1', pathname: '/order/ORD-1' },
    localStorage: fakeStorage(),
  };
  Object.assign(globalThis, {
    window: win,
    document: { title: 'Thanks', documentElement: { lang: 'el' }, querySelector: () => null },
  });
  resetAnalyticsRuntimeForTests();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

const win = () => (globalThis as unknown as { window: FakeWindow }).window;

function configure(consent = { analytics: true, marketing: true }, customEvents: CustomEvent[] = []) {
  configureAnalyticsRuntime({
    customEvents,
    switches: resolveEventSwitches({ profiles: ['website', 'eshop', 'booking'] }),
    gtm: true,
    gtag: true,
    pixel: true,
    consent,
    decided: true,
    locales: ['el', 'en'],
    debug: false,
  });
}

describe('track', () => {
  test('an event fired before the runtime is configured waits, then goes', () => {
    track('generate_lead', { form_id: 'contact' });
    assert.equal(win().dataLayer.length, 0);
    configure();
    assert.equal(win().dataLayer.length, 1);
    assert.equal((win().dataLayer[0] as { event: string }).event, 'generate_lead');
    assert.equal(gtagCalls.length, 1);
    assert.equal(fbqCalls.length, 1);
  });

  test('common parameters ride along', () => {
    configure();
    track('generate_lead', { form_id: 'contact' });
    assert.deepEqual(win().dataLayer[0], {
      event: 'generate_lead',
      page_location: 'https://example.gr/order/ORD-1',
      page_title: 'Thanks',
      page_type: 'order',
      language: 'el',
      form_id: 'contact',
      cms_meta: { name: 'Lead', method: 'track', params: { form_id: 'contact' } },
    });
  });

  test('queued events are dropped, not sent, when the visitor refuses', () => {
    track('generate_lead', { form_id: 'contact' });
    configure({ analytics: false, marketing: false });
    assert.equal(win().dataLayer.length, 0);
    assert.equal(gtagCalls.length + fbqCalls.length, 0);
  });

  test('a `once` key sends at most once, across reloads (stored)', () => {
    configure();
    track('purchase', { transaction_id: 'ORD-1', value: 10, currency: 'EUR' }, { once: 'purchase:ORD-1', eventId: 'ORD-1' });
    resetAnalyticsRuntimeForTests(); // a reload: module state gone, storage kept
    configure();
    track('purchase', { transaction_id: 'ORD-1', value: 10, currency: 'EUR' }, { once: 'purchase:ORD-1', eventId: 'ORD-1' });
    assert.equal(win().dataLayer.filter((e) => (e as { event: string }).event === 'purchase').length, 1);
  });

  test('a `once` event that could not be sent (no consent) is not marked as sent', () => {
    configure({ analytics: false, marketing: false });
    track('purchase', { transaction_id: 'ORD-2' }, { once: 'purchase:ORD-2' });
    resetAnalyticsRuntimeForTests();
    configure();
    track('purchase', { transaction_id: 'ORD-2' }, { once: 'purchase:ORD-2' });
    assert.equal(win().dataLayer.length, 1);
  });

  test('the browser and the server share the event id (dedup)', () => {
    configure();
    track('purchase', { transaction_id: 'ORD-3' }, { eventId: 'ORD-3' });
    assert.deepEqual(fbqCalls[0][3], { eventID: 'ORD-3' });
    assert.equal((win().dataLayer[0] as { event_id: string }).event_id, 'ORD-3');
  });
});

describe('trackPageView', () => {
  test('the entry page_view goes to the dataLayer only — the tags send their own', () => {
    configure();
    trackPageView(true);
    assert.equal(win().dataLayer.length, 1);
    assert.equal(gtagCalls.length, 0);
    assert.equal(fbqCalls.length, 0);
  });

  test('an entry page_view that had to wait for consent still goes to the dataLayer only', () => {
    trackPageView(true);
    configure();
    assert.equal(win().dataLayer.length, 1);
    assert.equal(gtagCalls.length + fbqCalls.length, 0);
  });

  test('a page change without a reload goes everywhere', () => {
    configure();
    trackPageView(false);
    assert.equal(win().dataLayer.length, 1);
    assert.deepEqual(gtagCalls[0].slice(0, 2), ['event', 'page_view']);
    assert.deepEqual(fbqCalls[0].slice(0, 2), ['track', 'PageView']);
  });
});

describe('clickEventFor', () => {
  const link = (href: string, extra: Record<string, string> = {}) => ({
    href,
    getAttribute: (name: string) => (name === 'href' ? href : (extra[name] ?? null)),
    closest: () => null,
  });

  test('tel: is click_to_call', () => {
    assert.deepEqual(clickEventFor(link('tel:+302101234567')), { id: 'click_to_call', params: { link_url: 'tel:+302101234567' } });
  });

  test('mailto: is click_to_email, without the address itself', () => {
    assert.deepEqual(clickEventFor(link('mailto:info@example.gr')), {
      id: 'click_to_email',
      params: { link_url: 'mailto:', link_domain: 'example.gr' },
    });
  });

  test('a document link is file_download', () => {
    assert.deepEqual(clickEventFor(link('https://example.gr/files/Menu%202026.PDF?v=2')), {
      id: 'file_download',
      params: { file_name: 'Menu 2026.PDF', file_extension: 'pdf', link_url: 'https://example.gr/files/Menu%202026.PDF?v=2' },
    });
  });

  test('a content card is select_content', () => {
    const card = { ...link('/blog/hello', { 'data-cms-content-type': 'article', 'data-cms-content-id': 'hello' }) };
    assert.deepEqual(clickEventFor(card), { id: 'select_content', params: { content_type: 'article', content_id: 'hello' } });
  });

  test('a product card is select_item, with its list', () => {
    const card = link('/shop/mug', {
      'data-cms-item-id': 'mug',
      'data-cms-item-name': 'Mug',
      'data-cms-item-price': '12.5',
      'data-cms-item-list': 'category:cups',
    });
    assert.deepEqual(clickEventFor(card), {
      id: 'select_item',
      params: { item_list_id: 'category:cups', items: [{ item_id: 'mug', item_name: 'Mug', price: 12.5 }] },
    });
  });

  test('an ordinary link is nothing', () => {
    assert.equal(clickEventFor(link('/about')), null);
  });
});

describe('custom events in the runtime', () => {
  const quote: CustomEvent = {
    name: 'quote_sent',
    trigger: { type: 'form', formId: 'quote_request' },
    params: [{ key: 'tour_name', value: 'Loutraki' }],
    ga4: true,
    meta: true,
  };
  const pricing: CustomEvent = { name: 'pricing_view', trigger: { type: 'view', path: '/order/*' }, params: [], ga4: true, meta: false };

  test('a form trigger fires with the lead for that form_id', () => {
    configure(undefined, [quote]);
    track('generate_lead', { form_id: 'quote_request', form_name: 'Quote' });
    const names = win().dataLayer.map((e) => (e as { event: string }).event);
    assert.deepEqual(names, ['generate_lead', 'quote_sent']);
    assert.deepEqual(fbqCalls[1], ['trackCustom', 'quote_sent', { form_id: 'quote_request', form_name: 'Quote', tour_name: 'Loutraki' }]);
  });

  test('a page trigger fires with the page view', () => {
    configure(undefined, [pricing]);
    trackPageView(false);
    const names = win().dataLayer.map((e) => (e as { event: string }).event);
    assert.deepEqual(names, ['page_view', 'pricing_view']);
  });

  test('hits found by the loader (clicks, downloads, videos, sections) wait for consent like any event', () => {
    trackCustomHits([{ event: pricing, params: { page_path: '/x', section_id: 'faq' } }]);
    assert.equal(win().dataLayer.length, 0);
    configure(undefined, [pricing]);
    assert.equal((win().dataLayer[0] as { event: string }).event, 'pricing_view');
  });
});
