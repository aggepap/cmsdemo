/**
 * Managed site settings — the keys the admin Settings form edits and the API
 * allows. Plain data (no `server-only`) so the admin form (client) can render
 * from the same descriptor the API validates against.
 *
 * Values live in the `site_settings` KV store. Module toggles are handled
 * separately (derived from the config's module list) via `moduleSettingKey`.
 */
import { ANALYTICS_TRACKING_KEY } from '../analytics/catalog';
import { CUSTOM_EVENTS_KEY } from '../analytics/custom-events';
import { GOOGLE_ADS_KEY } from '../analytics/google-ads';
import { META_CAPI_KEY } from '../analytics/meta-capi-settings';
import { BRAND_IDENTITY_KEY, BRAND_PALETTE_KEY } from '../brand/policy';
import { SCHEMA_POLICY_KEY } from '../structured-data/policy';
import { ANALYTICS_GA_ID_KEY } from './analytics';
import { ANNOUNCEMENT_KEY } from './announcement';
import { PUBLIC_FORMS_CAPTCHA_KEY } from './captcha';
import {
  FORM_ATTACHMENT_DEFAULT_MAX_MB,
  FORM_ATTACHMENT_DEFAULT_TYPES,
  FORM_ATTACHMENT_ENABLED_KEY,
  FORM_ATTACHMENT_KINDS,
  FORM_ATTACHMENT_MAX_MB_KEY,
  FORM_ATTACHMENT_MAX_MB_OPTIONS,
  FORM_ATTACHMENT_TYPES,
  FORM_ATTACHMENT_TYPES_KEY,
} from '../forms/attachments';
import {
  FORMS_RETENTION_DAYS_KEY,
  FORMS_SENSITIVE_RETENTION_DAYS_KEY,
  FORMS_SENSITIVE_TYPES_KEY,
} from '../forms/policy';
import {
  ANALYTICS_GA4_VIA_GTM_KEY,
  ANALYTICS_GTM_ID_KEY,
  ANALYTICS_MARKETING_GROUP,
  GTM_ID_PATTERN,
  MARKETING_META_DOMAIN_VERIFICATION_KEY,
  MARKETING_META_PIXEL_ID_KEY,
  MARKETING_META_PIXEL_VIA_GTM_KEY,
  META_DOMAIN_VERIFICATION_PATTERN,
  META_PIXEL_ID_PATTERN,
} from './marketing';
import { MENUS_KEY } from './menus';

export type SettingFieldType =
  | 'text'
  | 'email'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'money'
  | 'gaId'
  | 'boolean';

/**
 * The stored values of a `boolean` setting. Text, like every other setting, so
 * the form state, the PATCH body and the column keep one shape.
 */
export const BOOLEAN_SETTING_VALUES = ['on', 'off'] as const;

/**
 * Read a `boolean` setting. Only exactly `on` is true: an unset key, and any
 * value that is not `on`, means off. The default lives here rather than only in
 * `defaultValue`, for the reason given on `SECURITY_REQUIRE_2FA_KEY` below — a
 * feature must never switch itself on because nobody has saved the form yet.
 */
export function readBooleanSetting(raw: unknown): boolean {
  return raw === 'on';
}

/**
 * A `multiselect` stores its chosen values as a comma-separated string.
 *
 * Every other setting is a string end to end — the form state, the PATCH body,
 * the `site_settings` value. Making one setting a JSON array would have meant a
 * second shape through all three, so the list is encoded instead and parsed at
 * the two edges. `parseMultiValue` is the only reader; nothing else should
 * split on commas by hand.
 */
export function parseMultiValue(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The stored form of a chosen set. Order follows the caller, deduped. */
export function formatMultiValue(values: readonly string[]): string {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].join(',');
}

/**
 * Whether every administrator must have a second factor.
 *
 * Read as `=== 'on'`, so an unset key — and any value that is not exactly `on`
 * — means optional. That default is deliberate and belongs in the READER, not
 * only in `defaultValue` below: `defaultValue` is what the form shows, and it
 * is not written to `site_settings` until an operator saves. A security toggle
 * that defaulted to "required" on an unsaved key would lock every existing
 * administrator out of a deploy that had never opted in.
 */
export const SECURITY_REQUIRE_2FA_KEY = 'security.require2fa';

export interface SettingFieldDef {
  key: string;
  label: string;
  type: SettingFieldType;
  group: string;
  description?: string;
  placeholder?: string;
  /** Options for `select` and `multiselect` fields. */
  options?: { value: string; label?: string }[];
  /**
   * `multiselect` only: retired values and what they now stand for. The form
   * ticks the replacements and the validator stores them, so a value saved
   * before an option was split never blocks a save (see `expandMultiValueAliases`).
   */
  aliases?: Readonly<Record<string, readonly string[]>>;
  /**
   * What the form shows when nothing is stored, and what the reader falls back
   * to — stated once here rather than in both.
   *
   * It matters most for `multiselect`: an unset value renders as no boxes
   * ticked, which reads as "we sell neither" when it actually means "we have
   * not been asked yet". The value is NOT written until the operator saves.
   */
  defaultValue?: string;
  /**
   * An allow-list for a `text` field whose value lands in a script or a meta
   * tag: the write boundary refuses anything else, with `hint` as the message.
   * Empty always passes (it clears the setting).
   */
  pattern?: { regex: RegExp; hint: string };
  /**
   * Module this setting belongs to. Its tab is hidden while that module is
   * switched off — a currency for a shop nobody can reach is a question with no
   * answer. The value is still stored and still sent on save, so switching the
   * module back on restores the settings rather than losing them.
   */
  module?: string;
}

