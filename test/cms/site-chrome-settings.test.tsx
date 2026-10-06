import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AnnouncementSettings } from '@/cms/admin/AnnouncementSettings';
import { MenusSettings } from '@/cms/admin/MenusSettings';
import { moveItem, parseStoredMenus } from '@/cms/admin/menu-editor-state';

/**
 * Settings → Announcement bar and Settings → Menus.
 *
 * The menu editor is reordered with buttons, not by dragging: a "Move up" /
 * "Move down" pair is operable from the keyboard and by a screen reader, and
 * says which item it moves.
 */

const locales = ['el', 'en'];

describe('AnnouncementSettings', () => {
  const html = renderToStaticMarkup(
    <AnnouncementSettings
      initial={{ enabled: true, text: { el: 'Γεια', en: 'Hi' }, href: '/shop', dismissible: false }}
      locales={locales}
    />,
  );

  test('one text box per editing language, with the length limit on the box', () => {
    assert.match(html, /Text \(EL\)/);
    assert.match(html, /Text \(EN\)/);
    assert.match(html, /maxLength="160"/);
    assert.match(html, /value="Γεια"/);
  });

  test('offers the switch, the link and the dismiss option', () => {
    assert.match(html, /Show the announcement bar/);
    assert.match(html, /value="\/shop"/);
    assert.match(html, /Visitors can dismiss it/);
  });
});

describe('MenusSettings', () => {
  const stored = {
    header: [
      { label: { el: 'Αρχική', en: 'Home' }, href: '/', newTab: false },
      {
        label: { el: 'Υπηρεσίες', en: 'Services' },
        href: '/services',
        newTab: false,
        children: [{ label: { el: 'Web' }, href: '/services/web', newTab: false }],
      },
    ],
    footer: [],
  };
  const html = renderToStaticMarkup(<MenusSettings initial={parseStoredMenus(stored)} locales={locales} />);

  test('shows both menus, and says an empty one uses the built-in menu', () => {
    assert.match(html, /Header menu/);
    assert.match(html, /Footer menu/);
    assert.match(html, /built-in/);
  });

  test('every reorder and remove control is a real button naming its item', () => {
    assert.match(html, /<button[^>]*aria-label="Move “Αρχική” up"[^>]*disabled/);
    assert.match(html, /<button[^>]*aria-label="Move “Αρχική” down"/);
    assert.match(html, /<button[^>]*aria-label="Remove “Υπηρεσίες”"/);
  });

  test('header items can take sub-items; the sub-items themselves cannot', () => {
    assert.match(html, /aria-label="Add a sub-item under “Αρχική”"/);
    assert.doesNotMatch(html, /Add a sub-item under “Web”/);
  });

  test('renders the stored values', () => {
    assert.match(html, /value="\/services\/web"/);
    assert.match(html, /value="Services"/);
  });
});

describe('menu editor state', () => {
  test('moveItem swaps neighbours and ignores moves past either end', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
    assert.deepEqual(moveItem(['a', 'b'], 0, -1), ['a', 'b']);
    assert.deepEqual(moveItem(['a', 'b'], 1, 1), ['a', 'b']);
  });

  test('parseStoredMenus reads unset or malformed storage as two empty menus', () => {
    assert.deepEqual(parseStoredMenus(null), { header: [], footer: [] });
    assert.deepEqual(parseStoredMenus({ header: 'x' }), { header: [], footer: [] });
  });
});
