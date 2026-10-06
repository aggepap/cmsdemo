import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ANNOUNCEMENT_KEY,
  ANNOUNCEMENT_TEXT_MAX,
  resolveAnnouncement,
} from '@/cms/core/settings/announcement';
import { EXTRA_MANAGED_KEYS } from '@/cms/core/settings/schema';
import { validateSettingValue } from '@/cms/core/settings/validate';
import { REF_FREE_STRUCTURED } from '@/cms/core/transfer/settings-refs';

/**
 * The announcement bar: one short line above the header, set in Settings.
 *
 * Plain text, one optional link, optionally dismissible. The link is the only
 * part that can do harm, so it is held to the same rule as the menus — a path
 * on this site or an https URL — at the write boundary, not just on render.
 */

const valid = {
  enabled: true,
  text: { el: 'Δωρεάν αποστολή άνω των 50 €', en: 'Free delivery over €50' },
  href: '/shop',
  dismissible: true,
};

const check = (value: unknown) => validateSettingValue(ANNOUNCEMENT_KEY, undefined, value);

describe('announcement setting — write boundary', () => {
  test('is a managed key the settings API accepts', () => {
    assert.ok(EXTRA_MANAGED_KEYS.includes(ANNOUNCEMENT_KEY));
  });

  test('holds no media or document ids, so it travels as it is', () => {
    assert.ok(REF_FREE_STRUCTURED.has(ANNOUNCEMENT_KEY));
  });

  test('accepts a complete announcement, trimmed', () => {
    const result = check({ ...valid, text: { el: '  Γεια  ', en: 'Hi' } });
    assert.ok(result.ok);
    assert.deepEqual((result as { value: { text: unknown } }).value.text, { el: 'Γεια', en: 'Hi' });
  });

  test('accepts an internal path, an https URL, or no link', () => {
    for (const href of ['', '/shop', '/el/offers?x=1#top', 'https://example.com/sale']) {
      assert.ok(check({ ...valid, href }).ok, href);
    }
  });

  test('refuses any other link', () => {
    for (const href of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'http://example.com',
      '//evil.com',
      '/\\evil.com',
      'data:text/html,x',
      'shop',
      'https://',
    ]) {
      assert.equal(check({ ...valid, href }).ok, false, href);
    }
  });

  test('refuses text over the length limit, or with line breaks', () => {
    assert.equal(check({ ...valid, text: { el: 'x'.repeat(ANNOUNCEMENT_TEXT_MAX + 1) } }).ok, false);
    assert.equal(check({ ...valid, text: { el: 'one\ntwo' } }).ok, false);
  });

  test('refuses a locale key that is not a locale, and unknown fields', () => {
    assert.equal(check({ ...valid, text: { '<b>': 'x' } }).ok, false);
    assert.equal(check({ ...valid, html: '<b>x</b>' }).ok, false);
  });
});

describe('resolveAnnouncement', () => {
  test('nothing when unset, disabled, or empty', () => {
    assert.equal(resolveAnnouncement(null, 'el', 'el'), null);
    assert.equal(resolveAnnouncement({ ...valid, enabled: false }, 'el', 'el'), null);
    assert.equal(resolveAnnouncement({ ...valid, text: { el: ' ', en: '' } }, 'el', 'el'), null);
    assert.equal(resolveAnnouncement('garbage', 'el', 'el'), null);
  });

  test('the text for the visitor’s language, falling back to the main language', () => {
    assert.equal(resolveAnnouncement(valid, 'en', 'el')?.text, 'Free delivery over €50');
    assert.equal(resolveAnnouncement({ ...valid, text: { el: 'Γεια' } }, 'en', 'el')?.text, 'Γεια');
  });

  test('an unsafe link that got into the database anyway is dropped on read', () => {
    const resolved = resolveAnnouncement({ ...valid, href: 'javascript:alert(1)' }, 'el', 'el');
    assert.ok(resolved);
    assert.equal(resolved.href, null);
  });

  test('a link to another site is marked external', () => {
    assert.equal(resolveAnnouncement(valid, 'el', 'el')?.external, false);
    assert.equal(
      resolveAnnouncement({ ...valid, href: 'https://example.com' }, 'el', 'el')?.external,
      true,
    );
  });

  test('the dismissal id changes when the message changes, so a new message shows again', () => {
    const a = resolveAnnouncement(valid, 'el', 'el');
    const same = resolveAnnouncement({ ...valid }, 'el', 'el');
    const edited = resolveAnnouncement({ ...valid, text: { ...valid.text, en: 'Sale!' } }, 'el', 'el');
    const relinked = resolveAnnouncement({ ...valid, href: '/sale' }, 'el', 'el');
    assert.ok(a?.id);
    assert.equal(a.id, same?.id);
    assert.notEqual(a.id, edited?.id);
    assert.notEqual(a.id, relinked?.id);
  });

  test('the dismissal id is the same in every language, so dismissing once is enough', () => {
    assert.equal(resolveAnnouncement(valid, 'el', 'el')?.id, resolveAnnouncement(valid, 'en', 'el')?.id);
  });
});