/** The `site_settings` key holding the site-wide product currency (ISO 4217). */
export const ECOMMERCE_CURRENCY_KEY = 'ecommerce.currency';
/** Selectable product currencies, and the fallback when the setting is unset. */
export const ECOMMERCE_CURRENCIES = ['EUR', 'USD', 'GBP'] as const;
export const DEFAULT_CURRENCY = ECOMMERCE_CURRENCIES[0];

/**
 * The `site_settings` key holding the shop's enabled payment methods — a
 * `multiselect`, so several can be on and the customer picks one at checkout.
 * It held a single key before; a stored `viva` reads as `[viva]`, so the key
 * and its stored values carried over unchanged.
 */
export const ECOMMERCE_PAYMENT_PROVIDER_KEY = 'ecommerce.paymentProvider';
/** Fallback payment provider — offline/manual (pay on delivery) when no gateway
 *  has been chosen. */
export const DEFAULT_PAYMENT_PROVIDER = 'manual';

/**
 * The gateways a site can choose between, as rendered options.
 *
 * Deliberately a literal rather than `paymentProviderKeys()`: this file is
 * plain data with no `server-only`, so the admin form can render from the same
 * descriptor the API validates against, and reaching into the registry would
 * drag the provider implementations — and their secrets — toward the client.
 * The booking select uses this list; the shop's derives from it below.
 */
export const PAYMENT_PROVIDER_OPTIONS: { value: string; label?: string }[] = [
  { value: 'manual', label: 'Manual / bank transfer' },
  { value: 'stripe', label: 'Card (Stripe)' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'viva', label: 'Viva.com (card)' },
  { value: 'klarna', label: 'Klarna' },
];

/** Every provider key a payment setting may hold — the readers drop anything else. */
export const PAYMENT_PROVIDER_KEYS: readonly string[] = PAYMENT_PROVIDER_OPTIONS.map((o) => o.value);

/**
 * The shop's own list: `manual` split into bank transfer and cash on delivery.
 *
 * Bookings keep `PAYMENT_PROVIDER_OPTIONS` — a booking has no courier to hand
 * cash to, so "manual" still means exactly one thing there. The shop needed
 * the two apart: only cash on delivery narrows the couriers, carries the COD
 * fee and puts an amount on the voucher.
 */
export const ECOMMERCE_PAYMENT_PROVIDER_OPTIONS: { value: string; label?: string }[] = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cod', label: 'Cash on delivery' },
  ...PAYMENT_PROVIDER_OPTIONS.filter((o) => o.value !== 'manual'),
];
export const ECOMMERCE_PAYMENT_PROVIDER_KEYS: readonly string[] = ECOMMERCE_PAYMENT_PROVIDER_OPTIONS.map(
  (o) => o.value
);

/**
 * A shop setting saved before the split may still say `manual`. It reads — and
 * re-saves — as both offline methods, in its place: the shop that offered
 * "bank transfer or pay on delivery" yesterday offers the same two today, now
 * told apart. Migrated on read rather than by a data migration, so a value
 * imported from an older site is handled the same way.
 */
export const ECOMMERCE_PAYMENT_PROVIDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  manual: ['bank_transfer', 'cod'],
};
/** What the shop takes when nothing usable is ticked — what `manual` did. */
export const DEFAULT_ECOMMERCE_PAYMENT_PROVIDERS: readonly string[] = ECOMMERCE_PAYMENT_PROVIDER_ALIASES.manual;

/**
 * Replace each aliased value with what it stands for, in place, deduped.
 * The one place an alias is expanded, so the form, the validator and the
 * reader cannot disagree about what a stored `manual` means.
 */
export function expandMultiValueAliases(
  values: readonly string[],
  aliases: Readonly<Record<string, readonly string[]>> | undefined
): string[] {
  const out = values.flatMap((v) => (aliases && Object.hasOwn(aliases, v) ? aliases[v] : [v]));
  return [...new Set(out)];
}

/**
 * How to pay by bank transfer — bank, IBAN, beneficiary, "use the order
 * reference". One free-text box per language the base ships copy for; the
 * reader falls back to the other when the customer's is empty. Shown in the
 * order confirmation email and on the thank-you page, for bank transfer only.
 */
export const BANK_TRANSFER_INSTRUCTIONS_KEYS = {
  el: 'ecommerce.bankTransferInstructions.el',
  en: 'ecommerce.bankTransferInstructions.en',
} as const;

/**
 * The shop's VAT rate, as a percentage. Prices stay VAT-inclusive; this says
 * how much of them is VAT, for gateways that itemise (Klarna). A product can
 * carry its own rate for reduced-rate goods.
 */
export const ECOMMERCE_VAT_RATE_KEY = 'ecommerce.vatRate';

/** The `site_settings` key holding the (structured JSON) shipping config. */
export const ECOMMERCE_SHIPPING_KEY = 'ecommerce.shipping';
/** The `site_settings` key holding the (structured JSON) coupon list. */
export const ECOMMERCE_COUPONS_KEY = 'ecommerce.coupons';

