import 'server-only';

/**
 * Google reCAPTCHA v2 verification.
 *
 * Split pure/I-O the way the rest of the core is (see `modules/booking/data.ts`
 * versus `read.ts`): `interpretCaptchaVerification` holds the judgement and is
 * unit-tested without a network, `verifyCaptchaToken` does the round-trip.
 *
 * Required env (server-only — the secret must never be `NEXT_PUBLIC_`):
 *   RECAPTCHA_SITE_KEY    browser-safe, handed to the widget as a prop
 *   RECAPTCHA_SECRET_KEY  server-side, used here
 *
 * With the secret unset, verification is SKIPPED and a warning is logged once.
 * That is deliberate and is what keeps `npm test`, CI, the QA dev server and a
 * fresh clone working without a Google account. Production sets both.
 *
 * Google's public TEST keys (`.env.example` ships them) pass every token. They
 * are what tests and dev should run with — the real widget, the real round
 * trip — and they are refused in production: a copied example file must not
 * pose as a working bot check. Refused means treated as unconfigured, with a
 * loud log line, rather than failing closed: the same keys guard the admin
 * login, and locking every administrator out over a deploy mistake would be
 * worse than the no-op check those keys already were.
 */

/** Where the token travels. Lowercase — that is how `Headers.get` matches. */
export const CAPTCHA_HEADER = 'x-captcha-token';

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

/** Google is a hard dependency of a login; it does not get to hang one. */
const VERIFY_TIMEOUT_MS = 5000;

export interface CaptchaResult {
  ok: boolean;
  /** Why it failed, for the server log. Never shown to the caller. */
  reason?: string;
}

/** Google's published reCAPTCHA v2 test pair: every token passes. */
export const GOOGLE_TEST_SITE_KEY = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
export const GOOGLE_TEST_SECRET_KEY = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';

function readKey(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Either test key in a production process. One is enough: a half-real pair still checks nothing. */
export function usingGoogleTestKeysInProduction(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  return (
    readKey('RECAPTCHA_SITE_KEY') === GOOGLE_TEST_SITE_KEY ||
    readKey('RECAPTCHA_SECRET_KEY') === GOOGLE_TEST_SECRET_KEY
  );
}

/**
 * The browser-safe key, or `null` when unset. `null` means "render no widget".
 * Also `null` for the test keys in production — see the file header.
 */
export function captchaSiteKey(): string | null {
  if (usingGoogleTestKeysInProduction()) return null;
  return readKey('RECAPTCHA_SITE_KEY');
}

/**
 * Whether the captcha is actually in force. Both halves are required: a site
 * key alone renders a widget nothing checks, and a secret alone rejects every
 * login because no widget ever produced a token.
 */
export function captchaEnabled(): boolean {
  if (usingGoogleTestKeysInProduction()) return false;
  return readKey('RECAPTCHA_SITE_KEY') !== null && readKey('RECAPTCHA_SECRET_KEY') !== null;
}

/**
 * The key for a PUBLIC form's widget: only when the server will check what it
 * produces. `captchaSiteKey` alone is not that — a site key without its secret
 * would put a box on the page that nothing verifies.
 */
export function publicCaptchaSiteKey(): string | null {
  return captchaEnabled() ? readKey('RECAPTCHA_SITE_KEY') : null;
}

/**
 * Map Google's response body to a verdict.
 *
 * Checks `success === true` rather than truthiness. The body arrives as
 * untrusted JSON, and `if (body.success)` would pass on the *string* `"false"`
 * — which is exactly what a proxy or an error page rendering the field as text
 * would produce.
 */
export function interpretCaptchaVerification(payload: unknown): CaptchaResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'malformed-response' };
  }
  const body = payload as { success?: unknown; 'error-codes'?: unknown };
  if (body.success === true) return { ok: true };
  if (body.success !== false) return { ok: false, reason: 'malformed-response' };

  const codes = Array.isArray(body['error-codes'])
    ? body['error-codes'].filter((c): c is string => typeof c === 'string')
    : [];
  return { ok: false, reason: codes.length > 0 ? codes.join(',') : 'rejected' };
}

/** Module-level so a dev server logs the skip once, not once per request. */
let skipWarned = false;
let testKeysWarned = false;

/**
 * Verify a token with Google. `fetchImpl` is injectable so the failure paths —
 * which are the ones that matter — can be tested without a network.
 */
export async function verifyCaptchaToken(
  token: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptchaResult> {
  if (usingGoogleTestKeysInProduction()) {
    if (!testKeysWarned) {
      testKeysWarned = true;
      console.error(
        '[cms/captcha] Google\'s public reCAPTCHA TEST keys are set in production — they pass ' +
          'every token, so captcha is treated as NOT configured. Register real keys for this ' +
          'domain (apex and www) and set RECAPTCHA_SITE_KEY/RECAPTCHA_SECRET_KEY.',
      );
    }
    return { ok: true, reason: 'test-keys-in-production' };
  }

  const secret = readKey('RECAPTCHA_SECRET_KEY');
  const site = readKey('RECAPTCHA_SITE_KEY');
  if (secret === null || site === null) {
    /*
     * Both halves are required to skip, not just the secret.
     *
     * A secret WITHOUT a site key is a lockout, not a defence: the login form
     * renders no widget without a site key, so nothing can produce a token, so
     * every sign-in is refused — including the one that would let somebody in
     * to fix the configuration. Half-configured therefore behaves as
     * unconfigured, and says so loudly.
     */
    if (!skipWarned) {
      skipWarned = true;
      console.warn(
        secret === null && site === null
          ? '[cms/captcha] RECAPTCHA_SITE_KEY/RECAPTCHA_SECRET_KEY are not set — captcha ' +
              'verification is DISABLED. Set both in any environment reachable from the internet.'
          : `[cms/captcha] only ${secret === null ? 'RECAPTCHA_SITE_KEY' : 'RECAPTCHA_SECRET_KEY'} ` +
              'is set — captcha verification is DISABLED. It takes BOTH keys to switch on.',
      );
    }
    return { ok: true, reason: 'not-configured' };
  }

  const response = token?.trim();
  if (!response) return { ok: false, reason: 'missing-token' };

  /*
   * No `remoteip`. It is optional, and the only address available is the
   * `x-real-ip` header — trustworthy exactly as far as the reverse proxy is
   * configured to overwrite it (see `core/rate-limit.ts`). A wrong value there
   * is worse than none: Google scores the address it is given, so a spoofed one
   * gets a real user judged on somebody else's reputation. The token already
   * binds the challenge to the browser that solved it.
   */
  const form = new URLSearchParams({ secret, response });

  let payload: unknown;
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, reason: `verify-http-${res.status}` };
    payload = await res.json();
  } catch {
    /*
     * Fail CLOSED. Treating an unreachable Google as a pass would mean anyone
     * who can block or slow one hostname — a captive network, a DNS outage, a
     * firewall rule — has switched the captcha off for everybody, and nothing
     * about the login would look different while they did it.
     */
    return { ok: false, reason: 'verify-unreachable' };
  }

  return interpretCaptchaVerification(payload);
}
