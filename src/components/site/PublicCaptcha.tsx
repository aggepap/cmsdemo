'use client';

import { Captcha } from '@/cms/admin/ui/Captcha';

/**
 * reCAPTCHA v2 on a public form.
 *
 * The site's rule is "no iframe"; Google's widget is the one agreed exception,
 * and only on the visitor's first focus inside the form. Until then this is a
 * plain box of the widget's exact size (304×78), so nothing on the page moves
 * when the real one arrives — and a visitor who only reads the page never talks
 * to Google at all.
 */
const WIDTH = 304;
const HEIGHT = 78;

export interface PublicCaptchaProps {
  siteKey: string;
  /** Page locale, passed to the widget as `hl`. */
  locale: string;
  /** Flipped by the form on its first focus. */
  active: boolean;
  onToken: (token: string | null) => void;
  resetSignal?: number;
  /** Shown in the box before the widget loads. */
  placeholder: string;
}

export function PublicCaptcha({ siteKey, locale, active, onToken, resetSignal, placeholder }: PublicCaptchaProps) {
  if (!active) {
    return (
      <div
        style={{ width: WIDTH, height: HEIGHT }}
        className="flex max-w-full items-center rounded-sm border border-border-soft bg-white px-4 text-sm text-text-muted"
      >
        {placeholder}
      </div>
    );
  }
  return (
    <div style={{ minHeight: HEIGHT }}>
      <Captcha siteKey={siteKey} language={locale} onToken={onToken} resetSignal={resetSignal} />
    </div>
  );
}

/** Which message a failed submission shows. A captcha rejection says "tick it again". */
export type ContactErrorKey =
  | 'captchaFailed'
  | 'attachmentTooLarge'
  | 'attachmentType'
  | 'attachmentRejected'
  | 'attachmentUnavailable'
  | 'error';

/** What the endpoint said, as the message the visitor can act on. */
const ATTACHMENT_ERRORS: Record<string, ContactErrorKey> = {
  attachment_too_large: 'attachmentTooLarge',
  // The body cap: with a file in it, the file is what made it too large.
  too_large: 'attachmentTooLarge',
  attachment_type: 'attachmentType',
  attachment_empty: 'attachmentType',
  attachment_rejected: 'attachmentRejected',
  attachment_unscanned: 'attachmentUnavailable',
  attachment_disabled: 'attachmentUnavailable',
};

export function contactErrorMessageKey(status: number, error: string | undefined): ContactErrorKey {
  if (status === 400 && error === 'captcha_failed') return 'captchaFailed';
  return (error && ATTACHMENT_ERRORS[error]) || 'error';
}