/** The `site_settings` key holding the gift-wrap fee (major units, e.g. "3.50"). */
export const ECOMMERCE_GIFTWRAP_FEE_KEY = 'ecommerce.giftWrapFee';

/* ── Booking ─────────────────────────────────────────────────────────────── */

/**
 * Booking currency. Deliberately its own key rather than reusing
 * `ecommerce.currency`: the booking module has to work with commerce switched
 * off. The reader falls back to the commerce currency, then to EUR, so a site
 * that already chose one does not have to say it twice.
 */
export const BOOKING_CURRENCY_KEY = 'booking.currency';

/**
 * What this site actually sells — one or more booking kinds.
 *
 * A site that only charters boats never wants to see nightly rates and
 * check-out days, and one that only lets villas never wants party-size
 * brackets. When exactly one kind is sold, the "Booking type" selector
 * disappears from the experience editor and that kind's form is simply what an
 * experience is — one fewer decision on every new experience.
 *
 * A LIST rather than a `transport | stay | both` enum, because "both" does not
 * survive a third kind: expressing every combination of n kinds needs 2ⁿ−1
 * options. Adding a kind here is now one entry in `BOOKING_KINDS`, and the
 * stored format does not change.
 */
export const BOOKING_KINDS_KEY = 'booking.kinds';
export const BOOKING_KINDS = ['transport', 'stay'] as const;
export type BookingKindValue = (typeof BOOKING_KINDS)[number];
/** Unset means every kind is available — showing the selector rather than
 *  silently committing a site to one kind it never chose. */
export const DEFAULT_BOOKING_KINDS: readonly BookingKindValue[] = BOOKING_KINDS;

/** Whether a customer asks first (`request`) or books outright (`instant`). */
export const BOOKING_MODE_KEY = 'booking.mode';
export const BOOKING_MODES = ['request', 'instant'] as const;
export const DEFAULT_BOOKING_MODE = BOOKING_MODES[0];

/** Customers never see an amount (G1). Read by `getBookingPolicy`; only exactly `on` hides. */
export const BOOKING_HIDE_PRICES_KEY = 'booking.hidePrices';
/** Accepting a request confirms it; the site takes no payment (G2). Only exactly `on` switches it on. */
export const BOOKING_REQUEST_ONLY_KEY = 'booking.requestOnly';

/** IANA timezone the booking calendar's dates are reckoned in. */
export const BOOKING_TIMEZONE_KEY = 'booking.timezone';
export const DEFAULT_BOOKING_TIMEZONE = 'Europe/Athens';

/** How long a pending enquiry stays open before it lapses. */
export const BOOKING_REQUEST_EXPIRY_KEY = 'booking.requestExpiryHours';
/** How long an instant-checkout hold survives an abandoned payment page. */
export const BOOKING_PAYMENT_HOLD_KEY = 'booking.paymentHoldMinutes';
/** How long an emailed payment link stays valid. */
export const BOOKING_PAYMENT_LINK_EXPIRY_KEY = 'booking.paymentLinkExpiryDays';
/** Percentage of the total charged up front. 0 or empty = the full amount. */
export const BOOKING_DEPOSIT_PERCENT_KEY = 'booking.depositPercent';
/** Where new booking requests are announced (one address per line). */
export const BOOKING_NOTIFICATION_EMAILS_KEY = 'booking.notificationEmails';
/** Places per day for an item that does not set its own. */
export const BOOKING_DEFAULT_CAPACITY_KEY = 'booking.defaultCapacity';
/** Hours before the start after which booking closes, unless the item overrides. */
export const BOOKING_LEAD_TIME_KEY = 'booking.leadTimeHours';
/**
 * Which payment methods a booking can be paid with — a `multiselect`; the
 * customer picks one on the pay page. `manual` = settle out of band.
 */
export const BOOKING_PAYMENT_PROVIDER_KEY = 'booking.paymentProvider';
/** How to pay when the provider is manual — bank details and the like, sent in the approval email. */
export const BOOKING_PAYMENT_INSTRUCTIONS_KEY = 'booking.paymentInstructions';

/**
 * Payment-method surcharges, as a percentage of the amount due.
 *
 * One key per gateway rather than a single number, because the rates genuinely
 * differ — the WordPress system this ports from charged 4% on cards and 5.25%
 * on PayPal. Applied at payment time; see `booking/payments.ts`.
 */
export const BOOKING_SURCHARGE_STRIPE_KEY = 'booking.surchargePercent.stripe';
export const BOOKING_SURCHARGE_PAYPAL_KEY = 'booking.surchargePercent.paypal';
export const BOOKING_SURCHARGE_VIVA_KEY = 'booking.surchargePercent.viva';
export const BOOKING_SURCHARGE_KLARNA_KEY = 'booking.surchargePercent.klarna';

/** The VAT rate contained in booking prices, as a percentage — for gateways that itemise. */
export const BOOKING_VAT_RATE_KEY = 'booking.vatRate';

/**
 * The `site_settings` key holding admin-defined custom field definitions,
 * shaped `Record<collectionKey, CustomFieldsConfig>` (see `core/fields`).
 */
