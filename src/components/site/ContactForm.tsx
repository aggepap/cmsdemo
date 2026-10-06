'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import {
  attachmentAccept,
  attachmentClientProblem,
  attachmentTypeLabels,
  formatAttachmentSize,
  type AttachmentPolicy,
} from '@/cms/core/forms/attachments';
import { Button } from '@/components/ui/Button';
import { PublicCaptcha, contactErrorMessageKey, type ContactErrorKey } from '@/components/site/PublicCaptcha';
import { track } from '@/lib/analytics/runtime';
import { newEventId } from '@/lib/analytics/event-id';
import { contactRequestInit } from '@/lib/contact-request';

type Status = 'idle' | 'sending' | 'sent' | 'error';
type FieldName = 'name' | 'email' | 'message' | 'attachment';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inputClass =
  'w-full rounded-sm border border-border-soft bg-white px-4 py-3 text-base text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-midnight-navy aria-[invalid=true]:border-error';

/**
 * The contact form. Posts `kind: 'contact'` to /api/contact, which validates it
 * again server-side, stores it (Admin → Submissions) and emails it.
 *
 * `_hp` is a honeypot: hidden from people, filled in by bots, and silently
 * accepted-then-dropped by the endpoint.
 *
 * `captchaSiteKey` comes from `publicFormsCaptchaSiteKey()` on the server: set
 * only when Settings → Security asks for a captcha AND the server can verify it.
 * The widget loads on the first focus inside the form, and its token rides in
 * the `x-captcha-token` header. A token is single-use, so the widget is reset
 * after every attempt that reached the server.
 *
 * `attachment` comes from `formAttachmentPolicy()` (Settings → Forms): with it,
 * the form offers one file of the allowed types and size and posts multipart
 * when a file is chosen. The server checks the file again by its bytes.
 */
export function ContactForm({
  captchaSiteKey = null,
  attachment = null,
}: { captchaSiteKey?: string | null; attachment?: AttachmentPolicy | null } = {}) {
  const t = useTranslations('contact.form');
  const locale = useLocale();
  const [status, setStatus] = useState<Status>('idle');
  const [errorKey, setErrorKey] = useState<ContactErrorKey>('error');
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [captchaActive, setCaptchaActive] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResets, setCaptchaResets] = useState(0);
  const [captchaMissing, setCaptchaMissing] = useState(false);

  function onCaptchaToken(token: string | null) {
    setCaptchaToken(token);
    if (token) setCaptchaMissing(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? '').trim();

    const next: Partial<Record<FieldName, string>> = {};
    if (!value('name')) next.name = t('required');
    if (!EMAIL.test(value('email'))) next.email = t('invalidEmail');
    if (!value('message')) next.message = t('required');
    const picked = data.get('attachment');
    const file = attachment && picked instanceof File && picked.size > 0 ? picked : null;
    const fileProblem = file && attachment ? attachmentClientProblem(file, attachment) : null;
    if (fileProblem) next.attachment = t(fileProblem);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (captchaSiteKey && !captchaToken) {
      setCaptchaActive(true);
      setCaptchaMissing(true);
      return;
    }

    setStatus('sending');
    try {
      // Shared with the server's Meta Conversions API send, so Meta counts one lead.
      const eventId = newEventId();
      const headers: Record<string, string> = { 'x-cms-event-id': eventId };
      if (captchaToken) headers['x-captcha-token'] = captchaToken;
      const fields = {
        kind: 'contact',
        locale,
        name: value('name'),
        email: value('email'),
        phone: value('phone'),
        message: value('message'),
        _hp: value('_hp'),
      };
      const res = await fetch('/api/contact', contactRequestInit(fields, file, headers));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrorKey(contactErrorMessageKey(res.status, body?.error));
        throw new Error(`contact form: HTTP ${res.status}`);
      }
      // Only now — after the server accepted it. A refused captcha or an error never counts.
      track('generate_lead', { form_id: 'contact', form_name: 'Contact' }, { eventId });
      form.reset();
      setStatus('sent');
    } catch (err) {
      console.error(err);
      setStatus('error');
    } finally {
      // The token was spent on this attempt either way; a new one is needed.
      if (captchaSiteKey) {
        setCaptchaToken(null);
        setCaptchaResets((n) => n + 1);
      }
    }
  }

  if (status === 'sent') {
    return (
      <p role="status" className="rounded-sm border border-border-soft bg-bone-cream p-6 text-text-primary">
        {t('success')}
      </p>
    );
  }

  const field = (name: Exclude<FieldName, 'attachment'> | 'phone', label: string, input: (describedBy?: string) => React.ReactNode) => {
    const error = name === 'phone' ? undefined : errors[name];
    const errorId = error ? `${name}-error` : undefined;
    return (
      <div className="flex flex-col gap-2">
        <label htmlFor={name} className="text-sm font-medium text-text-primary">
          {label}
        </label>
        {input(errorId)}
        {error ? (
          <p id={errorId} className="text-sm text-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      onFocus={captchaSiteKey && !captchaActive ? () => setCaptchaActive(true) : undefined}
      className="flex flex-col gap-5"
    >
      {field('name', t('name'), (d) => (
        <input id="name" name="name" autoComplete="name" required aria-invalid={Boolean(errors.name)} aria-describedby={d} className={inputClass} />
      ))}
      {field('email', t('email'), (d) => (
        <input id="email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(errors.email)} aria-describedby={d} className={inputClass} />
      ))}
      {field('phone', t('phone'), () => (
        <input id="phone" name="phone" type="tel" autoComplete="tel" className={inputClass} />
      ))}
      {field('message', t('message'), (d) => (
        <textarea id="message" name="message" rows={6} required aria-invalid={Boolean(errors.message)} aria-describedby={d} className={inputClass} />
      ))}

      {attachment ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="attachment" className="text-sm font-medium text-text-primary">
            {t('attachment')}
          </label>
          <input
            id="attachment"
            name="attachment"
            type="file"
            accept={attachmentAccept(attachment)}
            aria-invalid={Boolean(errors.attachment)}
            aria-describedby={errors.attachment ? 'attachment-hint attachment-error' : 'attachment-hint'}
            className="text-sm text-text-primary file:mr-4 file:rounded-sm file:border file:border-border-soft file:bg-white file:px-4 file:py-2 file:text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-midnight-navy"
          />
          <p id="attachment-hint" className="text-sm text-text-muted">
            {t('attachmentHint', {
              types: attachmentTypeLabels(attachment),
              size: formatAttachmentSize(attachment.maxBytes),
            })}
          </p>
          {errors.attachment ? (
            <p id="attachment-error" className="text-sm text-error">
              {errors.attachment}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Honeypot — not for people. */}
      <div aria-hidden="true" className="hidden">
        <label>
          Leave this empty
          <input name="_hp" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      {captchaSiteKey ? (
        <div className="flex flex-col gap-2">
          <PublicCaptcha
            siteKey={captchaSiteKey}
            locale={locale}
            active={captchaActive}
            onToken={onCaptchaToken}
            resetSignal={captchaResets}
            placeholder={t('captchaPlaceholder')}
          />
          {captchaMissing ? (
            <p role="alert" className="text-sm text-error">
              {t('captchaRequired')}
            </p>
          ) : null}
        </div>
      ) : null}

      {status === 'error' ? (
        <p role="alert" className="text-sm text-error">
          {t(errorKey)}
        </p>
      ) : null}

      <div>
        <Button type="submit" variant="primary" size="md" disabled={status === 'sending'}>
          {status === 'sending' ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
