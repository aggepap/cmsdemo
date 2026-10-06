/**
 * The captcha on the booking request form (REQ-1, second form).
 *
 * `db749c5` put the public-forms captcha on the contact form only. The booking
 * request is the other public form, and the same switch (Settings → Security →
 * "Captcha on public forms") must govern it: on, a request without a verified
 * token is refused before anything is priced or stored; off, nothing changes.
 * The experience page carries the form, so it needs the third-party headers —
 * while the lookup and pay pages under `/booking` keep the strict ones.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

import { createRoute } from '@/cms/core/api/handler';
import {
  buildHeaderRules,
  isThirdPartyPagePath,
  type HeaderRule,
} from '@/cms/core/security/headers';

const LOCALES = ['el', 'en'] as const;
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

let seq = 0;
const scope = () => `test-booking-captcha-${++seq}`;

function post(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/cms/booking/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.8', ...headers },
    body: JSON.stringify({}),
  });
}

beforeEach(() => {
  process.env.RECAPTCHA_SITE_KEY = 'site-key';
  process.env.RECAPTCHA_SECRET_KEY = 'secret-key';
});
afterEach(() => {
  delete process.env.RECAPTCHA_SITE_KEY;
  delete process.env.RECAPTCHA_SECRET_KEY;
});

describe('createRoute captcha `when`', () => {
  test('switched on: a request without a token never reaches the handler', async () => {
    let ran = false;
    const route = createRoute({
      sameOrigin: false,
      captcha: {
        rateLimit: { scope: scope(), max: 100, windowMs: 60_000 },
        when: async () => true,
      },
      handler: () => {
        ran = true;
        return { ok: true };
      },
    });
    const res = await route(post());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'captcha_failed');
    assert.equal(ran, false);
  });

  test('switched off: the request goes straight to the handler, even with keys set', async () => {
    const route = createRoute({
      sameOrigin: false,
      captcha: {
        rateLimit: { scope: scope(), max: 100, windowMs: 60_000 },
        when: async () => false,
      },
      handler: () => ({ reached: true }),
    });
    const res = await route(post());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reached: true });
  });
});

describe('the booking request route', () => {
  const reservations = source('src/cms/modules/booking/reservations.ts');
  const body = reservations.slice(reservations.indexOf('export function bookingRequestRoute'));

  test('asks for the captcha exactly when the public forms do', () => {
    assert.match(body.slice(0, body.indexOf('handler:')), /captcha: \{/);
    assert.match(body.slice(0, body.indexOf('handler:')), /publicFormsCaptchaSiteKey\(\)/);
  });
});

describe('the booking form', () => {
  test('the experience page hands the site key to the form', () => {
    const page = source('src/app/[locale]/booking/[slug]/page.tsx');
    assert.match(page, /publicFormsCaptchaSiteKey\(\)/);
    assert.match(page, /captchaSiteKey=\{/);
  });

  test('the form shows the widget and sends its token', () => {
    const form = source('src/components/booking/BookingForm.tsx');
    assert.match(form, /<PublicCaptcha/);
    assert.match(form, /'x-captcha-token'/);
  });
});

describe('headers under /booking', () => {
  const prod = buildHeaderRules({ dev: false, adminSegment: 'admin', locales: LOCALES });

  function coep(rules: HeaderRule[], path: string): string | undefined {
    let value: string | undefined;
    for (const rule of rules) {
      const match = getPathMatch(rule.source, {
        strict: true,
        removeUnnamedParams: true,
        regexModifier: (r) => r,
      });
      if (match(path) === false) continue;
      for (const h of rule.headers) if (h.key === 'Cross-Origin-Embedder-Policy') value = h.value;
    }
    return value;
  }

  for (const path of [
    '/booking/sunset-cruise',
    '/en/booking/sunset-cruise',
    '/el/booking/villa-mare',
  ]) {
    test(`${path} carries the form, so it gets the third-party policy`, () => {
      assert.equal(coep(prod, path), 'unsafe-none');
      assert.equal(isThirdPartyPagePath(path, LOCALES, 'admin'), true);
    });
  }

  for (const path of [
    '/booking',
    '/en/booking',
    '/booking/lookup',
    '/en/booking/lookup',
    '/booking/pay',
    '/booking/pay/BKG-2026-ABCD1234',
    '/en/booking/pay/BKG-2026-ABCD1234',
  ]) {
    test(`${path} has no form with a captcha, so it stays strict`, () => {
      assert.equal(coep(prod, path), 'credentialless');
      assert.equal(isThirdPartyPagePath(path, LOCALES, 'admin'), false);
    });
  }
});