export const CUSTOM_FIELDS_KEY = 'cms.customFields';

/**
 * The `site_settings` key holding the admin's edits to the BUILT-IN SEO/AEO
 * field set (see `core/seo/field-overrides`).
 *
 * Deltas only, and deliberately so: the fields themselves are declared in code,
 * so an absent row means "the shipped set", not "no SEO fields".
 */
export const SEO_FIELDS_KEY = 'cms.seoFields';

/**
 * Settings keys the API accepts that are NOT rendered by the generic settings
 * form — structured/JSON configs edited by bespoke admin screens (e.g. the
 * shipping settings). Added to the write allowlist alongside `MANAGED_SETTING_KEYS`.
 */
/** The `site_settings` key holding the (structured JSON) wishlist config. */
export const ECOMMERCE_WISHLIST_KEY = 'ecommerce.wishlist';

/** The `site_settings` key holding the (structured JSON) gift card config. */
export const ECOMMERCE_GIFTCARDS_KEY = 'ecommerce.giftCards';

/** The `site_settings` key holding the (structured JSON) Google reviews config. */
export const GOOGLE_REVIEWS_KEY = 'integrations.googleReviews';

export const EXTRA_MANAGED_KEYS: string[] = [
  BRAND_IDENTITY_KEY,
  BRAND_PALETTE_KEY,
  SCHEMA_POLICY_KEY,
  GOOGLE_REVIEWS_KEY,
  ECOMMERCE_SHIPPING_KEY,
  ECOMMERCE_COUPONS_KEY,
  ECOMMERCE_WISHLIST_KEY,
  ECOMMERCE_GIFTCARDS_KEY,
  CUSTOM_FIELDS_KEY,
  SEO_FIELDS_KEY,
  ANNOUNCEMENT_KEY,
  MENUS_KEY,
  ANALYTICS_TRACKING_KEY,
  CUSTOM_EVENTS_KEY,
  GOOGLE_ADS_KEY,
  META_CAPI_KEY,
];

