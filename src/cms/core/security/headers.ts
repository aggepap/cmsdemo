/**
 * Security headers, per route (REQ-2).
 *
 * Imported by `next.config.ts` with a RELATIVE path, before the `@/*` alias
 * exists — so this file imports nothing, and is plain data and functions.
 *
 * Two policies:
 *
 *   strict       every response. COEP `credentialless`, the strict CSP.
 *   third-party  pages that may carry a public form with reCAPTCHA (and the
 *                admin, whose login has one). No COEP — Google's challenge
 *                iframe does not opt in to it, and Firefox and Safari refuse the
 *                `credentialless` iframe fallback that only Chromium honours —
 *                and the reCAPTCHA hosts in `script-src`, `connect-src` and a
 *                `frame-src`. The widget is the one iframe the site allows.
 *
 * The third-party policy goes on exactly two sources, `/` and `/:slug(...)` —
 * a CMS page, optionally under a locale prefix — with the fixed routes
 * (checkout, cart, account, order, shop, booking, the API, the admin…) excluded
 * by name. Payment and account pages keep the strict policy whatever happens to
 * the slug rule.
 *
 * `test/core/route-headers.test.ts` evaluates these sources with Next's own
 * `getPathMatch`, which is what decides at runtime.
 */

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export interface HeaderRuleOptions {
  /** Development sends no CSP (it breaks Turbopack HMR / RSC streaming). */
  dev: boolean;
  /** The admin URL segment, already validated as a plain slug. */
  adminSegment: string;
  /** The site's locales; each may prefix a page. */
  locales: readonly string[];
}

/**
 * First path segments that are never a CMS page. Whole segments: `/shopping-guide`
 * is a page, `/shop/x` is not.
 */
export const FIXED_ROUTE_SEGMENTS: readonly string[] = [
  'api',
  'admin',
  '_next',
  '_vercel',
  '_ws',
  'checkout',
  'cart',
  'account',
  'order',
  'shop',
  'booking',
  'wishlist',
  'legal',
  'page-not-found',
];

/** reCAPTCHA v2: script from both hosts, the challenge iframe and its XHR from www.google.com. */
export const RECAPTCHA_SCRIPT_HOSTS = ['https://www.google.com', 'https://www.gstatic.com'] as const;
export const RECAPTCHA_FRAME_HOSTS = ['https://www.google.com'] as const;
export const RECAPTCHA_CONNECT_HOSTS = ['https://www.google.com'] as const;

/**
 * The strict production CSP, with NO tracking host in it.
 *
 * Google and Meta hosts are added per request, and only while their ID is set
 * (`pageCsp`, applied by the proxy to every page it serves). Responses the proxy
 * never sees — the API, files, Next internals — load no tag, so they get this.
 *
 *   - `script-src 'unsafe-inline'`: inline JSON-LD on every content page, and
 *     the consent-gated tag snippets. Nonces would need wiring on every route.
 *   - `style-src 'unsafe-inline'`: Tailwind arbitrary values.
 *   - `data:` for fonts and small images the bundler inlines.
 *   - `frame-ancestors 'none'`: nobody frames the site (as X-Frame-Options DENY).
 */
export const STRICT_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
];

/**
 * Google tag hosts, needed when a GA4 or GTM ID is set: the tag scripts, GA4's
 * collection endpoints (`region1.analytics.google.com` and friends), and the
 * Google Ads conversion endpoints a GTM container may fire.
 */
export const GOOGLE_TAG_HOSTS = {
  script: ['https://www.googletagmanager.com', 'https://googleads.g.doubleclick.net', 'https://www.googleadservices.com'],
  connect: [
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    'https://*.google-analytics.com',
    'https://*.analytics.google.com',
    'https://googleads.g.doubleclick.net',
    'https://www.googleadservices.com',
    // Google Ads' first-party conversion ping (`/pagead/1p-conversion`).
    'https://www.google.com',
  ],
  img: [
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    'https://*.google-analytics.com',
    'https://*.analytics.google.com',
    'https://googleads.g.doubleclick.net',
    'https://www.googleadservices.com',
    'https://www.google.com',
  ],
} as const;

/** Meta Pixel hosts, needed when a Pixel ID is set (direct or via GTM). */
export const META_PIXEL_HOSTS = {
  script: ['https://connect.facebook.net'],
  connect: ['https://connect.facebook.net', 'https://www.facebook.com'],
  img: ['https://www.facebook.com'],
} as const;

/** Add hosts to one directive, creating it (from `'self'`) when absent. */
function extend(directives: readonly string[], name: string, hosts: readonly string[]): string[] {
  const prefix = `${name} `;
  const index = directives.findIndex((d) => d.startsWith(prefix));
  if (index === -1) return [...directives, `${name} 'self' ${hosts.join(' ')}`];
  const existing = directives[index];
  const missing = hosts.filter((h) => !existing.split(' ').includes(h));
  if (missing.length === 0) return [...directives];
  const next = [...directives];
  next[index] = `${existing} ${missing.join(' ')}`;
  return next;
}

export function strictCsp(): string {
  return STRICT_CSP_DIRECTIVES.join('; ');
}

