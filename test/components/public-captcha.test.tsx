/**
 * The captcha slot on public forms (REQ-1).
 *
 * The widget is Google's iframe — the one exception to the site's "no iframe"
 * rule — so it must not load for every visitor who merely opens the page. It
 * waits for the first focus inside the form; until then a placeholder of the
 * widget's exact size (304×78) holds its place so nothing jumps when it arrives.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContactForm } from '@/components/site/ContactForm';
import { PublicCaptcha, contactErrorMessageKey } from '@/components/site/PublicCaptcha';
import el from '../../messages/el.json';
import en from '../../messages/en.json';

const noop = () => {};

describe('PublicCaptcha', () => {
  test('before activation: a 304×78 placeholder, and no Google script', () => {
    const html = renderToStaticMarkup(
      <PublicCaptcha siteKey="k" locale="el" active={false} onToken={noop} placeholder="Επιβεβαίωση ότι δεν είστε ρομπότ" />,
    );
    assert.match(html, /Επιβεβαίωση ότι δεν είστε ρομπότ/);
    assert.match(html, /width:304px/);
    assert.match(html, /height:78px/);
    assert.doesNotMatch(html, /recaptcha/);
    assert.doesNotMatch(html, /<iframe/);
  });

  test('after activation: the placeholder is gone and the widget slot keeps the same size', () => {
    const html = renderToStaticMarkup(
      <PublicCaptcha siteKey="k" locale="el" active onToken={noop} placeholder="Placeholder text" />,
    );
    assert.doesNotMatch(html, /Placeholder text/);
    assert.match(html, /min-height:78px/);
  });
});

describe('ContactForm captcha', () => {
  const render = (siteKey: string | null, locale: 'el' | 'en' = 'en') =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} timeZone="Europe/Athens" messages={locale === 'el' ? el : en}>
        <ContactForm captchaSiteKey={siteKey} />
      </NextIntlClientProvider>,
    );

  test('with a site key, the form shows the localized placeholder', () => {
    assert.match(render('k'), new RegExp(en.contact.form.captchaPlaceholder));
    assert.match(render('k', 'el'), new RegExp(el.contact.form.captchaPlaceholder));
  });

  test('without a site key, there is no captcha slot at all', () => {
    assert.doesNotMatch(render(null), new RegExp(en.contact.form.captchaPlaceholder));
  });
});

describe('contactErrorMessageKey', () => {
  test('a captcha rejection gets its own message, so the visitor knows to tick again', () => {
    assert.equal(contactErrorMessageKey(400, 'captcha_failed'), 'captchaFailed');
  });

  test('anything else is the generic error', () => {
    assert.equal(contactErrorMessageKey(400, 'invalid_payload'), 'error');
    assert.equal(contactErrorMessageKey(502, 'send_failed'), 'error');
    assert.equal(contactErrorMessageKey(429, undefined), 'error');
  });
});

describe('messages', () => {
  test('every captcha message exists in every language', () => {
    for (const messages of [el, en]) {
      const form = messages.contact.form as Record<string, string>;
      for (const key of ['captchaPlaceholder', 'captchaRequired', 'captchaFailed']) {
        assert.ok(form[key] && form[key].trim(), key);
      }
    }
  });
});