export const MANAGED_SETTINGS: SettingFieldDef[] = [
  /*
   * "Support email" has a description because an owner cannot tell from the label
   * whether it goes on the public site, or is only used as a reply-to. The site
   * name lives in Settings → Branding (`brand.identity`).
   */
  {
    key: 'site.supportEmail',
    label: 'Support email',
    type: 'email',
    group: 'General',
    description:
      'Shown to visitors as the contact address, and used as the reply-to on notification emails.',
  },
  {
    key: ANALYTICS_GA_ID_KEY,
    label: 'GA4 Measurement ID',
    /*
     * Its own type, because this is the one managed setting whose reader puts it
     * inside a raw inline `<script>` rather than rendering it as text — see
     * `AnalyticsLoader`. A free-text box there is an injection waiting to happen
     * (F-063), and the shape is not a matter of taste: Google issues these as
     * `G-` followed by an alphanumeric id.
     */
    type: 'gaId',
    group: ANALYTICS_MARKETING_GROUP,
    placeholder: 'G-XXXXXXXXXX',
    description:
      'Loaded on every public page (production domain only, after the visitor accepts Analytics cookies) when set.',
  },
  {
    key: ANALYTICS_GTM_ID_KEY,
    label: 'Google Tag Manager container ID',
    type: 'text',
    group: ANALYTICS_MARKETING_GROUP,
    placeholder: 'GTM-XXXXXXX',
    pattern: { regex: GTM_ID_PATTERN, hint: 'looks like GTM-XXXXXXX — letters and digits only.' },
    description:
      'Loaded on every public page (production domain only) once the visitor accepts Analytics or Marketing cookies, with Google Consent Mode v2. No <noscript> iframe is added.',
  },
  {
    key: ANALYTICS_GA4_VIA_GTM_KEY,
    label: 'GA4 loads through Google Tag Manager',
    type: 'boolean',
    group: ANALYTICS_MARKETING_GROUP,
    defaultValue: 'off',
    description:
      'Ticked: the CMS does not load GA4 itself. It puts the Measurement ID in the dataLayer as cms_ga4_id, and the Google tag in your container reads it from a variable. Unticked: the CMS loads GA4 directly. Never both, so nothing is counted twice. Without a container ID, GA4 loads directly either way.',
  },
  {
    key: MARKETING_META_PIXEL_ID_KEY,
    label: 'Meta Pixel ID',
    type: 'text',
    group: ANALYTICS_MARKETING_GROUP,
    placeholder: '123456789012345',
    pattern: { regex: META_PIXEL_ID_PATTERN, hint: 'is the number Meta shows in Events Manager — digits only.' },
    description:
      'Loaded on every public page (production domain only) after the visitor accepts Marketing cookies. No <noscript> image is added.',
  },
  {
    key: MARKETING_META_PIXEL_VIA_GTM_KEY,
    label: 'Meta Pixel loads through Google Tag Manager',
    type: 'boolean',
    group: ANALYTICS_MARKETING_GROUP,
    defaultValue: 'off',
    description:
      'Ticked: the CMS does not load the Pixel itself; it puts the ID in the dataLayer as cms_meta_pixel_id for the Meta tag in your container. Never both. Without a container ID, the Pixel loads directly either way.',
  },
  {
    key: MARKETING_META_DOMAIN_VERIFICATION_KEY,
    label: 'Meta domain verification code',
    type: 'text',
    group: ANALYTICS_MARKETING_GROUP,
    placeholder: 'abc123def456…',
    pattern: {
      regex: META_DOMAIN_VERIFICATION_PATTERN,
      hint: 'is the content="…" value of the meta tag Meta gives you — letters and digits only.',
    },
    description:
      'From Meta Business Settings → Brand safety → Domains. Rendered as <meta name="facebook-domain-verification"> on every public page.',
  },
  {
    key: 'notifications.inquiryEmails',
    label: 'Inquiry notification emails',
    type: 'textarea',
    group: 'Notifications',
    description: 'Comma- or newline-separated recipients for form + quote notifications.',
  },
  {
    key: FORM_ATTACHMENT_ENABLED_KEY,
    label: 'Visitors can attach a file to the contact form',
    type: 'boolean',
    group: 'Forms',
    defaultValue: 'off',
    description:
      'Ticked: the contact form gets an optional file field, for the types and size below. ' +
      'Unticked: no file field, and the server refuses any file sent anyway.',
  },
  {
    key: FORM_ATTACHMENT_TYPES_KEY,
    label: 'File types allowed',
    type: 'multiselect',
    group: 'Forms',
    options: FORM_ATTACHMENT_TYPES.map((t) => ({ value: t, label: FORM_ATTACHMENT_KINDS[t].label })),
    defaultValue: FORM_ATTACHMENT_DEFAULT_TYPES,
    description:
      'One file per message, checked by its content, not only its name. Files are kept privately on the server ' +
      '(CMS_FORM_UPLOADS_DIR), never on the public site, and only people who can read submissions can ' +
      'download them from Submissions. The notification email names the file but does not carry it. ' +
      'With CLAMD_HOST or CLAMD_SOCKET set on the server, every file is virus-scanned first.',
  },
  {
    key: FORM_ATTACHMENT_MAX_MB_KEY,
    label: 'Largest attachment',
    type: 'select',
    group: 'Forms',
    options: FORM_ATTACHMENT_MAX_MB_OPTIONS.map((mb) => ({ value: mb, label: `${mb} MB` })),
    defaultValue: FORM_ATTACHMENT_DEFAULT_MAX_MB,
    description:
      'The web server must accept a request this large on /api/contact (Nginx client_max_body_size), ' +
      'or larger files fail before they reach the site.',
  },
  {
    key: FORMS_RETENTION_DAYS_KEY,
    label: 'Delete submissions after (days)',
    type: 'text',
    group: 'Forms',
    placeholder: 'Keep for ever',
    description:
      'Submissions older than this are deleted for good, with any attached file, each time your scheduler runs the forms-retention job. Empty keeps them for ever. Set it to what your privacy policy says.',
  },
  {
    key: FORMS_SENSITIVE_TYPES_KEY,
    label: 'Sensitive form types',
    type: 'textarea',
    group: 'Forms',
    placeholder: 'prescription',
    description:
      'One form type per line, as the Type column in Submissions shows it — for forms that collect health or other special data. Their content and files are hidden from anyone without the "Read sensitive form submissions" permission.',
  },
  {
    key: FORMS_SENSITIVE_RETENTION_DAYS_KEY,
    label: 'Delete sensitive submissions after (days)',
    type: 'text',
    group: 'Forms',
    placeholder: 'Same as above',
    description:
      'Usually shorter than the general period. Empty follows "Delete submissions after (days)".',
  },
  {
    key: 'seo.robotsExtraDisallow',
    label: 'robots.txt — extra Disallow',
    type: 'textarea',
    group: 'SEO',
    description: 'One path per line, appended to the generated robots.txt.',
  },
  {
    key: 'seo.sitemapExtraUrls',
    label: 'Sitemap — extra URLs',
    type: 'textarea',
    group: 'SEO',
    description: 'One absolute URL per line, appended to the generated sitemap.',
  },
  {
    key: ECOMMERCE_CURRENCY_KEY,
    label: 'Default currency',
    type: 'select',
    group: 'Ecommerce',
    module: 'commerce',
    options: ECOMMERCE_CURRENCIES.map((value) => ({ value })),
    description: 'Currency used for all product prices across the site.',
  },
  {
    key: ECOMMERCE_PAYMENT_PROVIDER_KEY,
    label: 'Payment methods',
    type: 'multiselect',
    group: 'Ecommerce',
    module: 'commerce',
    options: ECOMMERCE_PAYMENT_PROVIDER_OPTIONS,
    aliases: ECOMMERCE_PAYMENT_PROVIDER_ALIASES,
    defaultValue: DEFAULT_ECOMMERCE_PAYMENT_PROVIDERS.join(','),
    description:
      'How customers can pay for orders. Tick more than one and the customer chooses at checkout; the first ticked is preselected. Each gateway needs its API keys set in the server environment. Bank transfer orders wait until you mark them paid; only cash on delivery limits the delivery options to couriers that collect cash and adds its surcharge. With none ticked, both offline methods are offered.',
  },
  {
    key: BANK_TRANSFER_INSTRUCTIONS_KEYS.el,
    label: 'Bank transfer instructions (Greek)',
    type: 'textarea',
    group: 'Ecommerce',
    module: 'commerce',
    description:
      'How to pay by bank transfer — bank name, IBAN, beneficiary, and to use the order reference. Shown to customers who chose bank transfer, in the order confirmation email and on the thank-you page. If one language is left empty, the other is shown.',
  },
  {
    key: BANK_TRANSFER_INSTRUCTIONS_KEYS.en,
    label: 'Bank transfer instructions (English)',
    type: 'textarea',
    group: 'Ecommerce',
    module: 'commerce',
    description:
      'How to pay by bank transfer — bank name, IBAN, beneficiary, and to use the order reference. Shown to customers who chose bank transfer, in the order confirmation email and on the thank-you page. If one language is left empty, the other is shown.',
  },
  {
    key: ECOMMERCE_VAT_RATE_KEY,
    label: 'VAT rate (%)',
    type: 'text',
    group: 'Ecommerce',
    module: 'commerce',
    placeholder: '24',
    description:
      'The VAT included in your prices. Prices are not changed by it — it is sent to Klarna so the customer’s statement shows the VAT. A product can set its own rate (e.g. 13% or 6%). Leave empty for 24%.',
  },
  {
    key: ECOMMERCE_GIFTWRAP_FEE_KEY,
    label: 'Gift-wrap fee',
    type: 'money',
    group: 'Ecommerce',
    module: 'commerce',
    placeholder: '0.00',
    description: 'Charged when a customer chooses gift wrapping (major units). 0 or empty = free.',
  },
  {
    // Literal key for the same reason as the one below — `commerce/filters.ts`
    // owns the constant and the reader.
    key: 'ecommerce.filters.priceControl',
    label: 'Price filter',
    type: 'select',
    group: 'Ecommerce',
    module: 'commerce',
    options: [
      { value: 'slider', label: 'Slider with two handles' },
      { value: 'fields', label: 'From / to boxes' },
    ],
    defaultValue: 'slider',
    description:
      'How shoppers narrow by price in the shop sidebar. The from/to boxes are always there for keyboard and screen-reader use; this chooses whether the slider sits above them.',
  },
  {
    // Declared here as a literal key: this file is client-safe and must not
    // import the commerce module. `stale-orders.ts` owns the constant and reader.
    key: 'ecommerce.pendingOrderTtlHours',
    label: 'Cancel unpaid card orders after (hours)',
    type: 'text',
    group: 'Ecommerce',
    module: 'commerce',
    placeholder: '48',
    description:
      'An order sent to a payment page that was never paid is cancelled after this many hours, releasing anything it held. Bank-transfer and pay-on-delivery orders are never cancelled automatically. 0 turns this off. Runs when your scheduler calls the commerce-stale-orders job.',
  },
  {
    key: BOOKING_KINDS_KEY,
    label: 'What you take bookings for',
    type: 'multiselect',
    group: 'Booking',
    module: 'booking',
    defaultValue: DEFAULT_BOOKING_KINDS.join(','),
    options: [
      {
        value: 'transport',
        label: 'Transport — boats, helicopters, transfers (booked by the day)',
      },
      { value: 'stay', label: 'Stays — rooms, villas, apartments (booked by the night)' },
    ],
    description:
      'Tick one and the experience editor drops the "Booking type" selector and shows only that kind’s fields. Tick both and each experience picks for itself. Experiences already saved as another kind keep their own selector, so narrowing this later never strands one.',
  },
  {
    key: BOOKING_MODE_KEY,
    label: 'Booking mode',
    type: 'select',
    group: 'Booking',
    module: 'booking',
    options: [
      { value: 'request', label: 'Request first — you confirm, then the customer pays' },
      { value: 'instant', label: 'Instant — the customer books and pays straight away' },
    ],
    description:
      'The default for every experience. In request mode a date is only taken once you accept, so several people may ask about the same day. Individual experiences can override this.',
  },
  {
    key: BOOKING_HIDE_PRICES_KEY,
    label: 'Hide prices from customers',
    type: 'boolean',
    group: 'Booking',
    module: 'booking',
    defaultValue: 'off',
    description:
      'Ticked: no amount is shown to visitors or customers — not on the listing, the experience page, the form, the booking lookup or the emails, and not in the structured data. You still see every price here and in your notification emails. Every booking becomes a request, and an experience with no price at all can be requested. If you send a payment link, the pay page shows the amount — paying needs one.',
  },
  {
    key: BOOKING_REQUEST_ONLY_KEY,
    label: 'Requests only — no payment through the site',
    type: 'boolean',
    group: 'Booking',
    module: 'booking',
    defaultValue: 'off',
    description:
      'Ticked: every booking is a request, and "Accept" confirms it straight away. No payment link, no pay page and no payment instructions are ever sent — you arrange payment yourself. The booking mode and payment settings below are then not used.',
  },
  {
    key: BOOKING_CURRENCY_KEY,
    label: 'Booking currency',
    type: 'select',
    group: 'Booking',
    module: 'booking',
    options: ECOMMERCE_CURRENCIES.map((value) => ({ value })),
    description: 'Used for every booking price. Falls back to the shop currency when unset.',
  },
  {
    key: BOOKING_TIMEZONE_KEY,
    label: 'Timezone',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: DEFAULT_BOOKING_TIMEZONE,
    description:
      'IANA name, e.g. Europe/Athens. Booking dates are calendar days in this zone, so a late-evening booking is not filed under the next day.',
  },
  {
    key: BOOKING_NOTIFICATION_EMAILS_KEY,
    label: 'Notify these addresses',
    type: 'textarea',
    group: 'Booking',
    module: 'booking',
    description: 'One email address per line. They are told when a booking request arrives.',
  },
  {
    key: BOOKING_REQUEST_EXPIRY_KEY,
    label: 'Requests lapse after (hours)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '72',
    description:
      'How long an unanswered request stays open. It holds no date, so this only tidies the list.',
  },
  {
    key: BOOKING_PAYMENT_HOLD_KEY,
    label: 'Instant payment hold (minutes)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '20',
    description:
      'How long an instant booking holds its date while the customer pays. Be generous — a hold that expires mid-payment is worse than one held slightly too long.',
  },
  {
    key: BOOKING_PAYMENT_LINK_EXPIRY_KEY,
    label: 'Payment links expire after (days)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '7',
    description:
      'How long an emailed payment link works. It is also how long an accepted request holds its date while the customer pays: after this many days it expires, the date is released and the customer is told.',
  },
  {
    key: BOOKING_DEPOSIT_PERCENT_KEY,
    label: 'Deposit (%)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '0',
    description:
      'Charged up front, with the balance due later. 0 or empty asks for the full amount.',
  },
  {
    key: BOOKING_DEFAULT_CAPACITY_KEY,
    label: 'Default places per day',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '1',
    description: 'Used by any experience that does not set its own capacity.',
  },
  {
    key: BOOKING_PAYMENT_PROVIDER_KEY,
    label: 'Payment methods',
    type: 'multiselect',
    group: 'Booking',
    module: 'booking',
    options: PAYMENT_PROVIDER_OPTIONS,
    defaultValue: DEFAULT_PAYMENT_PROVIDER,
    description:
      'How customers can pay. With manual alone, an instant booking is confirmed straight away and settled out of band. With any gateway ticked, it awaits payment first and accepting a request emails a payment link; the customer then picks a method on the pay page. Choosing bank transfer there confirms the booking unpaid and emails the payment instructions.',
  },
  {
    key: BOOKING_PAYMENT_INSTRUCTIONS_KEY,
    label: 'Payment instructions',
    type: 'textarea',
    group: 'Booking',
    module: 'booking',
    description:
      'For manual payment (bank transfer, cash): how the customer should pay — bank name, IBAN, beneficiary, what to write as the reference. Included in the approval email when you accept a request, and in the confirmation of an instant booking. Not used with a card or PayPal gateway, which sends a payment link instead.',
  },
  {
    key: BOOKING_SURCHARGE_STRIPE_KEY,
    label: 'Card surcharge (%)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '0',
    description:
      'Added at payment time, not to the quoted price — when a customer asks for a price they have not chosen how to pay. Leave at 0 to absorb the fee.',
  },
  {
    key: BOOKING_SURCHARGE_PAYPAL_KEY,
    label: 'PayPal surcharge (%)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '0',
    description: 'As above, for PayPal.',
  },
  {
    key: BOOKING_SURCHARGE_VIVA_KEY,
    label: 'Viva.com surcharge (%)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '0',
    description: 'As above, for Viva.com.',
  },
  {
    key: BOOKING_SURCHARGE_KLARNA_KEY,
    label: 'Klarna surcharge (%)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '0',
    description: 'As above, for Klarna.',
  },
  {
    key: BOOKING_VAT_RATE_KEY,
    label: 'VAT rate (%)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '24',
    description:
      'The VAT included in booking prices. Prices are not changed by it — it is sent to Klarna so the customer’s statement shows the VAT. Leave empty for 24%.',
  },
  {
    key: BOOKING_LEAD_TIME_KEY,
    label: 'Default cut-off (hours before)',
    type: 'text',
    group: 'Booking',
    module: 'booking',
    placeholder: '0',
    description:
      'How close to the start a booking can still be made. An experience can override it.',
  },
  {
    key: SECURITY_REQUIRE_2FA_KEY,
    label: 'Require two-factor authentication',
    /*
     * A select rather than a checkbox because `SettingFieldType` has no boolean
     * and adding one means touching the generic form renderer for a single
     * field. Two named options also read better here than a tickbox: "Optional"
     * and "Required for all administrators" say what happens, which a bare
     * checkbox label does not.
     */
    type: 'select',
    group: 'Security',
    options: [
      { value: 'off', label: 'Optional — each administrator chooses' },
      { value: 'on', label: 'Required for all administrators' },
    ],
    defaultValue: 'off',
    description:
      'When required, an administrator without two-factor authentication is asked to set it up ' +
      'before they can sign in — no session is issued until they have. Existing accounts are not ' +
      'locked out; they enrol at their next sign-in.',
  },
  {
    key: PUBLIC_FORMS_CAPTCHA_KEY,
    label: 'Captcha on public forms',
    type: 'select',
    group: 'Security',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'recaptcha_v2', label: 'Google reCAPTCHA v2 (checkbox)' },
    ],
    defaultValue: 'off',
    description:
      'Asks visitors to tick "I am not a robot" before the contact form is sent. The widget loads ' +
      'only when someone starts filling the form in. The keys are set on the server ' +
      '(RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY in .env), not here — without both, or with ' +
      "Google's test keys in production, no captcha is shown even when this is on.",
  },
];

