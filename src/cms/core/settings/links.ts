/**
 * Where an admin-set link (a menu item, the announcement bar) may point.
 *
 * Two shapes and nothing else: a path on this site (`/about`, `/el/blog?p=2`)
 * or an https URL. That rules out `javascript:` and `data:` without having to
 * list them, `http:` (mixed content), `mailto:`/`tel:` (not a page), and the
 * protocol-relative `//evil.com` and `/\evil.com`, which a browser reads as
 * another host even though they start with a slash.
 *
 * Used at the write boundary (the settings schemas) and again on read, so a
 * value that reached the database some other way still never becomes an href.
 */
const MAX_HREF = 500;

export function isSiteLinkHref(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const href = raw;
  if (!href || href.length > MAX_HREF) return false;
  // Whitespace and control characters: the HTML parser strips some of them
  // before reading a scheme, so none are allowed anywhere.
  if (/[\s\u0000-\u001F\u007F\\]/.test(href)) return false;
  if (href.startsWith('/')) return !href.startsWith('//');
  // `https:///x` is parsed as the host `x`; what was typed is not what would load.
  if (!href.startsWith('https://') || href.startsWith('https:///')) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Whether a (valid) link leaves this site. */
export function isExternalHref(href: string): boolean {
  return href.startsWith('https://');
}
