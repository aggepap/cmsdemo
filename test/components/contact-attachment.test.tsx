/**
 * The file field on the public contact form (G-V2-01).
 *
 * Shown only when the site allows attachments (Settings → Forms), with the
 * allowed types and size spelled out next to it. With a file chosen the form
 * posts multipart; without one it posts the same JSON as before, so a site that
 * never turns the feature on sees no change at all.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { readAttachmentPolicy, type AttachmentPolicy } from '@/cms/core/forms/attachments';
import { ContactForm } from '@/components/site/ContactForm';
import { contactErrorMessageKey } from '@/components/site/PublicCaptcha';
import { contactRequestInit } from '@/lib/contact-request';
import el from '../../messages/el.json';
import en from '../../messages/en.json';

const render = (attachment: AttachmentPolicy | null, locale: 'el' | 'en' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Europe/Athens"
      messages={locale === 'el' ? el : en}
    >
      <ContactForm attachment={attachment} />
    </NextIntlClientProvider>
  );

describe('ContactForm attachment field', () => {
  test('off: there is no file input', () => {
    assert.doesNotMatch(render(null), /type="file"/);
  });

  test('on: a labelled file input that accepts only the allowed types', () => {
    const html = render(readAttachmentPolicy('on', 'pdf', '10'));
    assert.match(html, /<input[^>]*type="file"[^>]*>/);
    assert.match(html, /name="attachment"/);
    assert.match(html, /accept="\.pdf,application\/pdf"/);
    assert.match(html, /<label for="attachment"/);
  });

  test('on: the hint names the types and the size, in the page language', () => {
    const policy = readAttachmentPolicy('on', 'pdf,docx', '10');
    const enHtml = render(policy);
    assert.match(enHtml, /PDF, DOCX/);
    assert.match(enHtml, /10 MB/);
    assert.match(enHtml, /aria-describedby="attachment-hint"/);
    const elHtml = render(policy, 'el');
    assert.match(elHtml, /PDF, DOCX/);
    assert.ok(elHtml.includes(el.contact.form.attachment));
  });
});

describe('contactRequestInit', () => {
  const fields = { kind: 'contact', name: 'A', email: 'a@example.com', message: 'm' };

  test('without a file: JSON, as before', () => {
    const init = contactRequestInit(fields, null, { 'x-captcha-token': 't' });
    assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal((init.headers as Record<string, string>)['x-captcha-token'], 't');
    assert.deepEqual(JSON.parse(String(init.body)), fields);
  });

  test('with a file: multipart, fields in `payload`, file in `attachment`, and no hand-set content type', async () => {
    const file = new File([new TextEncoder().encode('%PDF-1.7')], 'a.pdf', {
      type: 'application/pdf',
    });
    const init = contactRequestInit(fields, file, { 'x-captcha-token': 't' });
    assert.ok(init.body instanceof FormData);
    assert.equal((init.headers as Record<string, string>)['content-type'], undefined);
    assert.equal((init.headers as Record<string, string>)['x-captcha-token'], 't');
    assert.deepEqual(JSON.parse(String(init.body.get('payload'))), fields);
    const sent = init.body.get('attachment');
    assert.ok(sent instanceof File);
    assert.equal(sent.name, 'a.pdf');
  });
});

describe('contactErrorMessageKey for attachments', () => {
  test('each refusal has its own message', () => {
    assert.equal(contactErrorMessageKey(413, 'attachment_too_large'), 'attachmentTooLarge');
    assert.equal(contactErrorMessageKey(413, 'too_large'), 'attachmentTooLarge');
    assert.equal(contactErrorMessageKey(415, 'attachment_type'), 'attachmentType');
    assert.equal(contactErrorMessageKey(422, 'attachment_rejected'), 'attachmentRejected');
    assert.equal(contactErrorMessageKey(503, 'attachment_unscanned'), 'attachmentUnavailable');
    assert.equal(contactErrorMessageKey(400, 'attachment_disabled'), 'attachmentUnavailable');
  });

  test('every attachment message exists in every language', () => {
    for (const messages of [el, en]) {
      const form = messages.contact.form as Record<string, string>;
      for (const key of [
        'attachment',
        'attachmentHint',
        'attachmentTooLarge',
        'attachmentType',
        'attachmentRejected',
        'attachmentUnavailable',
      ]) {
        assert.ok(form[key] && form[key].trim(), `${key}`);
      }
    }
  });
});
