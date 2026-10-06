/**
 * The brand's DEFAULTS — what the site shows before anything is saved in
 * Admin → Settings → Branding, or when the database cannot be reached.
 *
 * The live name, contact details, socials, logo and colours are stored in the
 * database (`brand.identity`, `brand.palette`) so a CMS update never overwrites
 * them; `npm run db:brand-import` copies this file (and the `@theme` colours in
 * globals.css) there once. `url`/`domain` stay here: they are deploy settings.
 * Plain data with no imports.
 */
export const brand = {
  name: 'CMS Demo',
  legalName: 'CMS Demo',
  tagline: 'Ιστότοπος επίδειξης όλων των δυνατοτήτων του CMS.',
  domain: 'cms-demo.gr',
  /** The production origin. Also `productionOrigin` in site.config.ts. */
  url: 'https://cms-demo.gr',
  email: 'info@cms-demo.gr',
  /** As shown to visitors. */
  phone: '',
  /** For `tel:` links: digits and a leading +, nothing else. */
  phoneHref: '',
  address: {
    street: '',
    city: '',
    postcode: '',
    /** ISO 3166-1 alpha-2. */
    country: 'GR',
  },
  /** Profile URLs. Empty ones are simply not shown. */
  socials: {

  } as Record<string, string>,
  /** Browser chrome tint on mobile. Pick it with the rest of the palette. */
  themeColor: '#111827',
} as const;
