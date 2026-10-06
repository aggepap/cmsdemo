import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LEGAL_LINKS, NAV_ITEMS, navItems } from '@/lib/nav';
import { footerLinks, headerLinks } from '@/lib/nav-links';

const hrefs = (items: ReadonlyArray<{ href: string }>) => items.map((i) => i.href);

describe('navItems', () => {
  test('with no modules on, the nav is exactly the base items', () => {
    assert.deepEqual(hrefs(navItems({})), hrefs(NAV_ITEMS));
  });

  test('a module link appears straight after Home, only while its module is on', () => {
    assert.deepEqual(hrefs(navItems({ commerce: true })).slice(0, 2), ['/', '/shop']);
    assert.deepEqual(hrefs(navItems({ booking: true })).slice(0, 2), ['/', '/booking']);
    assert.ok(!hrefs(navItems({ booking: true })).includes('/shop'));
  });

  test('turning a second module on does not reorder the first', () => {
    assert.deepEqual(hrefs(navItems({ commerce: true, booking: true })).slice(0, 3), ['/', '/booking', '/shop']);
  });

  test('every page reachable from the nav has a contact route', () => {
    assert.ok(hrefs(NAV_ITEMS).includes('/contact'));
  });
});

describe('headerLinks / footerLinks', () => {
  const t = (key: string) => `t:${key}`;
  const admin = [
    { label: 'Αρχική', href: '/', newTab: false, external: false, children: [] },
    {
      label: 'Blog',
      href: 'https://blog.example.com',
      newTab: true,
      external: true,
      children: [{ label: 'Νέα', href: '/news', newTab: false, external: false, children: [] }],
    },
  ];

  test('without an admin menu, the header is the built-in one, module links and all', () => {
    const links = headerLinks(null, { commerce: true }, t);
    assert.deepEqual(hrefs(links), hrefs(navItems({ commerce: true })));
    assert.equal(links[0].label, 't:home');
    assert.equal(links[0].newTab, false);
    assert.deepEqual(links[0].children, []);
  });

  test('with an admin menu, the header is exactly what the admin set — no module links added', () => {
    const links = headerLinks(admin, { commerce: true, booking: true }, t);
    assert.deepEqual(hrefs(links), ['/', 'https://blog.example.com']);
    assert.equal(links[1].label, 'Blog');
    assert.equal(links[1].newTab, true);
    assert.deepEqual(hrefs(links[1].children), ['/news']);
  });

  test('the footer falls back to the base items, and otherwise follows the admin', () => {
    assert.deepEqual(hrefs(footerLinks(null, t)), hrefs(NAV_ITEMS));
    assert.deepEqual(hrefs(footerLinks(admin, t)), ['/', 'https://blog.example.com']);
  });

  test('every link has a key that is unique within its list', () => {
    const keys = headerLinks([...admin, { ...admin[0] }], {}, t).map((l) => l.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

test('the legal links point at the cookie policy and the two CMS legal pages', () => {
  assert.deepEqual(hrefs(LEGAL_LINKS), ['/privacy', '/terms', '/legal/cookies']);
});
