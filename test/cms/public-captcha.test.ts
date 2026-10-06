/**
 * reCAPTCHA on the PUBLIC forms (REQ-1).
 *
 * The admin login already had the pieces; the public contact form did not, and a
 * site that needed one had to wire it in by hand. These tests pin the two rules
 * that make the public box safe to show:
 *
 *   - a site key is handed to the browser only when the server can actually check
 *     what the widget produces — never a box nobody verifies;
 *   - Google's public TEST keys (which pass every token) are refused in
 *     production, so a copied `.env.example` cannot pose as a working bot check.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  captchaEnabled,
  captchaSiteKey,
  GOOGLE_TEST_SECRET_KEY,
  GOOGLE_TEST_SITE_KEY,
  publicCaptchaSiteKey,
  usingGoogleTestKeysInProduction,
  verifyCaptchaToken,
} from '@/cms/core/security/captcha';
import { captchaScriptSrc } from '@/cms/admin/ui/Captcha';

const SITE = 'RECAPTCHA_SITE_KEY';
const SECRET = 'RECAPTCHA_SECRET_KEY';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined) {
  Object.assign(process.env, { NODE_ENV: value });
}

afterEach(() => {
  delete process.env[SITE];
  delete process.env[SECRET];
  setNodeEnv(ORIGINAL_NODE_ENV);
});

const forbiddenFetch: typeof fetch = () => {
  throw new Error('fetch must not be called');
};

describe('publicCaptchaSiteKey', () => {
  test('returns the site key when both keys are set', () => {
    process.env[SITE] = 'real-site';
    process.env[SECRET] = 'real-secret';
    assert.equal(publicCaptchaSiteKey(), 'real-site');
  });

  test('returns null when the secret is missing — never a box the server does not check', () => {
    process.env[SITE] = 'real-site';
    assert.equal(publicCaptchaSiteKey(), null);
  });

  test('returns null when nothing is configured', () => {
    assert.equal(publicCaptchaSiteKey(), null);
  });
});

describe('Google test keys', () => {
  test('are the published public test pair', () => {
    // Google's documented test site key. The request doc quoted a different
    // string; this is the one Google actually publishes and `.env.example` uses.
    assert.equal(GOOGLE_TEST_SITE_KEY, '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI');
    assert.equal(GOOGLE_TEST_SECRET_KEY, '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe');
  });

  test('work outside production, so tests and dev exercise the real widget', () => {
    setNodeEnv('test');
    process.env[SITE] = GOOGLE_TEST_SITE_KEY;
    process.env[SECRET] = GOOGLE_TEST_SECRET_KEY;
    assert.equal(usingGoogleTestKeysInProduction(), false);
    assert.equal(captchaEnabled(), true);
    assert.equal(publicCaptchaSiteKey(), GOOGLE_TEST_SITE_KEY);
  });

  test('are refused in production: no widget is offered', () => {
    setNodeEnv('production');
    process.env[SITE] = GOOGLE_TEST_SITE_KEY;
    process.env[SECRET] = GOOGLE_TEST_SECRET_KEY;
    assert.equal(usingGoogleTestKeysInProduction(), true);
    assert.equal(captchaEnabled(), false);
    assert.equal(publicCaptchaSiteKey(), null);
    assert.equal(captchaSiteKey(), null);
  });

  test('either test key alone is enough to be refused in production', () => {
    setNodeEnv('production');
    process.env[SITE] = 'real-site';
    process.env[SECRET] = GOOGLE_TEST_SECRET_KEY;
    assert.equal(usingGoogleTestKeysInProduction(), true);
    assert.equal(captchaEnabled(), false);
  });

  test('in production, verification does not call Google with the test secret', async () => {
    setNodeEnv('production');
    process.env[SITE] = GOOGLE_TEST_SITE_KEY;
    process.env[SECRET] = GOOGLE_TEST_SECRET_KEY;
    const result = await verifyCaptchaToken('any-token', forbiddenFetch);
    assert.equal(result.reason, 'test-keys-in-production');
  });
});

describe('captchaScriptSrc', () => {
  test('loads the explicit-render API', () => {
    const src = new URL(captchaScriptSrc());
    assert.equal(src.origin + src.pathname, 'https://www.google.com/recaptcha/api.js');
    assert.equal(src.searchParams.get('render'), 'explicit');
  });

  test('passes the page language to the widget as `hl`', () => {
    assert.equal(new URL(captchaScriptSrc('el')).searchParams.get('hl'), 'el');
    assert.equal(new URL(captchaScriptSrc('en')).searchParams.get('hl'), 'en');
  });

  test('omits `hl` when no language is given, and encodes what it is given', () => {
    assert.equal(new URL(captchaScriptSrc()).searchParams.has('hl'), false);
    assert.equal(new URL(captchaScriptSrc('pt-BR&x=1')).searchParams.get('hl'), 'pt-BR&x=1');
  });
});
