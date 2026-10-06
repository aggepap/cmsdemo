import '../setup/react-global'; // must precede any component import

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import {
  AnnouncementBar,
  isAnnouncementDismissed,
  rememberAnnouncementDismissed,
} from '@/components/layout/AnnouncementBar';
import { alwaysPresent } from '@/cms/core/cookies/registry';
import { storageKeys } from '@/cms/core/cookies/storage-keys';
import { STORAGE_KEYS, STORAGE_PREFIX } from '@/lib/storage-keys';

/**
 * The bar above the header. What it renders is pinned here; whether it is
 * hidden for a visitor who dismissed it is decided by the two storage helpers,
 * which are tested directly because a static render has no browser storage.
 */

const labels = { region: 'Announcement', dismiss: 'Dismiss announcement', newTab: 'opens in a new tab' };
const base = { id: 'abc123', text: 'Free delivery over €50', href: null, external: false, dismissible: false };

const render = (announcement: Parameters<typeof AnnouncementBar>[0]['announcement']) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}}>
      <AnnouncementBar announcement={announcement} labels={labels} />
    </NextIntlClientProvider>,
  );

describe('AnnouncementBar', () => {
  test('renders nothing when there is no announcement', () => {
    assert.equal(render(null), '');
  });

  test('is a labelled region holding the text', () => {
    const html = render(base);
    assert.match(html, /<section [^>]*aria-label="Announcement"/);
    assert.match(html, />Free delivery over €50</);
  });

  test('without a link the text is plain text', () => {
    assert.doesNotMatch(render(base), /<a /);
  });

  test('an internal link goes through the locale-aware router', () => {
    const html = render({ ...base, href: '/shop' });
    assert.match(html, /<a [^>]*href="\/en\/shop"|<a [^>]*href="\/shop"/);
    assert.doesNotMatch(html, /target="_blank"/);
  });

  test('an external link opens a new tab without handing over the opener, and says so', () => {
    const html = render({ ...base, href: 'https://example.com/sale', external: true });
    assert.match(html, /href="https:\/\/example.com\/sale"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /opens in a new tab/);
  });

  test('a dismiss button only when the admin allowed dismissing', () => {
    assert.doesNotMatch(render(base), /<button/);
    assert.match(render({ ...base, dismissible: true }), /<button [^>]*aria-label="Dismiss announcement"/);
  });
});

describe('dismissal memory', () => {
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  test('remembers the message that was dismissed, by its id', () => {
    const storage = fakeStorage();
    assert.equal(isAnnouncementDismissed(storage, 'abc'), false);
    rememberAnnouncementDismissed(storage, 'abc');
    assert.equal(isAnnouncementDismissed(storage, 'abc'), true);
  });

  test('a new message is shown again even after an older one was dismissed', () => {
    const storage = fakeStorage();
    rememberAnnouncementDismissed(storage, 'old');
    assert.equal(isAnnouncementDismissed(storage, 'new'), false);
  });

  test('blocked storage means "not dismissed", never a crash', () => {
    assert.equal(isAnnouncementDismissed(throwing, 'abc'), false);
    assert.doesNotThrow(() => rememberAnnouncementDismissed(throwing, 'abc'));
    assert.equal(isAnnouncementDismissed(null, 'abc'), false);
  });

  test('uses the site-prefixed key that the cookie declaration lists', () => {
    assert.equal(STORAGE_KEYS.announcementDismissed, storageKeys(STORAGE_PREFIX).announcementDismissed);
    assert.equal(storageKeys('acme').announcementDismissed, 'acme-announcement-dismissed');
    const names = alwaysPresent('acme').flatMap((s) => s.keys.map((k) => k.name));
    assert.ok(names.includes('acme-announcement-dismissed'));
  });
});
