import '../setup/react-global'; // must precede any component import

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { DesktopNav } from '@/components/layout/DesktopNav';
import { SiteNavLink } from '@/components/layout/SiteNavLink';
import { defaultLocale } from '@/lib/i18n/config';
import type { NavLink } from '@/lib/nav-links';

/**
 * How an admin-built menu item reaches the page: an in-site path through the
 * locale-aware router, an https URL as a plain anchor, a new tab only when the
 * admin asked for one — and then announced, and without handing over the opener.
 */

const messages = { links: { newTab: 'opens in a new tab' } };

const link = (over: Partial<NavLink> = {}): NavLink => ({
  key: 'k',
  label: 'Υπηρεσίες',
  href: '/services',
  newTab: false,
  children: [],
  ...over,
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={defaultLocale} messages={messages} timeZone="Europe/Athens">
      {node}
    </NextIntlClientProvider>,
  );

describe('SiteNavLink', () => {
  test('an in-site path stays in the same tab', () => {
    const html = render(<SiteNavLink link={link()} />);
    assert.match(html, /href="\/services"/);
    assert.doesNotMatch(html, /target=/);
  });

  test('a new-tab link carries target and rel, and says so to a screen reader', () => {
    const html = render(<SiteNavLink link={link({ href: 'https://example.com', newTab: true })} />);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /opens in a new tab/);
  });

  test('an external link in the same tab is a plain anchor', () => {
    const html = render(<SiteNavLink link={link({ href: 'https://example.com' })} />);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.doesNotMatch(html, /target=/);
  });

  test('a dangerous href never reaches the DOM, whatever got stored', () => {
    const html = render(<SiteNavLink link={link({ href: 'javascript:alert(1)' })} />);
    assert.doesNotMatch(html, /alert\(1\)/);
  });
});

describe('DesktopNav', () => {
  const links = [
    link({ key: 'a', label: 'Αρχική', href: '/' }),
    link({
      key: 'b',
      children: [link({ key: 'b0', label: 'Web', href: '/services/web' })],
    }),
  ];

  test('is the labelled primary navigation, with every link in order', () => {
    const html = render(<DesktopNav links={links} label="Primary" />);
    assert.match(html, /<nav [^>]*aria-label="Primary"/);
    assert.ok(html.indexOf('Αρχική') < html.indexOf('Υπηρεσίες'));
  });

  test('children are a nested list under their parent, reachable by keyboard (rendered, not hidden from the tab order)', () => {
    const html = render(<DesktopNav links={links} label="Primary" />);
    assert.match(html, /<li[^>]*>[\s\S]*Υπηρεσίες[\s\S]*<ul[^>]*>[\s\S]*href="\/services\/web"[\s\S]*<\/ul><\/li>/);
    assert.doesNotMatch(html, /tabindex="-1"/);
    assert.doesNotMatch(html, /\shidden[\s>=]/);
  });
});
