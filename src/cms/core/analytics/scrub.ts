/**
 * Query parameters that must never reach Google or Meta.
 *
 * `t` is the booking payment link's bearer token. `paymentLinkUrl()` puts it in
 * the URL because the provider's return leg has to carry it back, and the token
 * deliberately stays live until a payment is credited — so it is a working
 * credential for as long as the booking is unpaid. Every analytics hit carries
 * `page_location`, so the whole payment URL — token included — would otherwise
 * reach Google and anyone with access to the property.
 */
export const SENSITIVE_QUERY_PARAMS = ['t', 'token'] as const;

/** A URL safe to report to analytics: sensitive values replaced, not dropped, so
 *  the shape of the page is still visible in reports. */
export function scrubUrl(href: string): string {
  try {
    const url = new URL(href);
    for (const key of SENSITIVE_QUERY_PARAMS) {
      if (url.searchParams.has(key)) url.searchParams.set(key, 'redacted');
    }
    return url.toString();
  } catch {
    // A URL that will not parse is not one we can safely report.
    return '';
  }
}

/** The same rule for the `page_path` string, which is built from the raw query. */
export function scrubQuery(query: string): string {
  const params = new URLSearchParams(query);
  for (const key of SENSITIVE_QUERY_PARAMS) {
    if (params.has(key)) params.set(key, 'redacted');
  }
  return params.toString();
}

/**
 * The same scrub as inline browser JS, for the scripts that must clean the URL
 * before a tag reads it (gtag's entry `config`). Generated from the list above,
 * so there is still one place to add a parameter.
 */
export const SCRUB_FUNCTION_JS =
  `function cmsScrub(h){try{var u=new URL(h);${JSON.stringify(SENSITIVE_QUERY_PARAMS)}` +
  `.forEach(function(k){if(u.searchParams.has(k))u.searchParams.set(k,'redacted');});return u.toString();}catch(e){return '';}}`;
