/**
 * The site's brand — who it is and what colours it wears — as data.
 *
 * Both live in `site_settings` and are edited in Admin → Settings → Branding, so a
 * CMS update (which replaces the core wholesale) can never repaint a live site, and
 * an owner never needs a deploy to change a phone number or an accent colour. Code
 * only supplies the defaults a fresh or unreachable database falls back to.
 *
 * Pure and client-safe: the admin screen, the settings validator, the read layer
 * and the email renderer all share these shapes, so there is exactly one answer to
 * "what is a valid brand".
 */
import { z } from 'zod';

/** `site_settings` key: name, contact details, socials and media references. */
export const BRAND_IDENTITY_KEY = 'brand.identity';
/** `site_settings` key: colour token → `#rrggbb`. */
export const BRAND_PALETTE_KEY = 'brand.palette';

/**
 * The colour tokens `globals.css` defines in `@theme`. The names are load-bearing
 * — the admin, shop and booking screens are styled with the utilities Tailwind
 * generates from them — so this list is fixed and only the values are editable.
 */
export const PALETTE_TOKENS = [
  {
    key: 'midnight-navy',
    group: 'Brand',
    label: 'Ink',
    hint: 'Dark surfaces: the footer and primary buttons.',
  },
  {
    key: 'warm-gold',
    group: 'Brand',
    label: 'Accent',
    hint: 'Highlights, eyebrows and hover states.',
  },
  {
    key: 'warm-gold-dark',
    group: 'Brand',
    label: 'Accent, darker',
    hint: 'Accent on hover and pressed.',
  },
  {
    key: 'warm-gold-deep',
    group: 'Brand',
    label: 'Accent text',
    hint: 'Accent-coloured text on a light background. Must stay readable (4.5:1).',
  },
  { key: 'soft-pearl', group: 'Surfaces', label: 'Page background', hint: 'Behind everything.' },
  {
    key: 'bone-cream',
    group: 'Surfaces',
    label: 'Raised surface',
    hint: 'Cards and subtle bands.',
  },
  { key: 'text-primary', group: 'Text', label: 'Main text', hint: 'Body copy and headings.' },
  {
    key: 'text-muted',
    group: 'Text',
    label: 'Secondary text',
    hint: 'Captions and supporting copy.',
  },
  {
    key: 'text-light',
    group: 'Text',
    label: 'Faint text',
    hint: 'Placeholders and disabled labels.',
  },
  {
    key: 'border-soft',
    group: 'Borders and states',
    label: 'Borders',
    hint: 'Dividers and input outlines.',
  },
  { key: 'error', group: 'Borders and states', label: 'Error', hint: 'Validation messages.' },
] as const;

export type PaletteToken = (typeof PALETTE_TOKENS)[number]['key'];
export type Palette = Record<PaletteToken, string>;

const TOKEN_KEYS = new Set<string>(PALETTE_TOKENS.map((t) => t.key));
const isToken = (key: string): key is PaletteToken => TOKEN_KEYS.has(key);

/** The neutral values of the base `globals.css`. */
export const BASE_PALETTE: Palette = {
  'midnight-navy': '#111827',
  'warm-gold': '#6b7280',
  'warm-gold-dark': '#4b5563',
  'warm-gold-deep': '#374151',
  'soft-pearl': '#ffffff',
  'bone-cream': '#f3f4f6',
  'text-primary': '#111827',
  'text-muted': '#4b5563',
  'text-light': '#9ca3af',
  'border-soft': '#e5e7eb',
  error: '#b91c1c',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = z
  .string()
  .regex(HEX, 'Use a six-digit colour such as #1b2430.')
  .transform((v) => v.toLowerCase());

/** Only the tokens sent are stored; the rest keep the stylesheet's values. */
export const brandPaletteSchema = z.record(z.string(), hex).superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (!isToken(key))
      ctx.addIssue({ code: 'custom', path: [key], message: 'Not a colour this site uses.' });
  }
});

