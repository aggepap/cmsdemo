import createMDX from '@next/mdx';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

import { buildHeaderRules } from './src/cms/core/security/headers';
import { locales } from './src/lib/i18n/config';

const withNextIntl = createNextIntlPlugin('./src/lib/i18n/request.ts');

/**
 * MDX wrap: lets us author Insights + Cases content as `.mdx` files. No
 * remark/rehype plugins configured here — auto-generated heading IDs are
 * produced client-side in `src/mdx-components.tsx` via `github-slugger`
 * (the same library `rehype-slug` wraps), so the IDs stay identical
 * without needing function plugin references that Turbopack's dev loader
 * can't serialise.
 */
const withMDX = createMDX({});

/**
 * Deployment target: self-hosted Node (VPS) behind Nginx + PM2 + Cloudflare.
 * Run with `npm run build && npm run start` — no Vercel-specific features used.
 *
 * `images.formats` AVIF/WebP requires `sharp` (listed as a top-level dep);
 * Next 13+ delegates image optimisation to sharp on non-Vercel runtimes.
 *
 * If a smaller deploy footprint is ever needed, uncomment `output: 'standalone'`
 * and run `node .next/standalone/server.js` instead of `npm run start`.
 */
/**
 * App-layer security headers. Nginx handles the rest in production
 * (HSTS, the bulk of CSP), but mirroring the basics in `next.config.ts`
 * keeps dev + preview + any non-Nginx environment protected and gives
 * Next a single source of truth for headers it controls regardless of
 * the reverse proxy in front of it.
 */
/**
 * Content-Security-Policy at the app layer.
 *
 * Nginx in production layers its own (and HSTS) on top; this app-layer
 * policy is the floor that protects dev + preview + any non-Nginx env.
 * The chosen ruleset is the strictest that still allows:
 *   - inline JSON-LD via `dangerouslySetInnerHTML` (every content page
 *     emits a @graph block — using nonces would require server-side
 *     wiring on every route, which is not worth the migration cost
 *     when `script-src 'unsafe-inline'` already blocks every external
 *     untrusted host)
 *   - Tailwind's inline `style` attributes on a handful of arbitrary
 *     values (`style-src 'unsafe-inline'`)
 *   - Google Tag Manager / GA4 when (and only when) the cookie banner
 *     has enabled it — both the script src and the analytics endpoints
 *     are whitelisted, but the loader gates them behind consent in
 *     `AnalyticsLoader.tsx`, so a non-consenting visitor never triggers
 *     either domain
 *   - SVG logos + dynamic OG image routes via `/_next/image` (same-origin)
 *   - data: URIs for fonts the Next bundler may inline and for any
 *     small data-URL images
 *
 * `frame-ancestors 'none'` mirrors X-Frame-Options DENY (the modern
 * browser-preferred way to express the same constraint).
 *
 * If you add a third-party script (Plausible, Vercel Analytics, etc.)
 * you must whitelist it in `src/cms/core/security/headers.ts` AND in
 * `connect-src` for its beacon endpoint, otherwise the loader will
 * silently fail CSP.
 */
/**
 * `'unsafe-eval'` is React's dev-mode requirement (source-map
 * reconstruction, error-overlay callstacks across worker boundaries,
 * Turbopack HMR). React never uses `eval()` in production builds, so
 * production CSP omits it. Without this branch, `npm run dev` throws
 * "eval() is not supported in this environment" the moment React tries
 * to surface an error in the browser overlay.
 */
/**
 * Production-only Content-Security-Policy.
 *
 * Dev CSP was breaking the Turbopack HMR socket + RSC streaming flow
 * — combinations of `upgrade-insecure-requests` (silently upgrades
 * http://localhost to https://localhost, which doesn't exist),
 * `'unsafe-eval'` exemptions for source-map reconstruction, and ws:
 * allowances for the HMR socket each interacted with Next 16 dev mode
 * in ways that left `Failed to fetch RSC payload ... Falling back to
 * browser navigation` errors on every client-side route change.
 *
 * The CSP exists to protect *production*. Dev parity is a nice-to-have
 * but not worth a broken developer workflow. Production still gets the
 * full strict policy below; dev runs with no CSP header at all (the
 * other security headers — X-Frame-Options, Referrer-Policy, etc. —
 * still ship in both environments since they don't have this hazard).
 */
const IS_DEV = process.env.NODE_ENV !== 'production';

