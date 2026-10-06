/**
 * reCAPTCHA in the cookie declaration and the settings (REQ-1).
 *
 * The captcha is a security measure, so it is declared under the NECESSARY
 * category — it is not something a visitor can refuse and still send the form —
 * and only while it is actually switched on for the public forms.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withCaptchaDeclaration, type CategoryWithServices } from '@/cms/core/cookies/declaration';
import { MANAGED_SETTINGS } from '@/cms/core/settings/schema';
import { validateSettingValue } from '@/cms/core/settings/validate';
import {
  PUBLIC_FORMS_CAPTCHA_KEY,
  readPublicFormsCaptcha,
} from '@/cms/core/settings/captcha';

const NOW = new Date('2026-01-01T00:00:00Z');

function category(over: Partial<CategoryWithServices> & Pick<CategoryWithServices, 'id' | 'key'>): CategoryWithServices {
  return {
    name: { el: over.key, en: over.key },
    description: null,
    required: false,
    sortOrder: 0,
    createdAt: NOW,
    services: [],
    ...over,
  };
}

const necessary = category({ id: 1, key: 'necessary', required: true });
const analytics = category({ id: 2, key: 'analytics', sortOrder: 1 });

function captchaOf(catalog: CategoryWithServices[]) {
  return catalog.find((c) => c.key === 'necessary')?.services.find((s) => /recaptcha/i.test(s.name));
}

describe('withCaptchaDeclaration', () => {
  test('declares Google reCAPTCHA under necessary when enabled', () => {
    const svc = captchaOf(withCaptchaDeclaration([necessary, analytics], true));
    assert.ok(svc);
    assert.equal(svc.provider, 'Google');
    assert.match(svc.purpose?.el ?? '', /ασφάλεια/i);
    assert.match(svc.purpose?.en ?? '', /security/i);
  });

  test('leaves the catalogue untouched when disabled', () => {
    const stored = [necessary, analytics];
    assert.deepEqual(withCaptchaDeclaration(stored, false), stored);
  });

  test('does not duplicate an admin-declared reCAPTCHA row', () => {
    const own = category({
      id: 1,
      key: 'necessary',
      required: true,
      services: [{ id: 9, categoryId: 1, name: 'Google reCAPTCHA', provider: 'Google', purpose: null, enabled: true, createdAt: NOW }],
    });
    const cat = withCaptchaDeclaration([own], true).find((c) => c.key === 'necessary');
    assert.equal(cat?.services.length, 1);
    assert.equal(cat?.services[0].id, 9);
  });

  test('synthesizes the necessary category when the catalogue has none', () => {
    const out = withCaptchaDeclaration([analytics], true);
    const cat = out.find((c) => c.key === 'necessary');
    assert.ok(cat);
    assert.equal(cat.required, true);
    assert.ok(captchaOf(out));
  });

  test('does not mutate its input', () => {
    const stored = [category({ id: 1, key: 'necessary', required: true })];
    withCaptchaDeclaration(stored, true);
    assert.equal(stored[0].services.length, 0);
  });
});

describe('Settings → Security → captcha on public forms', () => {
  const def = MANAGED_SETTINGS.find((d) => d.key === PUBLIC_FORMS_CAPTCHA_KEY);

  test('is a Security select with off and reCAPTCHA v2, off by default', () => {
    assert.ok(def);
    assert.equal(def.group, 'Security');
    assert.equal(def.type, 'select');
    assert.deepEqual(def.options?.map((o) => o.value), ['off', 'recaptcha_v2']);
    assert.equal(def.defaultValue, 'off');
  });

  test('refuses a provider it does not know', () => {
    assert.equal(validateSettingValue(PUBLIC_FORMS_CAPTCHA_KEY, def, 'hcaptcha').ok, false);
    assert.equal(validateSettingValue(PUBLIC_FORMS_CAPTCHA_KEY, def, 'recaptcha_v2').ok, true);
  });

  test('reads as off unless exactly a known provider is stored', () => {
    assert.equal(readPublicFormsCaptcha('recaptcha_v2'), 'recaptcha_v2');
    for (const raw of [undefined, null, '', 'off', 'on', 'RECAPTCHA_V2', 1]) {
      assert.equal(readPublicFormsCaptcha(raw), null, String(raw));
    }
  });
});
