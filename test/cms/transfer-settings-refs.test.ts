import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CUSTOM_FIELDS_KEY,
  EXTRA_MANAGED_KEYS,
  I18N_LOCALES_KEY,
  MANAGED_SETTING_KEYS,
} from '@/cms/core/settings/schema';
import {
  collectSettingRefs,
  isExportableSetting,
  REF_FREE_STRUCTURED,
  rewriteSettingValue,
  SETTING_REFS,
  settingWarning,
} from '@/cms/core/transfer/settings-refs';

/**
 * Two settings hold references: the brand identity names its logos by media
 * uuid, and custom-field definitions name the categories they apply to by
 * document id. Written as-is on another site, a logo would vanish and a custom
 * field would appear under whatever category happens to hold that id there.
 */

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('collectSettingRefs', () => {
  test('finds the brand logos', () => {
    const refs = collectSettingRefs('brand.identity', {
      logoId: U1,
      logoDarkId: null,
      faviconId: U2,
      name: 'x',
    });
    assert.deepEqual(refs.map((r) => `${r.kind}:${r.value}@${r.path}`).sort(), [
      `media:${U1}@logoId`,
      `media:${U2}@faviconId`,
    ]);
  });

  test('finds category ids in custom-field definitions, including sub-fields', () => {
    const value = {
      product: {
        groups: [],
        fields: [
          { id: 'a', key: 'a', categoryIds: [3, 4] },
          { id: 'b', key: 'b', subFields: [{ id: 'c', key: 'c', categoryIds: [5] }] },
        ],
      },
    };
    const refs = collectSettingRefs(CUSTOM_FIELDS_KEY, value);
    assert.deepEqual(refs.map((r) => r.value).sort(), [3, 4, 5]);
  });

  test('a setting without references has none', () => {
    assert.deepEqual(collectSettingRefs('site.name', 'Shop'), []);
  });
});

describe('rewriteSettingValue', () => {
  test('maps logos and category ids, dropping what does not resolve', () => {
    const resolver = {
      doc: (id: number) => (id === 3 ? 30 : null),
      media: (u: string) => (u === U1 ? U2 : null),
    };
    const brand = rewriteSettingValue('brand.identity', { logoId: U1, faviconId: U2 }, resolver);
    assert.deepEqual(brand.value, { logoId: U2, faviconId: null });
    assert.equal(brand.dropped.length, 1);

    const cf = rewriteSettingValue(
      CUSTOM_FIELDS_KEY,
      { product: { groups: [], fields: [{ id: 'a', categoryIds: [3, 4] }] } },
      resolver
    );
    assert.deepEqual(cf.value, {
      product: { groups: [], fields: [{ id: 'a', categoryIds: [30] }] },
    });
  });
});

describe('which settings travel', () => {
  test('machine state and edit baselines never do', () => {
    assert.equal(isExportableSetting('integrations.googleReviews.oauthState'), false);
    assert.equal(isExportableSetting('cms.customFields.baseline'), false);
    assert.equal(isExportableSetting('brand.identity'), true);
  });

  test('settings that change how the site works carry a warning', () => {
    assert.ok(settingWarning(I18N_LOCALES_KEY));
    assert.ok(settingWarning('ecommerce.paymentProvider'));
    assert.ok(settingWarning('module.commerce'));
    assert.equal(settingWarning('site.name'), null);
  });

  test('every structured setting is classified — a new one must say whether it holds references', () => {
    const scalar = new Set(MANAGED_SETTING_KEYS);
    for (const key of [...EXTRA_MANAGED_KEYS, I18N_LOCALES_KEY]) {
      if (scalar.has(key)) continue;
      assert.ok(
        key in SETTING_REFS || REF_FREE_STRUCTURED.has(key),
        `unclassified setting: ${key}`
      );
    }
  });
});

describe('custom fields keep their category limits', () => {
  test('a field whose every category is unresolved is left out, not widened to all documents', () => {
    const resolver = { doc: () => null, media: (u: string) => u };
    const { value, dropped } = rewriteSettingValue(
      CUSTOM_FIELDS_KEY,
      {
        product: {
          groups: [],
          fields: [{ id: 'a', categoryIds: [3] }, { id: 'b' }, { id: 'c', categoryIds: [] }],
        },
      },
      resolver
    );
    assert.deepEqual(value, {
      product: { groups: [], fields: [{ id: 'b' }, { id: 'c', categoryIds: [] }] },
    });
    assert.ok(dropped.length >= 1);
  });

  test('merge keeps only fields that existed before the import; fields it added take the package version', async () => {
    const { mergeCustomFieldConfigs } = await import('@/cms/core/transfer/settings-refs');
    const current = {
      product: {
        groups: [],
        fields: [
          { id: 'mine', label: 'site' },
          { id: 'new', categoryIds: [] },
        ],
      },
    };
    const incoming = {
      product: {
        groups: [],
        fields: [
          { id: 'mine', label: 'pkg' },
          { id: 'new', categoryIds: [30] },
        ],
      },
    };
    const merged = mergeCustomFieldConfigs(current, incoming, new Set(['mine'])) as typeof current;
    assert.deepEqual(merged.product.fields, [
      { id: 'mine', label: 'site' },
      { id: 'new', categoryIds: [30] },
    ]);
  });
});