const text = (max: number) => z.string().trim().max(max);
const mediaRef = z.string().uuid().nullable();
/** http(s) only: these are rendered as links. */
const httpUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .regex(/^https?:\/\//i);

const addressSchema = z
  .object({ street: text(200), city: text(120), postcode: text(20), country: text(120) })
  .strict();

// ── Opening hours ────────────────────────────────────────────────────────────

/** Two-letter day codes, Monday first — the order rows are stored and shown in. */
export const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().regex(TIME, 'Use a 24-hour time such as 09:00.');

/** A real calendar day as `YYYY-MM-DD` — `2026-02-30` is refused, not rolled over. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-06-01.')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'That date does not exist.');
const optionalDate = z.union([z.literal(''), isoDate]).default('');

/**
 * One row of opening hours: these days, these times, optionally only between two
 * dates — which is how summer and winter hours, or a holiday closure, are said.
 *
 * Closing earlier than opening means after midnight (a bar open 18:00–02:00), as
 * schema.org reads it. The same time twice is a mistake, except 00:00–00:00,
 * which is Google's way of saying "closed all day" for a dated row.
 */
export const openingHoursSpecSchema = z
  .object({
    days: z
      .array(z.enum(WEEKDAYS))
      .min(1, 'Pick at least one day.')
      .max(14)
      .transform((days) => WEEKDAYS.filter((d) => days.includes(d))),
    opens: time,
    closes: time,
    validFrom: optionalDate,
    validThrough: optionalDate,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.opens === row.closes && row.opens !== '00:00') {
      ctx.addIssue({
        code: 'custom',
        path: ['closes'],
        message: 'Opening and closing at the same time — use 00:00 to 00:00 for closed all day.',
      });
    }
    if (row.validFrom && row.validThrough && row.validThrough < row.validFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['validThrough'],
        message: 'The season ends before it starts.',
      });
    }
  });

export type OpeningHours = z.infer<typeof openingHoursSpecSchema>;

const openingHoursSchema = z.array(openingHoursSpecSchema).max(28).default([]);

// ── Store locations ──────────────────────────────────────────────────────────

/**
 * A shop or office beyond the main address. The `id` is a short slug the admin
 * generates once: it names the location's node in structured data, so it must
 * survive a rename or a reorder.
 */
export const storeLocationSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'A short id of letters, digits and dashes.'),
    name: z.string().trim().min(1, 'Each location needs a name.').max(120),
    address: addressSchema,
    phone: text(40).default(''),
    openingHours: openingHoursSchema,
    /** A maps link (Google Maps, Apple Maps…). */
    mapUrl: z.union([z.literal(''), httpUrl]).default(''),
    /** A 3D or 360° tour (Matterport, Google Street View…). */
    tourUrl: z.union([z.literal(''), httpUrl]).default(''),
    imageId: mediaRef.default(null),
  })
  .strict();

export type StoreLocation = z.infer<typeof storeLocationSchema>;

export const brandIdentitySchema = z
  .object({
    name: z.string().trim().min(1, 'The site needs a name.').max(120),
    legalName: text(200),
    tagline: text(300),
    email: z.union([z.literal(''), z.string().trim().email()]),
    phone: text(40),
    address: addressSchema,
    /** Network name → profile URL. */
    socials: z
      .record(z.string().regex(/^[a-z0-9-]{1,30}$/), httpUrl)
      .refine((s) => Object.keys(s).length <= 12, 'At most 12 social links.'),
    logoId: mediaRef,
    logoDarkId: mediaRef,
    faviconId: mediaRef,
    ogImageId: mediaRef,
    /** The main address's hours. Optional: an identity saved before it reads as none. */
    openingHours: openingHoursSchema,
    locations: z
      .array(storeLocationSchema)
      .max(50)
      .superRefine((list, ctx) => {
        const seen = new Set<string>();
        list.forEach((loc, i) => {
          if (seen.has(loc.id))
            ctx.addIssue({
              code: 'custom',
              path: [i, 'id'],
              message: 'Two locations share an id.',
            });
          seen.add(loc.id);
        });
      })
      .default([]),
  })
  .strict();

export type BrandIdentity = z.infer<typeof brandIdentitySchema>;

/** What code may supply as a fallback — typically `src/site.brand.ts`. */
export type BrandDefaults = Partial<Omit<BrandIdentity, 'address'>> & {
  address?: Partial<BrandIdentity['address']>;
};

