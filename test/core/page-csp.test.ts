/**
 * The page CSP built per request by the proxy (REQ-5 §1, CSP tests).
 *
 * Google and Meta hosts appear ONLY while their ID is set — an empty setting
 * leaves the strict policy with no tracking host in it. And no tracking host
 * ever gets `frame-src`: the only iframe the site allows is reCAPTCHA's.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

import {
  buildHeaderRules,
  isThirdPartyPagePath,
  pageCsp,
  strictCsp,
} from '@/cms/core/security/headers';

const LOCALES = ['el', 'en'] as const;

function directive(csp: string, name: string): string {
  return csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
}

describe('pageCsp', () => {
  test('with no ID set there is no Google or Meta host anywhere', () => {
    const csp = pageCsp({ thirdParty: false, google: false, meta: false });
    assert.doesNotMatch(csp, /google|facebook|doubleclick/);
  });

  test('the strict static CSP carries no tracking host either', () => {
    assert.doesNotMatch(strictCsp(), /googletagmanager|google-analytics|facebook/);
  });

  test('Google hosts are added when a Google ID is set', () => {
    const csp = pageCsp({ thirdParty: false, google: true, meta: false });
    assert.match(directive(csp, 'script-src'), /https:\/\/www\.googletagmanager\.com/);
    for (const host of ['https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://googleads.g.doubleclick.net']) {
      assert.ok(directive(csp, 'connect-src').includes(host), host);
      assert.ok(directive(csp, 'img-src').includes(host), host);
    }
    assert.doesNotMatch(csp, /facebook/);
  });

  test('Google Ads conversions (through GTM) can reach their endpoints', () => {
    const csp = pageCsp({ thirdParty: false, google: true, meta: false });
    for (const d of ['script-src', 'img-src', 'connect-src']) {
      assert.ok(directive(csp, d).includes('https://www.googleadservices.com'), d);
    }
    for (const d of ['img-src', 'connect-src']) assert.ok(directive(csp, d).includes('https://www.google.com'), d);
  });

  test('Meta hosts are added when a Pixel ID is set', () => {
    const csp = pageCsp({ thirdParty: false, google: false, meta: true });
    assert.match(directive(csp, 'script-src'), /https:\/\/connect\.facebook\.net/);
    assert.match(directive(csp, 'img-src'), /https:\/\/www\.facebook\.com/);
    assert.match(directive(csp, 'connect-src'), /https:\/\/www\.facebook\.com/);
    assert.doesNotMatch(csp, /googletagmanager/);
  });

  test('no tracking host is ever allowed to frame — only reCAPTCHA on form pages', () => {
    assert.equal(directive(pageCsp({ thirdParty: false, google: true, meta: true }), 'frame-src'), '');
    assert.equal(
      directive(pageCsp({ thirdParty: true, google: true, meta: true }), 'frame-src'),
      "frame-src 'self' https://www.google.com",
    );
  });

  test('form pages keep the reCAPTCHA allowances alongside the tracking hosts', () => {
    const csp = pageCsp({ thirdParty: true, google: true, meta: true });
    assert.match(directive(csp, 'script-src'), /www\.gstatic\.com/);
    assert.match(directive(csp, 'script-src'), /connect\.facebook\.net/);
  });

  test('every directive appears once', () => {
    const names = pageCsp({ thirdParty: true, google: true, meta: true })
      .split('; ')
      .map((d) => d.split(' ')[0]);
    assert.equal(new Set(names).size, names.length);
  });
});

describe('isThirdPartyPagePath agrees with the next.config sources', () => {
  const rules = buildHeaderRules({ dev: false, adminSegment: 'admin', locales: LOCALES });
  const thirdPartySources = rules.slice(1, 3).map((r) => r.source);
  const matchers = thirdPartySources.map((s) =>
    getPathMatch(s, { strict: true, removeUnnamedParams: true, regexModifier: (r) => r }),
  );
  const paths = [
    '/', '/contact', '/en', '/en/contact', '/about-us', '/shopping-guide',
    '/checkout', '/en/checkout', '/cart', '/account/orders', '/shop', '/shop/x',
    '/booking/pay', '/legal/cookies', '/blog/post', '/order/1', '/en/legal/privacy',
    '/admin', '/api/x', '/wishlist', '/page-not-found',
  ];
  for (const path of paths) {
    test(path, () => {
      const expected = matchers.some((m) => m(path) !== false);
      assert.equal(isThirdPartyPagePath(path, LOCALES, 'admin'), expected);
    });
  }
});
