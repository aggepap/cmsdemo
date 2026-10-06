import 'server-only';

import { getSetting } from '../settings';
import { PUBLIC_FORMS_CAPTCHA_KEY, readPublicFormsCaptcha } from '../settings/captcha';
import { publicCaptchaSiteKey } from './captcha';

/**
 * The site key for the public forms' widget, or `null` for "no captcha".
 *
 * Both halves must agree: the admin switched it on (Settings → Security), AND
 * the server holds a usable key pair. One answer for every reader — the page
 * that renders the widget, the endpoint that verifies it and the cookie
 * declaration that names it — so none of them can disagree about whether a
 * visitor is being asked.
 */
export async function publicFormsCaptchaSiteKey(): Promise<string | null> {
  const provider = readPublicFormsCaptcha(await getSetting(PUBLIC_FORMS_CAPTCHA_KEY));
  return provider ? publicCaptchaSiteKey() : null;
}
