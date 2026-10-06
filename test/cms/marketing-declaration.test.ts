/**
 * The cookie declaration follows the Analytics & Marketing settings (REQ-5 §2).
 *
 * The moment a provider is switched on, its cookies are declared under the
 * right category: GA's `_ga`, `_ga_*`, `_gid` under Analytics; the Meta Pixel's
 * `_fbp`, `_fbc` under Marketing. Nothing is declared for a provider that is off.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  withAnalyticsDeclaration,
  withMarketingDeclaration,
  type CategoryWithServices,
} from '@/cms/core/cookies/declaration';

const NOW = new Date('2026-01-01T00:00:00Z');

function category(over: Partial<CategoryWithServices> & Pick<CategoryWithServices, 'id' | 'key'>): CategoryWithServices {
  return { name: { el: over.key, en: over.key }, description: null, required: false, sortOrder: 0, createdAt: NOW, services: [], ...over };
}

const analytics = category({ id: 2, key: 'analytics', sortOrder: 1 });
const marketing = category({ id: 3, key: 'marketing', sortOrder: 2 });

describe('withMarketingDeclaration', () => {
  test('declares the Meta Pixel under Marketing, naming its cookies', () => {
    const out = withMarketingDeclaration([analytics, marketing], { metaPixel: true });
    const svc = out.find((c) => c.key === 'marketing')?.services.find((s) => /meta pixel/i.test(s.name));
    assert.ok(svc);
    assert.equal(svc.provider, 'Meta');
    assert.match(svc.purpose?.en ?? '', /_fbp/);
    assert.match(svc.purpose?.en ?? '', /_fbc/);
    assert.match(svc.purpose?.el ?? '', /_fbp/);
  });

  test('nothing is added while the Pixel is off', () => {
    const stored = [analytics, marketing];
    assert.deepEqual(withMarketingDeclaration(stored, { metaPixel: false }), stored);
  });

  test('synthesizes the Marketing category when the catalogue has none', () => {
    const out = withMarketingDeclaration([analytics], { metaPixel: true });
    const cat = out.find((c) => c.key === 'marketing');
    assert.ok(cat);
    assert.equal(cat.required, false);
  });

  test('an admin-declared Meta row is not duplicated', () => {
    const own = category({
      id: 3,
      key: 'marketing',
      services: [{ id: 30, categoryId: 3, name: 'Meta Pixel', provider: 'Meta', purpose: null, enabled: true, createdAt: NOW }],
    });
    const cat = withMarketingDeclaration([own], { metaPixel: true }).find((c) => c.key === 'marketing');
    assert.equal(cat?.services.length, 1);
  });
});

describe('Google Ads', () => {
  test('declared under Marketing, naming _gcl_*, while conversions run through GTM', () => {
    const out = withMarketingDeclaration([analytics, marketing], { metaPixel: false, googleAds: true });
    const svc = out.find((c) => c.key === 'marketing')?.services.find((s) => /google ads/i.test(s.name));
    assert.ok(svc);
    assert.match(svc.purpose?.en ?? '', /_gcl_\*/);
    assert.match(svc.purpose?.el ?? '', /_gcl_\*/);
  });

  test('both providers can be declared together', () => {
    const out = withMarketingDeclaration([marketing], { metaPixel: true, googleAds: true });
    assert.equal(out.find((c) => c.key === 'marketing')?.services.length, 2);
  });
});

describe('Google Analytics entry', () => {
  test('names its cookies', () => {
    const out = withAnalyticsDeclaration([analytics], 'G-ABC1234567');
    const ga = out[0].services[0];
    for (const cookie of ['_ga', '_ga_*', '_gid']) {
      assert.ok(ga.purpose?.en.includes(cookie), cookie);
      assert.ok(ga.purpose?.el.includes(cookie), cookie);
    }
  });
});