/** The strict CSP plus exactly the reCAPTCHA allowances. */
export function thirdPartyCsp(): string {
  let d = [...STRICT_CSP_DIRECTIVES];
  d = extend(d, 'script-src', RECAPTCHA_SCRIPT_HOSTS);
  d = extend(d, 'connect-src', RECAPTCHA_CONNECT_HOSTS);
  d = extend(d, 'frame-src', RECAPTCHA_FRAME_HOSTS);
  return d.join('; ');
}

export interface PageCspOptions {
  /** A page that may carry a public form: reCAPTCHA allowed (the only iframe). */
  thirdParty: boolean;
  /** A GA4 or GTM ID is set. */
  google: boolean;
  /** A Meta Pixel ID is set. */
  meta: boolean;
}

/**
 * The CSP for one page, as the proxy sends it. Tracking hosts never get
 * `frame-src`: no `<noscript>` iframe is rendered, and the site's only iframe
 * is reCAPTCHA's challenge.
 */
export function pageCsp({ thirdParty, google, meta }: PageCspOptions): string {
  let d = thirdParty ? thirdPartyCsp().split('; ') : [...STRICT_CSP_DIRECTIVES];
  for (const [on, hosts] of [
    [google, GOOGLE_TAG_HOSTS],
    [meta, META_PIXEL_HOSTS],
  ] as const) {
    if (!on) continue;
    d = extend(d, 'script-src', hosts.script);
    d = extend(d, 'connect-src', hosts.connect);
    d = extend(d, 'img-src', hosts.img);
  }
  return d.join('; ');
}

export const BASE_SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // DENY is about who may frame US; it says nothing about the frames we embed.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
  {
    key: 'Permissions-Policy',
    value: 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `/:slug(...)` source: one page segment, optionally after a locale, never a
 * fixed route and never a file (no dot).
 */
export function pageSlugSource(locales: readonly string[], adminSegment: string): string {
  const fixed = [...new Set([...FIXED_ROUTE_SEGMENTS, adminSegment])].map(escapeRegex).join('|');
  const prefix = locales.length > 0 ? `(?:(?:${locales.map(escapeRegex).join('|')})/)?` : '';
  return `/:slug(${prefix}(?!(?:${fixed})(?:/|$))[^/.]+)`;
}

/**
 * Whether `pathname` gets the third-party policy — the runtime twin of the two
 * `next.config.ts` sources (`/` and `pageSlugSource`), for the proxy, which
 * builds the page CSP itself. `test/core/page-csp.test.ts` holds the two to
 * the same answers through Next's matcher.
 */
export function isThirdPartyPagePath(pathname: string, locales: readonly string[], adminSegment: string): boolean {
  if (pathname === '/') return true;
  const booking = bookingFormSource(locales).slice('/:path('.length, -1);
  if (new RegExp(`^/(?:${booking})$`).test(pathname)) return true;
  const source = pageSlugSource(locales, adminSegment);
  const pattern = source.slice('/:slug('.length, -1);
  return new RegExp(`^/(?:${pattern})$`).test(pathname);
}

/**
 * The experience page, `/booking/<slug>` — the one page under `/booking` that
 * carries a public form (the booking request). The listing, the guest lookup
 * and the pay page stay strict.
 */
const BOOKING_NON_FORM_PAGES = ['lookup', 'pay'] as const;

/** `path-to-regexp` source for the experience pages, with or without a locale. */
export function bookingFormSource(locales: readonly string[]): string {
  const prefix = locales.length > 0 ? `(?:(?:${locales.map(escapeRegex).join('|')})/)?` : '';
  return `/:path(${prefix}booking/(?!(?:${BOOKING_NON_FORM_PAGES.join('|')})(?:/|$))[^/.]+)`;
}

export function buildHeaderRules({ dev, adminSegment, locales }: HeaderRuleOptions): HeaderRule[] {
  const strict = dev
    ? [...BASE_SECURITY_HEADERS]
    : [...BASE_SECURITY_HEADERS, { key: 'Content-Security-Policy', value: strictCsp() }];

  /*
   * Explicitly `unsafe-none`, not omitted: the site-wide rule has already set
   * COEP, and a later rule only overrides a key it names. `unsafe-none` is the
   * value the header has when nobody sends it.
   */
  const thirdParty = [
    ...BASE_SECURITY_HEADERS.map((h) =>
      h.key === 'Cross-Origin-Embedder-Policy' ? { key: h.key, value: 'unsafe-none' } : h,
    ),
    ...(dev ? [] : [{ key: 'Content-Security-Policy', value: thirdPartyCsp() }]),
  ];

  /*
   * Order matters: Next applies every matching rule in turn with `setHeader`,
   * so the specific rules come after the site-wide one and win on shared keys.
   */
  return [
    { source: '/:path*', headers: strict },
    { source: '/', headers: thirdParty },
    { source: pageSlugSource(locales, adminSegment), headers: thirdParty },
    { source: bookingFormSource(locales), headers: thirdParty },
    { source: `/${adminSegment}`, headers: thirdParty },
    { source: `/${adminSegment}/:path*`, headers: thirdParty },
  ];
}
