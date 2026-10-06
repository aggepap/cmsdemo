/**
 * hreflang only when there is a second language (F-011).
 *
 * A site with one public locale emitted `hreflang="el"` plus `x-default` on every
 * page and in every sitemap entry: an alternate set with no alternate in it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { hreflangLanguages } from '@/lib/seo/hreflang';

const url = (l: string) => (l === 'el' ? '/x' : `/${l}/x`);

describe('hreflangLanguages', () => {
  test('one public locale: no alternates at all', () => {
    assert.equal(hreflangLanguages(['el'], 'el', url), undefined);
  });

  test('two locales: each, plus x-default on English', () => {
    assert.deepEqual(hreflangLanguages(['el', 'en'], 'el', url), { el: '/x', en: '/en/x', 'x-default': '/en/x' });
  });

  test('without English, x-default is the main locale', () => {
    assert.deepEqual(hreflangLanguages(['el', 'de'], 'el', url), { el: '/x', de: '/de/x', 'x-default': '/x' });
  });
});

describe('wiring', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

  test('page metadata and the sitemap both use it', () => {
    for (const p of ['src/lib/seo/metadata.ts', 'src/app/sitemap.ts']) {
      const src = read(p);
      assert.match(src, /hreflangLanguages\(/, p);
      assert.doesNotMatch(src, /\['x-default'\]\s*=/, p);
    }
  });
});
