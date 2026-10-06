/**
 * The GTM container export (REQ-5 §5).
 *
 * Built from the same settings the site runs on, in GTM's import format, with
 * stable `CMS · …` names so a second import with "Overwrite" replaces rather
 * than duplicates. These tests hold the structure GTM's importer needs — every
 * variable a tag references exists, every trigger a tag fires on exists, ids
 * are unique — and the rules: no tag for a destination the CMS already loads
 * directly (never counted twice), the right consent on every tag.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveEventSwitches } from '@/cms/core/analytics/catalog';
import type { CustomEvent } from '@/cms/core/analytics/custom-events';
import { GOOGLE_ADS_KEY, googleAdsSchema } from '@/cms/core/analytics/google-ads';
import { buildGtmContainer, gtmEntityNames, staleGtmEntities, type GtmExportInput } from '@/cms/core/analytics/gtm-export';
import { checkStructuredSetting } from '@/cms/core/settings/structured';
import { dispatchEvent } from '@/lib/analytics/dispatch';

const tour: CustomEvent = {
  name: 'virtual_tour_open',
  trigger: { type: 'click', selector: 'virtual-tour' },
  params: [{ key: 'tour_name', value: 'Loutraki' }],
  ga4: true,
  meta: true,
};

const input = (over: Partial<GtmExportInput> = {}): GtmExportInput => ({
  gtmId: 'GTM-ABCD123',
  ga4ViaGtm: true,
  pixelViaGtm: true,
  pixelId: '123456789012345',
  switches: resolveEventSwitches({ profiles: ['website', 'eshop'] }),
  customEvents: [tour],
  googleAds: { conversionId: 'AW-123456789', labels: { generate_lead: 'AbCdLead', purchase: 'AbCdBuy' } },
  exportTime: new Date('2026-10-02T10:00:00Z'),
  ...over,
});

type Entity = { name: string; tagId?: string; triggerId?: string; variableId?: string; firingTriggerId?: string[]; type: string; parameter?: unknown[]; consentSettings?: { consentStatus: string; consentType: { list: { value: string }[] } } };

function cv(json: ReturnType<typeof buildGtmContainer>) {
  return json.containerVersion as unknown as { tag: Entity[]; trigger: Entity[]; variable: Entity[]; customTemplate: { templateId: string; name: string; templateData: string }[]; container: { publicId: string } };
}

describe('buildGtmContainer', () => {
  const json = buildGtmContainer(input());
  const c = cv(json);
  const tagNames = c.tag.map((t) => t.name);

  test('is in GTM import format, for this container', () => {
    assert.equal(json.exportFormatVersion, 2);
    assert.equal(c.container.publicId, 'GTM-ABCD123');
  });

  test('every name carries the CMS prefix', () => {
    for (const e of [...c.tag, ...c.trigger, ...c.variable]) assert.match(e.name, /^CMS · /, e.name);
  });

  test('ids are unique within each kind', () => {
    for (const [list, key] of [[c.tag, 'tagId'], [c.trigger, 'triggerId'], [c.variable, 'variableId']] as const) {
      const ids = list.map((e) => (e as unknown as Record<string, string>)[key]);
      assert.equal(new Set(ids).size, ids.length, key);
    }
  });

  test('every tag fires on a trigger that exists (or a built-in one)', () => {
    const triggers = new Set([...c.trigger.map((t) => t.triggerId), '2147479553', '2147479573']);
    for (const t of c.tag) for (const id of t.firingTriggerId ?? []) assert.ok(triggers.has(id), `${t.name} → ${id}`);
  });

  test('every {{variable}} a tag or trigger references exists', () => {
    const vars = new Set([...c.variable.map((v) => v.name), 'Event', '_event']);
    const refs = JSON.stringify([c.tag, c.trigger]).match(/\{\{([^}]+)\}\}/g) ?? [];
    for (const ref of refs) assert.ok(vars.has(ref.slice(2, -2)), ref);
  });

  test('the variables: GA4 id, Pixel id, and a Data Layer Variable per parameter', () => {
    const names = c.variable.map((v) => v.name);
    for (const n of ['CMS · DLV · cms_ga4_id', 'CMS · Pixel ID', 'CMS · DLV · form_id', 'CMS · DLV · value', 'CMS · DLV · currency', 'CMS · DLV · items', 'CMS · DLV · transaction_id', 'CMS · DLV · tour_name']) {
      assert.ok(names.includes(n), n);
    }
  });

  test('one Custom Event trigger per active event', () => {
    const names = c.trigger.map((t) => t.name);
    assert.ok(names.includes('CMS · Trigger · generate_lead'));
    assert.ok(names.includes('CMS · Trigger · purchase'));
    assert.ok(names.includes('CMS · Trigger · virtual_tour_open'));
    // Website + E-shop: no booking-only event, and nothing for an event off in both.
    assert.ok(!names.includes('CMS · Trigger · refund'));
  });

  test('the Google tag reads its id from the variable, and does not send its own page_view', () => {
    const tag = c.tag.find((t) => t.name === 'CMS · Google tag');
    assert.ok(tag);
    assert.equal(tag.type, 'googtag');
    assert.match(JSON.stringify(tag.parameter), /\{\{CMS · DLV · cms_ga4_id\}\}/);
    assert.match(JSON.stringify(tag.parameter), /send_page_view.*false/);
  });

  test('a GA4 Event tag per GA4-enabled event, Meta tags per Meta-enabled event, standard or custom', () => {
    assert.ok(tagNames.includes('CMS · GA4 · generate_lead'));
    assert.ok(tagNames.includes('CMS · GA4 · virtual_tour_open'));
    assert.ok(tagNames.includes('CMS · Meta · Lead'));
    assert.ok(tagNames.includes('CMS · Meta · Purchase'));
    assert.ok(tagNames.includes('CMS · Meta · virtual_tour_open'));
    // Meta custom catalogue events are off by default.
    assert.ok(!tagNames.includes('CMS · Meta · file_download'));
  });

  test('two events with the same Meta name get distinct tag names', () => {
    assert.ok(tagNames.includes('CMS · Meta · Lead · newsletter_sign_up'));
    assert.equal(new Set(tagNames).size, tagNames.length);
  });

  test('Google Ads conversions for the events with a label, plus the Conversion Linker', () => {
    assert.ok(tagNames.includes('CMS · Ads · generate_lead'));
    assert.ok(tagNames.includes('CMS · Ads · purchase'));
    assert.ok(tagNames.includes('CMS · Ads · Conversion Linker'));
    const purchase = c.tag.find((t) => t.name === 'CMS · Ads · purchase');
    assert.match(JSON.stringify(purchase?.parameter), /AW-123456789|123456789/);
    assert.match(JSON.stringify(purchase?.parameter), /AbCdBuy/);
  });

  test('the Meta template travels inside the same JSON', () => {
    assert.equal(c.customTemplate.length, 1);
    assert.match(c.customTemplate[0].templateData, /___SANDBOXED_JS_FOR_WEB_TEMPLATE___/);
    assert.match(c.customTemplate[0].templateData, /connect\.facebook\.net/);
    const metaTag = c.tag.find((t) => t.name === 'CMS · Meta · Lead');
    assert.equal(metaTag?.type, `cvt_${c.customTemplate[0].templateId}`);
  });

  test('every tag states its consent: GA4 analytics_storage; Ads and Meta ad_storage', () => {
    const consentOf = (name: string) => c.tag.find((t) => t.name === name)?.consentSettings;
    assert.equal(consentOf('CMS · GA4 · generate_lead')?.consentStatus, 'NEEDED');
    assert.deepEqual(consentOf('CMS · GA4 · generate_lead')?.consentType.list.map((x) => x.value), ['analytics_storage']);
    assert.deepEqual(consentOf('CMS · Meta · Lead')?.consentType.list.map((x) => x.value), ['ad_storage']);
    assert.deepEqual(consentOf('CMS · Ads · purchase')?.consentType.list.map((x) => x.value), ['ad_storage']);
  });

  test('no GA4 tags when the CMS loads GA4 itself, no Meta tags when it loads the Pixel itself', () => {
    const direct = cv(buildGtmContainer(input({ ga4ViaGtm: false, pixelViaGtm: false })));
    const names = direct.tag.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith('CMS · GA4 ') || n === 'CMS · Google tag'));
    assert.ok(!names.some((n) => n.startsWith('CMS · Meta ')));
    assert.equal(direct.customTemplate.length, 0);
    assert.ok(names.includes('CMS · Ads · purchase'), 'Ads only ever runs through GTM');
  });

  test('the same settings give the same container (so a re-import overwrites cleanly)', () => {
    const a = buildGtmContainer(input());
    const b = buildGtmContainer(input());
    assert.deepEqual(a, b);
  });
});

describe('stale entities', () => {
  test('what the last export had and this one does not, to delete by hand', () => {
    const before = gtmEntityNames(buildGtmContainer(input()));
    const after = gtmEntityNames(
      buildGtmContainer(input({ customEvents: [], switches: resolveEventSwitches({ profiles: ['website'] }) })),
    );
    const stale = staleGtmEntities(before, after);
    assert.ok(stale.includes('CMS · GA4 · virtual_tour_open'));
    assert.ok(stale.includes('CMS · Trigger · purchase'));
    assert.ok(!stale.includes('CMS · GA4 · generate_lead'));
  });
});

describe('Google Ads settings', () => {
  test('a conversion id and labels per event', () => {
    assert.equal(checkStructuredSetting(GOOGLE_ADS_KEY, { conversionId: 'AW-123456789', labels: { purchase: 'AbCd-123_x' } })?.ok, true);
  });
  test('refuses a malformed id or label', () => {
    assert.equal(googleAdsSchema.safeParse({ conversionId: '123', labels: {} }).success, false);
    assert.equal(googleAdsSchema.safeParse({ conversionId: 'AW-1', labels: {} }).success, false);
    assert.equal(googleAdsSchema.safeParse({ labels: { purchase: 'a"b' } }).success, false);
  });
});

describe('the dataLayer carries what the Meta tag needs', () => {
  test('a Meta-enabled event pushes cms_meta with name, method and mapped parameters', () => {
    const out = dispatchEvent(
      'add_to_cart',
      { items: [{ item_id: 'SKU1', quantity: 1, price: 5 }], value: 5, currency: 'EUR' },
      {
        switches: resolveEventSwitches({ profiles: ['eshop'] }),
        gtm: true,
        gtag: false,
        pixel: false,
        consent: { analytics: true, marketing: true },
        common: {},
      },
    );
    assert.deepEqual((out.dataLayer as { cms_meta: unknown }).cms_meta, {
      name: 'AddToCart',
      method: 'track',
      params: { value: 5, currency: 'EUR', content_ids: ['SKU1'], contents: [{ id: 'SKU1', quantity: 1 }], content_type: 'product', num_items: 1 },
    });
  });
});