export const MANAGED_SETTING_KEYS: string[] = MANAGED_SETTINGS.map((f) => f.key);

export const MODULE_PREFIX = 'module.';

/** The `site_settings` key that overrides a config module flag. */
export function moduleSettingKey(name: string): string {
  return `${MODULE_PREFIX}${name}`;
}

/**
 * How a module toggle presents itself.
 *
 * Without an entry a module is titled by capitalising its key, which is fine
 * for `commerce` and `booking` and useless for an initialism: `pm` rendered as
 * "Pm", a switch whose name told you nothing about what it turns off. A module
 * whose consequences reach past the admin says so here rather than leaving the
 * operator to find out by flipping it.
 */
export const MODULE_LABELS: Record<
  string,
  {
    label: string;
    /** What the module does. Shown behind an "i" beside the toggle. */
    description?: string;
    /**
     * What switching it off does, starting "Off:". Printed under the toggle, never
     * hidden behind the "i": the consequence is what must not be missed.
     */
    offNote?: string;
  }
> = {
  commerce: {
    label: 'Commerce',
    description:
      'The online shop: products, cart and checkout on the site, and the Orders, Gift cards, Reviews and Abandoned carts screens here.',
    offNote:
      'Off: the shop pages and checkout stop answering and those screens are hidden. Products and orders are kept.',
  },
  booking: {
    label: 'Booking',
    description:
      'Bookable experiences: prices, availability and the booking form on the site, and the Reservations and Availability screens here.',
    offNote:
      'Off: the booking endpoints stop answering and those screens are hidden. Reservations are kept.',
  },
  newsletter: {
    label: 'Newsletter',
    description:
      'Signup capture for the footer band and the article sidebar cards, plus the newsletter tick on the contact brief and the marketing tick at checkout, and the Subscribers screen that manages the list.',
    offNote:
      'Off: every signup form disappears and the signup endpoint answers 404. Existing subscribers are kept, and switching it back on brings the forms back unchanged.',
  },
  googleReviews: {
    label: 'Google reviews & testimonials',
    description:
      'Pulls reviews from your Google Business Profile (or, with just an API key, the five Google shows publicly) and lets you place them in any page with a shortcode, alongside testimonials you type in yourself.',
    offNote: 'Off: the reviews stop appearing on the site. The synced reviews are kept.',
  },
  customers: {
    label: 'Customer accounts',
    description:
      'Lets shoppers create an account at checkout and come back to their order history and saved addresses. Checkout still works without one, and nothing about an existing guest order changes.',
    offNote:
      'Off: the account pages are hidden and the account endpoints answer 404. The accounts are kept, so switching it back on restores them.',
  },
  popups: {
    label: 'Popups',
    description: 'Popups shown over the page, each targeted at the paths you choose. They are edited under Popups in the content list.',
    offNote: 'Off: no popup is shown on the site. Your popups are kept.',
  },
  pm: {
    label: 'Praion.ai connection',
    description: 'The bridge Praion.ai reads and writes through, and the Praion.ai tab in Settings where keys are connected.',
    offNote:
      'Off: the kill switch for the whole integration — every Praion.ai endpoint answers 404, so syncs stop. Imported keys are kept (not revoked), and SEO already pushed stays live on the site.',
  },
};