/*
 * The policies themselves — the strict one every response gets, and the
 * third-party one (reCAPTCHA allowed, no COEP) for pages that can carry a
 * public form and for the admin — live in `src/cms/core/security/headers.ts`,
 * where `test/core/route-headers.test.ts` checks every route against Next's own
 * matcher. Imported relatively: the `@/*` alias does not exist yet here.
 *
 * COOP `same-origin`: the site has no OAuth or payment popups that need
 * `window.opener`. COEP `credentialless` (not `require-corp`, which would
 * silently break GA for exactly the visitors who accepted cookies). CORP
 * `same-site`, not `same-origin`, so the apex and `www` hosts both get assets.
 */
/**
 * The admin URL segment, mirroring `getAdminPath()` in `src/cms/core/paths.ts`
 * — INCLUDING its slug rule. Duplicated rather than imported: this file is
 * loaded before the `@/*` path alias exists, so importing the real one fails at
 * config load. The two must agree, or the admin renders at one path while the
 * headers below protect another.
 *
 * The rule exists because this value is interpolated into a path-to-regexp
 * `source`: a segment carrying `:`, `(`, `*`, a space or a further slash either
 * breaks the pattern or matches something that is not the admin, and does it
 * silently. Anything that is not a plain slug falls back to the default, which
 * is what `getAdminPath()` will independently have resolved to as well.
 */
const ADMIN_SEGMENT = (() => {
  const raw = process.env.ADMIN_PATH?.trim().replace(/^\/+|\/+$/g, '');
  return raw && /^[A-Za-z0-9_-]+$/.test(raw) ? raw : 'admin';
})();

/**
 * Build directory, overridable per instance.
 *
 * Two dev servers run from this one checkout: the human's on :3002 against
 * `praion_v2`, and the agents' on :3003 against `praion_qa` (see `dev:qa`).
 * Next 16 keeps a dev lock inside the build directory and refuses to start a
 * second server that would share it — so the QA instance gets its own
 * `.next-qa`. Both are gitignored; nothing else reads this.
 */
const DIST_DIR = process.env.NEXT_DIST_DIR ?? '.next';

const nextConfig: NextConfig = {
  /**
   * Next 16.3 began writing `AGENTS.md` and a `CLAUDE.md` that imports it into
   * the project root on every dev run and build. Both are generated files in a
   * repo whose `.gitignore` blocks `*.md` precisely so that loose working
   * documents stay out — and a `CLAUDE.md` at the root is read as project
   * instructions by anyone running an AI agent here, which is a surprising
   * thing for a framework upgrade to start doing silently.
   *
   * Set to `true` to opt back in.
   */
  agentRules: false,
  /**
   * Next advertises itself in `X-Powered-By` on every response. It tells an
   * attacker which framework — and by extension which advisory list — to try
   * first, and it buys nothing in return. Cheapest hardening there is.
   */
  poweredByHeader: false,
  reactStrictMode: true,
  distDir: DIST_DIR,
  // output: 'standalone',
  pageExtensions: ['ts', 'tsx', 'mdx'],
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  async headers() {
    return [
      /*
       * Site-wide strict policy first, then the third-party policy on `/`, on
       * `/:slug(...)` (a CMS page, fixed routes excluded) and on the admin —
       * later rules override earlier ones key by key.
       */
      ...buildHeaderRules({ dev: IS_DEV, adminSegment: ADMIN_SEGMENT, locales }),
      /**
       * Static assets under `/public` — logos, favicons, the founder photo,
       * the OG background plates.
       *
       * Next serves everything in `/public` with `Cache-Control: public,
       * max-age=0`, so every one of these was re-downloaded on every visit
       * while `/_next/static/*` (which Next fingerprints and marks
       * `immutable`) cached correctly for a year. A whole-site crawl counted
       * ~80 such requests per page load.
       *
       * These filenames carry NO content hash, so `immutable` would be wrong:
       * replacing a logo would leave visitors on the stale one until the TTL
       * expired. A day of browser cache plus a week of `stale-while-revalidate`
       * gets the repeat-visit win while keeping a brand change visible within
       * a day — and revalidation still returns 304 for unchanged bytes.
       */
      {
        source: '/:path*.(svg|png|jpg|jpeg|gif|webp|avif|ico|webmanifest)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400, stale-while-revalidate=604800',
          },
        ],
      },
    ];
  },
  /**
   * The home copy lives in the CMS page with slug `home`, whose own URL would be
   * `/home` (or `/<locale>/home`). The home itself is `/` (or `/<locale>`), so
   * those URLs only ever redirect there — in whichever language is prefixed.
   */
  async redirects() {
    return [
      { source: '/home', destination: '/', permanent: true },
      { source: '/:locale(el|en)/home', destination: '/:locale', permanent: true },
    ];
  },
};

export default withNextIntl(withMDX(nextConfig));
