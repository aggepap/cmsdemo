/**
 * The event catalogue, profiles and per-event switches (REQ-5 §3).
 *
 * One list of events. A profile (Website · E-shop · Booking, combinable) decides
 * which are on by default; every event then has a GA4 switch and a Meta switch
 * the admin can flip either way, including events of a profile not chosen.
 * A Meta event with a standard equivalent goes as that standard event; one
 * without goes as a custom event of the same name — and is OFF by default.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ANALYTICS_TRACKING_KEY,
  EVENT_CATALOG,
  catalogEvent,
  resolveEventSwitches,
  suggestProfiles,
} from '@/cms/core/analytics/catalog';
import { checkStructuredSetting } from '@/cms/core/settings/structured';
import { dispatchEvent, pageTypeFor, sanitizeParams, type DispatchContext } from '@/lib/analytics/dispatch';

describe('EVENT_CATALOG', () => {
  const byId = (id: string) => {
    const e = catalogEvent(id);
    assert.ok(e, id);
    return e;
  };

  test('every event REQ-5 lists is in the catalogue', () => {
    for (const id of [
      'page_view', 'search', 'select_content', 'generate_lead', 'click_to_call', 'click_to_email',
      'file_download', 'newsletter_sign_up', 'account_sign_up', 'login', 'view_item_list',
      'select_item', 'view_item', 'add_to_wishlist', 'add_to_cart', 'remove_from_cart',
      'view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'add_coupon',
      'purchase', 'refund',
    ]) {
      byId(id);
    }
  });

  test('ids are unique', () => {
    const ids = EVENT_CATALOG.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('Meta mappings follow the table', () => {
    assert.deepEqual(byId('generate_lead').meta, { name: 'Lead', standard: true });
    assert.deepEqual(byId('click_to_call').meta, { name: 'Contact', standard: true });
    assert.deepEqual(byId('purchase').meta, { name: 'Purchase', standard: true });
    assert.deepEqual(byId('add_to_cart').meta, { name: 'AddToCart', standard: true });
    assert.deepEqual(byId('begin_checkout').meta, { name: 'InitiateCheckout', standard: true });
    assert.deepEqual(byId('account_sign_up').meta, { name: 'CompleteRegistration', standard: true });
    assert.deepEqual(byId('newsletter_sign_up').meta, { name: 'Lead', standard: true });
    assert.deepEqual(byId('file_download').meta, { name: 'file_download', standard: false });
    assert.deepEqual(byId('select_content').meta, { name: 'select_content', standard: false });
    assert.equal(byId('remove_from_cart').meta, null);
    assert.equal(byId('refund').meta, null);
  });

  test('both sign-ups are GA4 sign_up, told apart by method', () => {
    assert.equal(byId('newsletter_sign_up').ga4, 'sign_up');
    assert.equal(byId('account_sign_up').ga4, 'sign_up');
  });

  test('profiles follow the table', () => {
    assert.deepEqual(byId('generate_lead').profiles, ['website', 'eshop', 'booking']);
    assert.deepEqual(byId('add_to_cart').profiles, ['eshop']);
    assert.deepEqual(byId('view_item').profiles, ['eshop', 'booking']);
    assert.deepEqual(byId('purchase').profiles, ['eshop', 'booking']);
  });
});

describe('suggestProfiles', () => {
  test('Website always; E-shop with commerce; Booking with booking', () => {
    assert.deepEqual(suggestProfiles({ commerce: false, booking: false }), ['website']);
    assert.deepEqual(suggestProfiles({ commerce: true, booking: false }), ['website', 'eshop']);
    assert.deepEqual(suggestProfiles({ commerce: true, booking: true }), ['website', 'eshop', 'booking']);
  });
});

describe('resolveEventSwitches', () => {
  test('a Website profile turns on website events only', () => {
    const s = resolveEventSwitches({ profiles: ['website'] });
    assert.deepEqual(s.generate_lead, { ga4: true, meta: true });
    assert.deepEqual(s.add_to_cart, { ga4: false, meta: false });
  });

  test('custom Meta events are off by default even in an active profile', () => {
    const s = resolveEventSwitches({ profiles: ['website', 'eshop'] });
    assert.deepEqual(s.file_download, { ga4: true, meta: false });
    assert.deepEqual(s.add_coupon, { ga4: true, meta: false });
  });

  test('an event with no Meta equivalent never has Meta on', () => {
    const s = resolveEventSwitches({ profiles: ['eshop'], events: { remove_from_cart: { meta: true } } });
    assert.equal(s.remove_from_cart.meta, false);
  });

  test('profiles combine', () => {
    const s = resolveEventSwitches({ profiles: ['website', 'booking'] });
    assert.equal(s.view_item.ga4, true);
    assert.equal(s.add_to_cart.ga4, false);
  });

  test('an admin override wins either way, including events of another profile', () => {
    const s = resolveEventSwitches({
      profiles: ['website'],
      events: { generate_lead: { meta: false }, add_to_cart: { ga4: true }, file_download: { meta: true } },
    });
    assert.deepEqual(s.generate_lead, { ga4: true, meta: false });
    assert.deepEqual(s.add_to_cart, { ga4: true, meta: false });
    assert.deepEqual(s.file_download, { ga4: true, meta: true });
  });

  test('no stored profile falls back to the suggestion it is given', () => {
    const s = resolveEventSwitches({}, ['website', 'eshop']);
    assert.equal(s.add_to_cart.ga4, true);
  });
});

describe('the analytics.tracking setting', () => {
  test('accepts profiles and per-event overrides', () => {
    const check = checkStructuredSetting(ANALYTICS_TRACKING_KEY, {
      profiles: ['website', 'eshop'],
      events: { generate_lead: { ga4: true, meta: false } },
    });
    assert.equal(check?.ok, true);
  });

  test('refuses an unknown profile or event', () => {
    assert.equal(checkStructuredSetting(ANALYTICS_TRACKING_KEY, { profiles: ['blog'] })?.ok, false);
    assert.equal(
      checkStructuredSetting(ANALYTICS_TRACKING_KEY, { profiles: [], events: { nope: { ga4: true } } })?.ok,
      false,
    );
  });
});

describe('dispatchEvent', () => {
  const common = { page_location: 'https://example.gr/contact', page_title: 'Contact', page_type: 'page', language: 'el' };
  const ctx = (over: Partial<DispatchContext> = {}): DispatchContext => ({
    switches: resolveEventSwitches({ profiles: ['website', 'eshop', 'booking'] }),
    gtm: true,
    gtag: true,
    pixel: true,
    consent: { analytics: true, marketing: true },
    common,
    ...over,
  });

  test('a lead goes to the dataLayer, GA4 and Meta (standard Lead)', () => {
    const out = dispatchEvent('generate_lead', { form_id: 'contact', form_name: 'Contact' }, ctx(), 'lead-1');
    assert.deepEqual(out.dataLayer, {
      event: 'generate_lead',
      ...common,
      form_id: 'contact',
      form_name: 'Contact',
      event_id: 'lead-1',
      cms_meta: { name: 'Lead', method: 'track', params: { form_id: 'contact', form_name: 'Contact' } },
    });
    assert.deepEqual(out.gtag, ['event', 'generate_lead', { ...common, form_id: 'contact', form_name: 'Contact' }]);
    assert.deepEqual(out.fbq, ['track', 'Lead', { form_id: 'contact', form_name: 'Contact' }, { eventID: 'lead-1' }]);
  });

  test('a custom Meta event goes with trackCustom under its own name', () => {
    const switches = resolveEventSwitches({ profiles: ['website'], events: { file_download: { meta: true } } });
    const out = dispatchEvent('file_download', { file_name: 'a.pdf', file_extension: 'pdf', link_url: '/a.pdf' }, ctx({ switches }));
    assert.equal(out.fbq?.[0], 'trackCustom');
    assert.equal(out.fbq?.[1], 'file_download');
  });

  test('the newsletter sign-up is GA4 sign_up/newsletter and Meta Lead/newsletter', () => {
    const out = dispatchEvent('newsletter_sign_up', {}, ctx());
    assert.deepEqual(out.gtag, ['event', 'sign_up', { ...common, method: 'newsletter' }]);
    assert.deepEqual(out.fbq?.slice(0, 3), ['track', 'Lead', { lead_type: 'newsletter' }]);
  });

  test('items become Meta content_ids/contents', () => {
    const items = [{ item_id: 'SKU1', item_name: 'Mug', price: 10, quantity: 2 }];
    const out = dispatchEvent('add_to_cart', { items, value: 20, currency: 'EUR' }, ctx());
    assert.deepEqual(out.fbq?.[2], {
      value: 20,
      currency: 'EUR',
      content_ids: ['SKU1'],
      contents: [{ id: 'SKU1', quantity: 2 }],
      content_type: 'product',
      num_items: 2,
    });
  });

  test('a switch that is off keeps the event out of that destination', () => {
    const switches = resolveEventSwitches({ profiles: ['website'], events: { generate_lead: { meta: false } } });
    const out = dispatchEvent('generate_lead', { form_id: 'contact' }, ctx({ switches }));
    assert.ok(out.gtag);
    assert.equal(out.fbq, undefined);
  });

  test('an event off in both goes nowhere, not even the dataLayer', () => {
    const switches = resolveEventSwitches({ profiles: ['website'] });
    assert.deepEqual(dispatchEvent('add_to_cart', { value: 1 }, ctx({ switches })), {});
  });

  test('without consent nothing is sent anywhere', () => {
    assert.deepEqual(dispatchEvent('generate_lead', { form_id: 'contact' }, ctx({ consent: { analytics: false, marketing: false } })), {});
  });

  test('GA4 needs Analytics consent, Meta needs Marketing consent', () => {
    const analyticsOnly = dispatchEvent('generate_lead', {}, ctx({ consent: { analytics: true, marketing: false } }));
    assert.ok(analyticsOnly.gtag);
    assert.equal(analyticsOnly.fbq, undefined);
    const marketingOnly = dispatchEvent('generate_lead', {}, ctx({ consent: { analytics: false, marketing: true } }));
    assert.equal(marketingOnly.gtag, undefined);
    assert.ok(marketingOnly.fbq);
  });

  test('a destination that is not loaded directly is not called', () => {
    const out = dispatchEvent('generate_lead', {}, ctx({ gtag: false, pixel: false }));
    assert.ok(out.dataLayer);
    assert.equal(out.gtag, undefined);
    assert.equal(out.fbq, undefined);
  });

  test('no PII ever reaches the dataLayer, GA4 or the Pixel', () => {
    const out = dispatchEvent(
      'generate_lead',
      { form_id: 'contact', email: 'a@b.co', phone: '+30 210', name: 'Μαρία', note: 'reach me at a@b.co' },
      ctx(),
    );
    const all = JSON.stringify(out);
    assert.doesNotMatch(all, /a@b\.co|\+30 210|Μαρία/);
  });

  test('an unknown event goes nowhere', () => {
    assert.deepEqual(dispatchEvent('not_an_event', {}, ctx()), {});
  });
});

describe('sanitizeParams', () => {
  test('drops PII keys at any depth and email-looking values', () => {
    assert.deepEqual(
      sanitizeParams({
        value: 10,
        customer_email: 'x@y.z',
        items: [{ item_id: '1', first_name: 'A', address: 'Odos 1' }],
        note: 'x@y.z',
      }),
      { value: 10, items: [{ item_id: '1' }] },
    );
  });
});

describe('pageTypeFor', () => {
  const cases: Array<[string, string]> = [
    ['/', 'home'],
    ['/en', 'home'],
    ['/shop', 'product_list'],
    ['/shop/blue-mug', 'product'],
    ['/en/shop/blue-mug', 'product'],
    ['/cart', 'cart'],
    ['/checkout', 'checkout'],
    ['/order/ORD-1', 'order'],
    ['/booking', 'booking_list'],
    ['/booking/sunset-cruise', 'booking'],
    ['/blog', 'article_list'],
    ['/blog/hello', 'article'],
    ['/account', 'account'],
    ['/about', 'page'],
  ];
  for (const [path, type] of cases) {
    test(`${path} → ${type}`, () => assert.equal(pageTypeFor(path, ['el', 'en']), type));
  }
});