/** The identity as the site reads it: stored, else code defaults, else empty. */
export function parseBrandIdentity(raw: unknown, defaults: BrandDefaults = {}): BrandIdentity {
  const stored = brandIdentitySchema.safeParse(raw);
  if (stored.success) return stored.data;
  return {
    name: defaults.name || 'Site',
    legalName: defaults.legalName ?? '',
    tagline: defaults.tagline ?? '',
    email: defaults.email ?? '',
    phone: defaults.phone ?? '',
    address: { street: '', city: '', postcode: '', country: '', ...defaults.address },
    socials: Object.fromEntries(Object.entries(defaults.socials ?? {}).filter(([, url]) => url)),
    logoId: defaults.logoId ?? null,
    logoDarkId: defaults.logoDarkId ?? null,
    faviconId: defaults.faviconId ?? null,
    ogImageId: defaults.ogImageId ?? null,
    openingHours: defaults.openingHours ?? [],
    locations: defaults.locations ?? [],
  };
}

/** Only the valid, known tokens of a stored value — never anything else. */
function storedTokens(raw: unknown): Partial<Palette> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Palette> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isToken(key) && typeof value === 'string' && HEX.test(value))
      out[key] = value.toLowerCase();
  }
  return out;
}

/** The full palette: stored tokens over the base. For emails and the admin form. */
export function parsePalette(raw: unknown): Palette {
  return { ...BASE_PALETTE, ...storedTokens(raw) };
}

/**
 * The stored tokens as CSS variables on `:root`.
 *
 * Only what is stored is emitted: with nothing saved the stylesheet's own values
 * stand. Every value has passed the hex check, so nothing here can close the
 * `<style>` element it is rendered into.
 */
export function paletteCss(raw: unknown): string {
  const entries = Object.entries(storedTokens(raw));
  if (entries.length === 0) return '';
  return `:root{${entries.map(([k, v]) => `--color-${k}:${v};`).join('')}}`;
}

const mediaUrl = (uuid: string | null): string | null =>
  uuid ? `/api/cms/media/file/${uuid}` : null;

const phoneHref = (phone: string): string => phone.replace(/[^\d+]/g, '');

/** A location as pages render it — on a contact page or in the footer. */
export interface SiteLocation extends StoreLocation {
  /** `tel:` target derived from `phone`. */
  phoneHref: string;
  imageUrl: string | null;
}

/** The brand as the front end, admin and emails consume it. */
export interface SiteBrand extends Omit<BrandIdentity, 'locations'> {
  locations: SiteLocation[];
  /** `tel:` target derived from `phone` — digits and a leading `+`. */
  phoneHref: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  palette: Palette;
}

export function resolveBrand(identity: BrandIdentity, palette: Palette): SiteBrand {
  return {
    ...identity,
    phoneHref: phoneHref(identity.phone),
    locations: identity.locations.map((loc) => ({
      ...loc,
      phoneHref: phoneHref(loc.phone),
      imageUrl: mediaUrl(loc.imageId),
    })),
    logoUrl: mediaUrl(identity.logoId),
    logoDarkUrl: mediaUrl(identity.logoDarkId),
    faviconUrl: mediaUrl(identity.faviconId),
    ogImageUrl: mediaUrl(identity.ogImageId),
    palette,
  };
}

/** The editable identity inside a resolved brand — what the Branding screen saves back. */
export function brandIdentityOf(brand: SiteBrand): BrandIdentity {
  return {
    name: brand.name,
    legalName: brand.legalName,
    tagline: brand.tagline,
    email: brand.email,
    phone: brand.phone,
    address: brand.address,
    socials: brand.socials,
    logoId: brand.logoId,
    logoDarkId: brand.logoDarkId,
    faviconId: brand.faviconId,
    ogImageId: brand.ogImageId,
    openingHours: brand.openingHours,
    locations: brand.locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      address: loc.address,
      phone: loc.phone,
      openingHours: loc.openingHours,
      mapUrl: loc.mapUrl,
      tourUrl: loc.tourUrl,
      imageId: loc.imageId,
    })),
  };
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const luminance = (value: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(value.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