/** Display name for a module toggle. */
export function moduleLabel(name: string): string {
  return MODULE_LABELS[name]?.label ?? name.charAt(0).toUpperCase() + name.slice(1);
}

// ──────────────────────────────────────────────────────────────────────────
// Language enablement
// ──────────────────────────────────────────────────────────────────────────

/**
 * The `site_settings` key holding runtime language enablement. Its value is a
 * `StoredLocaleSettings` object. Unlike the compile-time locale list (which
 * languages *exist* / are routable), this controls which installed locales are
 * currently editable in admin and which are live on the public site.
 */
export const I18N_LOCALES_KEY = 'i18n.locales';

/** Raw shape persisted under `i18n.locales`. Unset = all installed enabled. */
export interface StoredLocaleSettings {
  /** Locales that show a tab in the content editors. */
  editing?: string[];
  /** Locales live in the public picker / routable (subset of `editing`). */
  public?: string[];
}

/** Effective language enablement, resolved against the installed superset. */
export interface LocaleSettings {
  /** Installed (compile-time) locales — the universe that can route. */
  supported: string[];
  /** The fixed primary (URL-unprefixed default); always in both sets below. */
  main: string;
  /** Locales editable in admin (main + chosen extras). */
  editing: string[];
  /** Locales live on the public site (subset of `editing`). */
  public: string[];
}

/**
 * Members of `pool` that are selected, preserving `pool` order and always
 * including `must`. `selected === undefined` (unset) means "all of pool" — so
 * a fresh install with no stored value keeps every installed locale enabled.
 * Pure + dependency-free so both the settings API and the admin form share it.
 */
export function resolveLocaleSet(
  selected: string[] | undefined,
  pool: readonly string[],
  must: string
): string[] {
  const chosen = selected === undefined ? new Set(pool) : new Set(selected);
  chosen.add(must);
  return pool.filter((l) => chosen.has(l));
}
