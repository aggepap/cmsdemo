import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { defaultLocaleMap, mapLocale, mapLocalizedValue } from '@/cms/core/transfer/locale-map';

/**
 * A package from an `el`+`en` site imported into an `el`+`de` site: what the
 * source wrote in English has nowhere to go, and must be dropped rather than
 * stored under a key the target's schema rejects.
 */

describe('defaultLocaleMap', () => {
  test('maps a locale the target also has onto itself, and drops the rest', () => {
    assert.deepEqual(defaultLocaleMap(['el', 'en'], ['el', 'de']), { el: 'el', en: null });
  });

  test('an identical locale set is the identity', () => {
    assert.deepEqual(defaultLocaleMap(['el', 'en'], ['en', 'el']), { el: 'el', en: 'en' });
  });
});

describe('mapLocale', () => {
  test('a locale missing from the map is dropped', () => {
    assert.equal(mapLocale({ el: 'el' }, 'fr'), null);
    assert.equal(mapLocale({ el: 'en' }, 'el'), 'en');
  });
});

describe('mapLocalizedValue', () => {
  test('renames kept locales and drops the dropped ones', () => {
    assert.deepEqual(mapLocalizedValue({ el: 'Γεια', en: 'Hi' }, { el: 'el', en: null }), {
      el: 'Γεια',
    });
    assert.deepEqual(mapLocalizedValue({ en: 'Hi' }, { en: 'de' }), { de: 'Hi' });
  });

  test('when two source locales land on one target, the first mapped wins', () => {
    assert.deepEqual(mapLocalizedValue({ en: 'A', us: 'B' }, { en: 'en', us: 'en' }), { en: 'A' });
  });
});

describe('localeMapProblem', () => {
  test('refuses two package languages landing on one site language', async () => {
    const { localeMapProblem } = await import('@/cms/core/transfer/locale-map');
    assert.match(localeMapProblem({ en: 'en', us: 'en' }, ['en', 'us'], ['en']) ?? '', /both/);
  });

  test('refuses unknown languages on either side, and accepts a clean map', async () => {
    const { localeMapProblem } = await import('@/cms/core/transfer/locale-map');
    assert.ok(localeMapProblem({ fr: 'el' }, ['el'], ['el']));
    assert.ok(localeMapProblem({ el: 'de' }, ['el'], ['el']));
    assert.equal(localeMapProblem({ el: 'el', en: null }, ['el', 'en'], ['el']), null);
  });
});
