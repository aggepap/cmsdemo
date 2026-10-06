/**
 * Analytics & Marketing settings → what loads (REQ-5 §1, §2).
 *
 * The rules pinned here:
 *   - GA4 and the Meta Pixel load EITHER directly OR through GTM — never both,
 *     so nothing is ever measured twice;
 *   - "via GTM" without a GTM container means direct (otherwise nothing loads);
 *   - nothing at all before consent, and no `<noscript>` / iframe fallbacks;
 *   - only on the production host (apex or www).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ANALYTICS_GA4_VIA_GTM_KEY,
  ANALYTICS_GTM_ID_KEY,
  MARKETING_META_DOMAIN_VERIFICATION_KEY,
  MARKETING_META_PIXEL_ID_KEY,
  MARKETING_META_PIXEL_VIA_GTM_KEY,
  marketingLoadPlan,
  resolveMarketingConfig,
} from '@/cms/core/settings/marketing';
import { ANALYTICS_GA_ID_KEY } from '@/cms/core/settings/analytics';
import { MANAGED_SETTINGS } from '@/cms/core/settings/schema';
import { validateSettingValue } from '@/cms/core/settings/validate';
import { CONSENT_DEFAULT, googleConsentState, metaConsentAction } from '@/lib/analytics/consent';
import { isProductionHost, tagScripts } from '@/lib/analytics/tags';

const ALL = {
  [ANALYTICS_GA_ID_KEY]: 'G-ABC1234567',
  [ANALYTICS_GTM_ID_KEY]: 'GTM-ABCD123',
  [ANALYTICS_GA4_VIA_GTM_KEY]: 'off',
  [MARKETING_META_PIXEL_ID_KEY]: '123456789012345',
  [MARKETING_META_PIXEL_VIA_GTM_KEY]: 'off',
  [MARKETING_META_DOMAIN_VERIFICATION_KEY]: 'abcdef0123456789abcdef',
};

const plan = (over: Record<string, unknown> = {}) => marketingLoadPlan(resolveMarketingConfig({ ...ALL, ...over }));

describe('marketingLoadPlan', () => {
  test('everything direct: GTM, gtag and the Pixel all load', () => {
    const p = plan();
    assert.equal(p.gtmId, 'GTM-ABCD123');
    assert.equal(p.gtagId, 'G-ABC1234567');
    assert.equal(p.pixelId, '123456789012345');
  });

  test('GA4 via GTM: the CMS does not load gtag and hands the ID to the dataLayer', () => {
    const p = plan({ [ANALYTICS_GA4_VIA_GTM_KEY]: 'on' });
    assert.equal(p.gtagId, null);
    assert.equal(p.dataLayerIds.cms_ga4_id, 'G-ABC1234567');
  });

  test('Pixel via GTM: the CMS does not load fbevents and hands the ID to the dataLayer', () => {
    const p = plan({ [MARKETING_META_PIXEL_VIA_GTM_KEY]: 'on' });
    assert.equal(p.pixelId, null);
    assert.equal(p.dataLayerIds.cms_meta_pixel_id, '123456789012345');
  });

  test('"via GTM" without a container loads directly, so the site is not left unmeasured', () => {
    const p = plan({ [ANALYTICS_GTM_ID_KEY]: '', [ANALYTICS_GA4_VIA_GTM_KEY]: 'on', [MARKETING_META_PIXEL_VIA_GTM_KEY]: 'on' });
    assert.equal(p.gtmId, null);
    assert.equal(p.gtagId, 'G-ABC1234567');
    assert.equal(p.pixelId, '123456789012345');
  });

  test('nothing configured: nothing loads and no third-party host is needed', () => {
    const p = marketingLoadPlan(resolveMarketingConfig({}));
    assert.deepEqual([p.gtmId, p.gtagId, p.pixelId], [null, null, null]);
    assert.equal(p.googleHosts, false);
    assert.equal(p.metaHosts, false);
  });

  test('Meta hosts are needed whenever a Pixel ID is set, directly or via GTM', () => {
    assert.equal(plan().metaHosts, true);
    assert.equal(plan({ [MARKETING_META_PIXEL_VIA_GTM_KEY]: 'on' }).metaHosts, true);
    assert.equal(plan({ [MARKETING_META_PIXEL_ID_KEY]: '' }).metaHosts, false);
  });

  test('a stored value that is not a valid ID reads as unset', () => {
    const p = plan({ [ANALYTICS_GTM_ID_KEY]: "GTM-X'};alert(1)//", [MARKETING_META_PIXEL_ID_KEY]: '12ab' });
    assert.equal(p.gtmId, null);
    assert.equal(p.pixelId, null);
  });

  test('the domain verification code passes through only when well-formed', () => {
    assert.equal(resolveMarketingConfig(ALL).metaDomainVerification, 'abcdef0123456789abcdef');
    assert.equal(resolveMarketingConfig({ ...ALL, [MARKETING_META_DOMAIN_VERIFICATION_KEY]: '"><script>' }).metaDomainVerification, null);
  });
});

describe('settings: Analytics & Marketing', () => {
  const def = (key: string) => MANAGED_SETTINGS.find((d) => d.key === key);

  test('every field lives in the Analytics & Marketing tab', () => {
    for (const key of [
      ANALYTICS_GA_ID_KEY,
      ANALYTICS_GTM_ID_KEY,
      ANALYTICS_GA4_VIA_GTM_KEY,
      MARKETING_META_PIXEL_ID_KEY,
      MARKETING_META_PIXEL_VIA_GTM_KEY,
      MARKETING_META_DOMAIN_VERIFICATION_KEY,
    ]) {
      assert.equal(def(key)?.group, 'Analytics & Marketing', key);
    }
  });

  test('the "via GTM" switches are booleans', () => {
    assert.equal(def(ANALYTICS_GA4_VIA_GTM_KEY)?.type, 'boolean');
    assert.equal(def(MARKETING_META_PIXEL_VIA_GTM_KEY)?.type, 'boolean');
  });

  const cases: Array<[string, string[], string[]]> = [
    [ANALYTICS_GTM_ID_KEY, ['GTM-ABCD123', 'gtm-abcd12'], ['GTM-', "GTM-AB'CD", 'G-ABC123', 'GTM-ABC D']],
    [MARKETING_META_PIXEL_ID_KEY, ['123456789012345', '1234567890'], ['12ab', '1"2', '123']],
    [MARKETING_META_DOMAIN_VERIFICATION_KEY, ['abcdef0123456789abcdef'], ['"><script>', 'short', 'has space here 123']],
  ];
  for (const [key, good, bad] of cases) {
    test(`${key} accepts only the real format`, () => {
      for (const v of good) assert.equal(validateSettingValue(key, def(key), v).ok, true, v);
      for (const v of bad) assert.equal(validateSettingValue(key, def(key), v).ok, false, v);
      assert.equal(validateSettingValue(key, def(key), '').ok, true, 'empty clears it');
    });
  }
});

describe('Consent Mode v2', () => {
  test('the default denies everything and waits 500 ms for an update', () => {
    assert.deepEqual(CONSENT_DEFAULT, {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      wait_for_update: 500,
    });
  });

  test('"Analytics" grants analytics_storage only', () => {
    assert.deepEqual(googleConsentState({ analytics: true, marketing: false }), {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
  });

  test('"Marketing" grants the three ad signals', () => {
    assert.deepEqual(googleConsentState({ analytics: false, marketing: true }), {
      analytics_storage: 'denied',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    });
  });

  test('Meta follows Marketing', () => {
    assert.equal(metaConsentAction(true), 'grant');
    assert.equal(metaConsentAction(false), 'revoke');
  });
});

describe('tagScripts', () => {
  const none = { analytics: false, marketing: false };
  const both = { analytics: true, marketing: true };
  const joined = (scripts: ReturnType<typeof tagScripts>) =>
    scripts.map((s) => `${s.src ?? ''}\n${s.inline ?? ''}`).join('\n');

  test('before consent: no script at all', () => {
    assert.deepEqual(tagScripts(plan(), none), []);
  });

  test('the consent default is the first thing, before any Google tag', () => {
    const scripts = tagScripts(plan(), both);
    assert.match(scripts[0].inline ?? '', /gtag\('consent', ?'default'/);
    assert.ok(scripts[0].inline!.indexOf("'default'") < scripts[0].inline!.indexOf("'update'"));
  });

  test('GTM loads with analytics OR marketing consent', () => {
    assert.match(joined(tagScripts(plan(), { analytics: true, marketing: false })), /googletagmanager\.com\/gtm\.js/);
    assert.match(joined(tagScripts(plan(), { analytics: false, marketing: true })), /googletagmanager\.com\/gtm\.js/);
  });

  test('gtag loads only with analytics consent, and not at all when GA4 goes via GTM', () => {
    assert.match(joined(tagScripts(plan(), { analytics: true, marketing: false })), /gtag\/js\?id=G-ABC1234567/);
    assert.doesNotMatch(joined(tagScripts(plan(), { analytics: false, marketing: true })), /gtag\/js/);
    assert.doesNotMatch(joined(tagScripts(plan({ [ANALYTICS_GA4_VIA_GTM_KEY]: 'on' }), both)), /gtag\/js/);
  });

  test('the Pixel loads only with marketing consent, and not at all when it goes via GTM', () => {
    assert.match(joined(tagScripts(plan(), both)), /connect\.facebook\.net\/en_US\/fbevents\.js/);
    assert.doesNotMatch(joined(tagScripts(plan(), { analytics: true, marketing: false })), /fbevents/);
    assert.doesNotMatch(joined(tagScripts(plan({ [MARKETING_META_PIXEL_VIA_GTM_KEY]: 'on' }), both)), /fbevents/);
  });

  test('the Pixel is granted before init', () => {
    const pixel = joined(tagScripts(plan(), both));
    assert.ok(pixel.indexOf("fbq('consent', 'grant')") < pixel.indexOf("fbq('init'"));
  });

  test('the dataLayer IDs are pushed before GTM loads', () => {
    const js = joined(tagScripts(plan({ [ANALYTICS_GA4_VIA_GTM_KEY]: 'on' }), both));
    assert.ok(js.indexOf('cms_ga4_id') > -1);
    assert.ok(js.indexOf('cms_ga4_id') < js.indexOf('gtm.js'));
  });

  test('with the page_view switches off, the tags do not send their own entry page view', () => {
    const js = joined(tagScripts(plan(), both, { pageView: { ga4: false, meta: false } }));
    assert.match(js, /send_page_view: false/);
    assert.doesNotMatch(js, /fbq\('track', 'PageView'\)/);
    const on = joined(tagScripts(plan(), both));
    assert.doesNotMatch(on, /send_page_view/);
    assert.match(on, /fbq\('track', 'PageView'\)/);
  });

  test('no noscript, no iframe, no tracking image', () => {
    const js = joined(tagScripts(plan(), both));
    assert.doesNotMatch(js, /noscript|iframe|<img/i);
  });

  test('IDs are written as escaped literals, whatever is stored', () => {
    const p = { ...plan(), gtmId: 'GTM-</script><script>alert(1)' };
    assert.doesNotMatch(joined(tagScripts(p, both)), /<\/script>/);
  });
});

describe('isProductionHost', () => {
  const site = 'https://example.gr';
  test('the apex and www load tags', () => {
    assert.equal(isProductionHost('example.gr', site), true);
    assert.equal(isProductionHost('www.example.gr', site), true);
    assert.equal(isProductionHost('example.gr', 'https://www.example.gr'), true);
  });
  test('staging, preview and localhost do not', () => {
    assert.equal(isProductionHost('staging.example.gr', site), false);
    assert.equal(isProductionHost('localhost', site), false);
    assert.equal(isProductionHost('example.gr.evil.com', site), false);
  });
  test('an unset or broken site URL loads nothing', () => {
    assert.equal(isProductionHost('example.gr', ''), false);
    assert.equal(isProductionHost('example.gr', 'not a url'), false);
  });
});
