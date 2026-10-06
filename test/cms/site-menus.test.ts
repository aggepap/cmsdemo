import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isSiteLinkHref } from '@/cms/core/settings/links';
import { MENUS_KEY, MENU_LIMITS, resolveMenu } from '@/cms/core/settings/menus';
import { EXTRA_MANAGED_KEYS } from '@/cms/core/settings/schema';
import { validateSettingValue } from '@/cms/core/settings/validate';
import { REF_FREE_STRUCTURED } from '@/cms/core/transfer/settings-refs';

/**
 * Header and footer menus edited in Settings → Menus.
 *
 * Unset — or saved empty — means "the menu the site's code defines", so an
 * existing site looks exactly as it did until somebody builds a menu. An href
 * is a path on this site or an https URL, refused at the write boundary
 * otherwise. The header may nest one level; the footer is flat.
 */

const item = (label: string, href: string, extra: Record<string, unknown> = {}) => ({
  label: { el: label, en: `${label} (en)` },
  href,
  newTab: false,
  ...extra,
});

const check = (value: unknown) => validateSettingValue(MENUS_KEY, undefined, value);

describe('isSiteLinkHref', () => {
  test('a path on this site or an https URL', () => {
    for (const href of ['/', '/about', '/el/blog/post?page=2#x', 'https://example.com', 'https://example.com/a?b=c']) {
      assert.equal(isSiteLinkHref(href), true, href);
    }
  });

  test('nothing else', () => {
    for (const href of [
      '',
      'about',
      '//evil.com',
      '/\\evil.com',
      '/\tjavascript:alert(1)',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'http://example.com',
      'https://',
      'https:///path',
      'data:text/html,x',
      'mailto:a@b.gr',
      '/a b',
      `/${'x'.repeat(600)}`,
    ]) {
      assert.equal(isSiteLinkHref(href), false, href);
    }
  });
});

describe('menus setting — write boundary', () => {
  test('is a managed key, and travels as it is', () => {
    assert.ok(EXTRA_MANAGED_KEYS.includes(MENUS_KEY));
    assert.ok(REF_FREE_STRUCTURED.has(MENUS_KEY));
  });

  test('accepts a header with one level of children and a flat footer', () => {
    const result = check({
      header: [item('Αρχική', '/'), item('Υπηρεσίες', '/services', { children: [item('Web', '/services/web')] })],
      footer: [item('Blog', 'https://blog.example.com', { newTab: true })],
    });
    assert.ok(result.ok, JSON.stringify(result));
  });

  test('accepts empty menus (= use the built-in menu)', () => {
    assert.ok(check({ header: [], footer: [] }).ok);
  });

  test('refuses an unsafe href anywhere, including in a child', () => {
    assert.equal(check({ header: [item('x', 'javascript:alert(1)')], footer: [] }).ok, false);
    assert.equal(
      check({ header: [item('x', '/', { children: [item('y', '//evil.com')] })], footer: [] }).ok,
      false,
    );
    assert.equal(check({ header: [], footer: [item('x', 'http://a.com')] }).ok, false);
  });

  test('refuses a second level of nesting, and children in the footer', () => {
    const deep = item('a', '/', { children: [item('b', '/b', { children: [item('c', '/c')] })] });
    assert.equal(check({ header: [deep], footer: [] }).ok, false);
    assert.equal(check({ header: [], footer: [item('a', '/', { children: [item('b', '/b')] })] }).ok, false);
  });

  test('refuses an item with no label in any language', () => {
    assert.equal(check({ header: [{ label: { el: ' ' }, href: '/', newTab: false }], footer: [] }).ok, false);
  });

  test('refuses more items than a menu can sensibly hold', () => {
    const many = Array.from({ length: MENU_LIMITS.header + 1 }, (_, i) => item(`i${i}`, `/p${i}`));
    assert.equal(check({ header: many, footer: [] }).ok, false);
  });

  test('refuses unknown fields', () => {
    assert.equal(check({ header: [{ ...item('a', '/'), onclick: 'x' }], footer: [] }).ok, false);
  });
});

describe('resolveMenu', () => {
  const stored = {
    header: [
      item('Αρχική', '/'),
      item('Υπηρεσίες', '/services', { children: [item('Web', '/services/web', { newTab: true })] }),
      item('Blog', 'https://blog.example.com'),
    ],
    footer: [item('Όροι', '/terms')],
  };

  test('null when unset, malformed, or empty — the caller then uses the built-in menu', () => {
    assert.equal(resolveMenu(null, 'header', 'el', 'el'), null);
    assert.equal(resolveMenu('nope', 'header', 'el', 'el'), null);
    assert.equal(resolveMenu({ header: [], footer: [] }, 'header', 'el', 'el'), null);
    assert.equal(resolveMenu({ header: stored.header, footer: [] }, 'footer', 'el', 'el'), null);
  });

  test('the items in their saved order, labelled in the visitor’s language', () => {
    const menu = resolveMenu(stored, 'header', 'en', 'el');
    assert.deepEqual(
      menu?.map((m) => [m.label, m.href]),
      [
        ['Αρχική (en)', '/'],
        ['Υπηρεσίες (en)', '/services'],
        ['Blog (en)', 'https://blog.example.com'],
      ],
    );
  });

  test('a missing translation falls back to the main language', () => {
    const menu = resolveMenu({ header: [{ label: { el: 'Μόνο' }, href: '/', newTab: false }], footer: [] }, 'header', 'en', 'el');
    assert.equal(menu?.[0].label, 'Μόνο');
  });

  test('children come through, with their own new-tab flag', () => {
    const services = resolveMenu(stored, 'header', 'el', 'el')?.[1];
    assert.deepEqual(services?.children.map((c) => [c.label, c.href, c.newTab]), [['Web', '/services/web', true]]);
  });

  test('marks off-site links as external', () => {
    const menu = resolveMenu(stored, 'header', 'el', 'el');
    assert.equal(menu?.[0].external, false);
    assert.equal(menu?.[2].external, true);
  });

  test('an unsafe item that reached the database anyway is dropped on read', () => {
    const menu = resolveMenu(
      { header: [item('ok', '/'), item('bad', 'javascript:alert(1)')], footer: [] },
      'header',
      'el',
      'el',
    );
    assert.deepEqual(menu?.map((m) => m.href), ['/']);
  });
});
