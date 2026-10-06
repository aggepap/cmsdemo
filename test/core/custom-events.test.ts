/**
 * Custom events (REQ-5 §4).
 *
 * The admin names an event (snake_case), says when it fires, adds up to five
 * fixed parameters and flips GA4 / Meta. Each trigger carries its own
 * standardised parameters, always under the same names. Meta gets custom events
 * with `trackCustom`; nothing has to be created in Meta first.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CUSTOM_EVENTS_KEY,
  customEventsSchema,
  customParamsToDeclare,
  matchCustomClick,
  matchCustomDownload,
  matchCustomForm,
  matchCustomPageView,
  readCustomEvents,
  type CustomEvent,
} from '@/cms/core/analytics/custom-events';
import { checkStructuredSetting } from '@/cms/core/settings/structured';
import { dispatchCustomEvent } from '@/lib/analytics/dispatch';

const tour: CustomEvent = {
  name: 'virtual_tour_open',
  trigger: { type: 'click', selector: 'virtual-tour' },
  params: [{ key: 'tour_name', value: 'Λουτράκι' }],
  ga4: true,
  meta: true,
};

function el(attrs: Record<string, string>, text = '') {
  return {
    getAttribute: (n: string) => attrs[n] ?? null,
    id: attrs.id ?? '',
    classList: { contains: (c: string) => (attrs.class ?? '').split(/\s+/).includes(c) },
    textContent: text,
  };
}

describe('validation', () => {
  test('a well-formed list is accepted through the settings boundary', () => {
    assert.equal(checkStructuredSetting(CUSTOM_EVENTS_KEY, [tour])?.ok, true);
  });

  const bad: Array<[string, unknown]> = [
    ['not snake_case', [{ ...tour, name: 'VirtualTour' }]],
    ['a reserved GA4 prefix', [{ ...tour, name: 'google_tour' }]],
    ['a name the catalogue already uses', [{ ...tour, name: 'purchase' }]],
    ['too long', [{ ...tour, name: 'a'.repeat(41) }]],
    ['six parameters', [{ ...tour, params: Array.from({ length: 6 }, (_, i) => ({ key: `p${i}`, value: 'x' })) }]],
    ['a parameter that is not snake_case', [{ ...tour, params: [{ key: 'Tour Name', value: 'x' }] }]],
    ['a parameter that clashes with a standard one', [{ ...tour, params: [{ key: 'link_url', value: 'x' }] }]],
    ['a CSS selector that is more than an id or a class', [{ ...tour, trigger: { type: 'click', selector: 'div > a[href]' } }]],
    ['a duplicate name', [tour, tour]],
  ];
  for (const [why, value] of bad) {
    test(`refuses ${why}`, () => {
      assert.equal(customEventsSchema.safeParse(value).success, false);
    });
  }

  test('a stored value that is not valid reads as no custom events', () => {
    assert.deepEqual(readCustomEvents([{ name: 'x y' }]), []);
    assert.deepEqual(readCustomEvents(null), []);
  });
});

describe('triggers', () => {
  test('click: by data-track value', () => {
    const hit = matchCustomClick([tour], el({ 'data-track': 'virtual-tour', href: '/tour' }, '  Open the tour '));
    assert.deepEqual(hit, [{ event: tour, params: { element_id: 'virtual-tour', element_text: 'Open the tour', link_url: '/tour' } }]);
  });

  test('click: by #id and by .class', () => {
    const byId = { ...tour, trigger: { type: 'click' as const, selector: '#book-now' } };
    const byClass = { ...tour, name: 'promo_click', trigger: { type: 'click' as const, selector: '.promo' } };
    assert.equal(matchCustomClick([byId], el({ id: 'book-now' })).length, 1);
    assert.equal(matchCustomClick([byClass], el({ class: 'card promo' })).length, 1);
    assert.equal(matchCustomClick([byClass], el({ class: 'promotion' })).length, 0);
  });

  test('download: by the extensions the admin listed', () => {
    const brochure = { ...tour, name: 'brochure_download', trigger: { type: 'download' as const, extensions: ['pdf'] } };
    assert.deepEqual(matchCustomDownload([brochure], '/files/Brochure.PDF'), [
      { event: brochure, params: { file_name: 'Brochure.PDF', file_extension: 'pdf', link_url: '/files/Brochure.PDF' } },
    ]);
    assert.deepEqual(matchCustomDownload([brochure], '/files/a.zip'), []);
  });

  test('page or section: an exact path, a path prefix, or a section id', () => {
    const exact = { ...tour, name: 'pricing_view', trigger: { type: 'view' as const, path: '/pricing' } };
    const prefix = { ...tour, name: 'blog_view', trigger: { type: 'view' as const, path: '/blog/*' } };
    assert.equal(matchCustomPageView([exact], '/pricing', ['el', 'en']).length, 1);
    assert.equal(matchCustomPageView([exact], '/en/pricing', ['el', 'en']).length, 1);
    assert.equal(matchCustomPageView([exact], '/pricing-old', ['el', 'en']).length, 0);
    assert.equal(matchCustomPageView([prefix], '/blog/hello', ['el', 'en']).length, 1);
    assert.deepEqual(matchCustomPageView([exact], '/pricing', ['el', 'en'])[0].params, { page_path: '/pricing', section_id: '' });
  });

  test('form: a specific form_id', () => {
    const quote = { ...tour, name: 'quote_sent', trigger: { type: 'form' as const, formId: 'quote_request' } };
    assert.deepEqual(matchCustomForm([quote], { form_id: 'quote_request', form_name: 'Quote' }), [
      { event: quote, params: { form_id: 'quote_request', form_name: 'Quote' } },
    ]);
    assert.deepEqual(matchCustomForm([quote], { form_id: 'contact' }), []);
  });
});

describe('dispatchCustomEvent', () => {
  const ctx = {
    gtm: true,
    gtag: true,
    pixel: true,
    consent: { analytics: true, marketing: true },
    common: { page_location: 'https://example.gr/', page_title: 'Home', page_type: 'home', language: 'el' },
  };

  test('dataLayer, GA4 and Meta trackCustom, with the fixed parameters', () => {
    const out = dispatchCustomEvent(tour, { element_id: 'virtual-tour' }, ctx);
    assert.deepEqual(out.dataLayer, {
      event: 'virtual_tour_open',
      ...ctx.common,
      element_id: 'virtual-tour',
      tour_name: 'Λουτράκι',
      cms_meta: { name: 'virtual_tour_open', method: 'trackCustom', params: { element_id: 'virtual-tour', tour_name: 'Λουτράκι' } },
    });
    assert.deepEqual(out.gtag, ['event', 'virtual_tour_open', { ...ctx.common, element_id: 'virtual-tour', tour_name: 'Λουτράκι' }]);
    assert.deepEqual(out.fbq, ['trackCustom', 'virtual_tour_open', { element_id: 'virtual-tour', tour_name: 'Λουτράκι' }]);
  });

  test('switches and consent apply as for catalogue events', () => {
    assert.equal(dispatchCustomEvent({ ...tour, meta: false }, {}, ctx).fbq, undefined);
    assert.deepEqual(dispatchCustomEvent(tour, {}, { ...ctx, consent: { analytics: false, marketing: false } }), {});
  });
});

describe('the GA4 setup lists', () => {
  test('parameters to declare as custom dimensions: the custom ones and the trigger ones in use', () => {
    const list = customParamsToDeclare([tour]);
    for (const p of ['tour_name', 'element_id', 'element_text', 'form_id']) assert.ok(list.includes(p), p);
  });
});
