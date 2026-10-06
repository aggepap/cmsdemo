/**
 * Per-route security headers (REQ-2).
 *
 * The pages that can carry a form with reCAPTCHA need a looser policy than the
 * rest of the site: no `Cross-Origin-Embedder-Policy` (the challenge iframe does
 * not opt in to it, and Firefox/Safari refuse it outright) and the Google hosts
 * in the CSP. Everything else — checkout, cart, account, the API, the admin —
 * must keep the strict policy.
 *
 * Matched with Next's OWN matcher (`getPathMatch`, strict, the way it evaluates
 * `headers()` sources), not a hand-rolled regex: a pattern that looks right in
 * `path-to-regexp` can still behave differently once Next compiles it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

import { buildHeaderRules, type HeaderRule } from '@/cms/core/security/headers';

const LOCALES = ['el', 'en'] as const;

/** What a browser receives for `path`: Next applies matching rules in order with `setHeader`. */
function headersFor(rules: HeaderRule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r) => r });
    if (match(path) === false) continue;
    for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

const prod = buildHeaderRules({ dev: false, adminSegment: 'admin', locales: LOCALES });
const dev = buildHeaderRules({ dev: true, adminSegment: 'admin', locales: LOCALES });

function isRelaxed(rules: HeaderRule[], path: string): boolean {
  const h = headersFor(rules, path);
  return h['cross-origin-embedder-policy'] === 'unsafe-none';
}

describe('form pages get the third-party policy', () => {
  for (const path of ['/', '/contact', '/about-us', '/en', '/el', '/en/contact', '/en/about-us', '/shopping-guide', '/carts-and-bikes']) {
    test(`${path} drops COEP and allows reCAPTCHA in the CSP`, () => {
      const h = headersFor(prod, path);
      assert.equal(h['cross-origin-embedder-policy'], 'unsafe-none');
      assert.match(h['content-security-policy'], /script-src [^;]*https:\/\/www\.google\.com/);
      assert.match(h['content-security-policy'], /script-src [^;]*https:\/\/www\.gstatic\.com/);
      assert.match(h['content-security-policy'], /frame-src [^;]*https:\/\/www\.google\.com/);
      assert.match(h['content-security-policy'], /connect-src [^;]*https:\/\/www\.google\.com/);
    });
  }
});

describe('fixed routes keep the strict policy', () => {
  const fixed = [
    '/checkout',
    '/checkout/success',
    '/en/checkout',
    '/cart',
    '/en/cart',
    '/account',
    '/account/orders',
    '/en/account/orders',
    '/order/123',
    '/shop',
    '/shop/some-product',
    '/en/shop/some-product',
    '/booking',
    '/booking/pay',
    '/wishlist',
    '/legal/cookies',
    '/page-not-found',
    '/api/contact',
    '/api',
    '/blog/some-post',
  ];
  for (const path of fixed) {
    test(`${path} keeps COEP credentialless and no reCAPTCHA hosts`, () => {
      const h = headersFor(prod, path);
      assert.equal(h['cross-origin-embedder-policy'], 'credentialless');
      assert.doesNotMatch(h['content-security-policy'], /www\.gstatic\.com/);
      assert.doesNotMatch(h['content-security-policy'], /frame-src [^;]*www\.google\.com/);
    });
  }

  test('static files are never treated as a page', () => {
    assert.equal(isRelaxed(prod, '/logo.svg'), false);
    assert.equal(isRelaxed(prod, '/_next/static/chunk.js'), false);
  });
});

describe('the admin', () => {
  test('keeps its own policy — COEP off, reCAPTCHA allowed — at the default segment', () => {
    for (const path of ['/admin', '/admin/login', '/admin/settings/security']) {
      const h = headersFor(prod, path);
      assert.equal(h['cross-origin-embedder-policy'], 'unsafe-none', path);
      assert.match(h['content-security-policy'], /www\.gstatic\.com/, path);
    }
  });

  test('a moved admin segment is excluded from the site rules and gets the admin policy', () => {
    const moved = buildHeaderRules({ dev: false, adminSegment: 'backoffice', locales: LOCALES });
    const h = headersFor(moved, '/backoffice/login');
    assert.equal(h['cross-origin-embedder-policy'], 'unsafe-none');
    // The literal `/admin` is still a fixed route — the proxy answers it with 404.
    assert.equal(isRelaxed(moved, '/admin'), false);
  });
});

describe('every response', () => {
  test('carries the baseline headers, page or not', () => {
    for (const path of ['/', '/checkout', '/api/contact', '/admin/login']) {
      const h = headersFor(prod, path);
      assert.equal(h['x-content-type-options'], 'nosniff', path);
      assert.equal(h['x-frame-options'], 'DENY', path);
      assert.equal(h['cross-origin-opener-policy'], 'same-origin', path);
    }
  });

  test('frame-ancestors stays none even where frames are allowed in', () => {
    assert.match(headersFor(prod, '/contact')['content-security-policy'], /frame-ancestors 'none'/);
  });

  test('development sends no CSP at all, but still relaxes COEP on form pages', () => {
    assert.equal(headersFor(dev, '/contact')['content-security-policy'], undefined);
    assert.equal(headersFor(dev, '/checkout')['content-security-policy'], undefined);
    assert.equal(isRelaxed(dev, '/contact'), true);
    assert.equal(isRelaxed(dev, '/checkout'), false);
  });
});
