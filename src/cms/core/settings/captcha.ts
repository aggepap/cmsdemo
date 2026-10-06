/**
 * Settings → Security → "Captcha on public forms".
 *
 * A leaf with no imports, like `analytics.ts`: the settings schema (plain data,
 * rendered by the client form) declares the field from these constants.
 *
 * Only the switch and the provider live here. The keys stay in the server's
 * `.env` (`RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`) — never in the database,
 * never in an export.
 */

export const PUBLIC_FORMS_CAPTCHA_KEY = 'security.publicFormsCaptcha';

/** The providers a public form can use. reCAPTCHA v2 is the only one today. */
export const PUBLIC_FORMS_CAPTCHA_PROVIDERS = ['recaptcha_v2'] as const;
export type PublicFormsCaptchaProvider = (typeof PUBLIC_FORMS_CAPTCHA_PROVIDERS)[number];

/**
 * The chosen provider, or `null` for off. Exactly a known value or nothing: an
 * unset key never switches a feature on (see `readBooleanSetting`).
 */
export function readPublicFormsCaptcha(raw: unknown): PublicFormsCaptchaProvider | null {
  return (PUBLIC_FORMS_CAPTCHA_PROVIDERS as readonly unknown[]).includes(raw)
    ? (raw as PublicFormsCaptchaProvider)
    : null;
}
