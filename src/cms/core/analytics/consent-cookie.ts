/**
 * The cookie the cookie banner mirrors its answer into, so the server knows it
 * too (the banner's own record is in localStorage, which the server cannot
 * read). Read by `requestAnalyticsContext` for the Meta Conversions API: no
 * `marketing` here, no server-side event.
 *
 * A leaf with no imports: the banner (client) and the server both use it.
 */
export const CONSENT_COOKIE = 'cms_consent';

const MIRRORED = ['analytics', 'marketing'] as const;

/** `analytics,marketing` — the granted categories the server cares about. */
export function consentCookieValue(
  decision: 'accepted' | 'rejected' | 'custom',
  categories: Readonly<Record<string, boolean>>,
): string {
  if (decision === 'rejected') return '';
  return MIRRORED.filter((key) =>
    Object.prototype.hasOwnProperty.call(categories, key) ? categories[key] : decision === 'accepted',
  ).join(',');
}

export function consentCookieHeader(value: string, secure: boolean): string {
  return `${CONSENT_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}
