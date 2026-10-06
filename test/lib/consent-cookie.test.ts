/**
 * The banner's answer, mirrored into a first-party cookie the SERVER can read
 * (REQ-5 §6): without it, the Conversions API could not know whether a visitor
 * allowed Marketing, and must then send nothing.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONSENT_COOKIE, consentCookieHeader, consentCookieValue } from '@/cms/core/analytics/consent-cookie';

describe('consentCookieValue', () => {
  test('the granted categories, in a stable order', () => {
    assert.equal(consentCookieValue('custom', { marketing: true, analytics: true, necessary: true }), 'analytics,marketing');
    assert.equal(consentCookieValue('custom', { analytics: true, marketing: false }), 'analytics');
  });

  test('"accept all" with no categories declared grants both', () => {
    assert.equal(consentCookieValue('accepted', {}), 'analytics,marketing');
  });

  test('a refusal grants nothing', () => {
    assert.equal(consentCookieValue('rejected', { analytics: true }), '');
  });
});

describe('consentCookieHeader', () => {
  test('first-party, a year, Lax, Secure on https', () => {
    assert.equal(
      consentCookieHeader('analytics,marketing', true),
      `${CONSENT_COOKIE}=analytics%2Cmarketing; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    assert.doesNotMatch(consentCookieHeader('', false), /Secure/);
  });
});
