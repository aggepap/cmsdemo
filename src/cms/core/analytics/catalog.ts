/**
 * The analytics event catalogue (REQ-5 §3): one list, three profiles, two
 * switches per event.
 *
 * Plain data and pure functions — no `server-only`, no database — because three
 * readers share it: the admin's Events table, the public runtime that sends
 * events, and the GTM container export. If they read different lists, the
 * container would carry triggers for events the site never sends.
 *
 * Meta: an event with a standard equivalent goes as that standard event; one
 * without goes as a custom event under its own name (`trackCustom`) and is OFF
 * by default, so Meta's Events Manager is not filled with noise nobody asked for.
 */
import { z } from 'zod';

export const ANALYTICS_TRACKING_KEY = 'analytics.tracking';

export const ANALYTICS_PROFILES = ['website', 'eshop', 'booking'] as const;
export type AnalyticsProfile = (typeof ANALYTICS_PROFILES)[number];

export const PROFILE_LABELS: Record<AnalyticsProfile, string> = {
  website: 'Website',
  eshop: 'E-shop',
  booking: 'Booking',
};

export interface CatalogEvent {
  /** Stable id: the switches, the runtime and the GTM export address events by it. */
  id: string;
  /** The GA4 / dataLayer event name. */
  ga4: string;
  /** Meta: a standard event, a custom one of the same name, or none. */
  meta: { name: string; standard: boolean } | null;
  profiles: readonly AnalyticsProfile[];
  /** Event-specific parameters (beyond the common four). */
  params: readonly string[];
  /** Fixed GA4/dataLayer parameters this event always carries. */
  fixed?: Readonly<Record<string, string>>;
  /** Fixed Meta parameters this event always carries. */
  metaFixed?: Readonly<Record<string, string>>;
  /** When it fires, for the admin table. */
  when: string;
  /** Sent from the server (Measurement Protocol), not the browser. */
  serverOnly?: boolean;
}

/** Sent with every event. */
export const COMMON_EVENT_PARAMS = ['page_location', 'page_title', 'page_type', 'language'] as const;

const ALL: readonly AnalyticsProfile[] = ['website', 'eshop', 'booking'];
const SHOP: readonly AnalyticsProfile[] = ['eshop'];
const SHOP_AND_BOOKING: readonly AnalyticsProfile[] = ['eshop', 'booking'];
const ITEMS_VALUE = ['items', 'value', 'currency'] as const;

const standard = (name: string) => ({ name, standard: true });
const custom = (name: string) => ({ name, standard: false });

export const EVENT_CATALOG: readonly CatalogEvent[] = [
  { id: 'page_view', ga4: 'page_view', meta: standard('PageView'), profiles: ALL, params: [], when: 'Every page, and every page change without a reload.' },
  { id: 'search', ga4: 'search', meta: standard('Search'), profiles: ALL, params: ['search_term'], when: 'A site search returns results.' },
  { id: 'select_content', ga4: 'select_content', meta: custom('select_content'), profiles: ALL, params: ['content_type', 'content_id'], when: 'A click on a content card.' },
  { id: 'generate_lead', ga4: 'generate_lead', meta: standard('Lead'), profiles: ALL, params: ['form_id', 'form_name'], when: 'A form is accepted by the server (2xx).' },
  { id: 'click_to_call', ga4: 'click_to_call', meta: standard('Contact'), profiles: ALL, params: ['link_url'], when: 'A click on a tel: link.' },
  { id: 'click_to_email', ga4: 'click_to_email', meta: standard('Contact'), profiles: ALL, params: ['link_url'], when: 'A click on a mailto: link.' },
  { id: 'file_download', ga4: 'file_download', meta: custom('file_download'), profiles: ALL, params: ['file_name', 'file_extension', 'link_url'], when: 'A click on a link to a document (pdf, doc, xls, zip…).' },
  { id: 'newsletter_sign_up', ga4: 'sign_up', meta: standard('Lead'), profiles: ALL, params: ['method'], fixed: { method: 'newsletter' }, metaFixed: { lead_type: 'newsletter' }, when: 'A newsletter signup is accepted.' },
  { id: 'account_sign_up', ga4: 'sign_up', meta: standard('CompleteRegistration'), profiles: SHOP, params: ['method'], fixed: { method: 'email' }, when: 'A customer account is created.' },
  { id: 'login', ga4: 'login', meta: null, profiles: SHOP, params: ['method'], fixed: { method: 'email' }, when: 'A customer signs in.' },
  { id: 'view_item_list', ga4: 'view_item_list', meta: null, profiles: SHOP, params: ['item_list_id', 'items'], when: 'A product list is shown.' },
  { id: 'select_item', ga4: 'select_item', meta: custom('select_item'), profiles: SHOP, params: ['item_list_id', 'items'], when: 'A product is picked from a list.' },
  { id: 'view_item', ga4: 'view_item', meta: standard('ViewContent'), profiles: SHOP_AND_BOOKING, params: [...ITEMS_VALUE], when: 'A product or bookable service page is shown.' },
  { id: 'add_to_wishlist', ga4: 'add_to_wishlist', meta: standard('AddToWishlist'), profiles: SHOP, params: [...ITEMS_VALUE], when: 'A product is added to the wishlist.' },
  { id: 'add_to_cart', ga4: 'add_to_cart', meta: standard('AddToCart'), profiles: SHOP, params: [...ITEMS_VALUE], when: 'A product is added to the cart.' },
  { id: 'remove_from_cart', ga4: 'remove_from_cart', meta: null, profiles: SHOP, params: [...ITEMS_VALUE], when: 'A product is removed from the cart.' },
  { id: 'view_cart', ga4: 'view_cart', meta: null, profiles: SHOP, params: [...ITEMS_VALUE], when: 'The cart is opened.' },
  { id: 'begin_checkout', ga4: 'begin_checkout', meta: standard('InitiateCheckout'), profiles: SHOP_AND_BOOKING, params: [...ITEMS_VALUE], when: 'Checkout (or a booking) is started.' },
  { id: 'add_shipping_info', ga4: 'add_shipping_info', meta: null, profiles: SHOP, params: ['shipping_tier', ...ITEMS_VALUE], when: 'A shipping method is chosen at checkout.' },
  { id: 'add_payment_info', ga4: 'add_payment_info', meta: standard('AddPaymentInfo'), profiles: SHOP, params: ['payment_type', ...ITEMS_VALUE], when: 'A payment method is chosen at checkout.' },
  { id: 'add_coupon', ga4: 'add_coupon', meta: custom('add_coupon'), profiles: SHOP, params: ['coupon'], when: 'A coupon is accepted by the server.' },
  { id: 'purchase', ga4: 'purchase', meta: standard('Purchase'), profiles: SHOP_AND_BOOKING, params: ['transaction_id', 'value', 'tax', 'shipping', 'currency', 'coupon', 'items'], when: 'Once per order / instant booking, on its confirmation page — amounts from the server.' },
  { id: 'refund', ga4: 'refund', meta: null, profiles: SHOP_AND_BOOKING, params: ['transaction_id', 'value', 'currency'], when: 'A refund is recorded in the admin (sent from the server).', serverOnly: true },
];

const BY_ID = new Map(EVENT_CATALOG.map((e) => [e.id, e]));

export function catalogEvent(id: string): CatalogEvent | undefined {
  return BY_ID.get(id);
}

export interface EventSwitch {
  ga4: boolean;
  meta: boolean;
}

export type EventSwitches = Record<string, EventSwitch>;

/** The stored `analytics.tracking` value. */
export interface TrackingSettings {
  /** Chosen profiles; absent means "use the suggestion from the modules". */
  profiles?: AnalyticsProfile[];
  /** Admin overrides, per event; absent keys follow the profile default. */
  events?: Record<string, Partial<EventSwitch>>;
}

export const trackingSettingsSchema = z
  .object({
    profiles: z.array(z.enum(ANALYTICS_PROFILES)).max(ANALYTICS_PROFILES.length).optional(),
    events: z
      .record(
        z.string().refine((id) => BY_ID.has(id), { message: 'is not an event in the catalogue' }),
        z.object({ ga4: z.boolean().optional(), meta: z.boolean().optional() }).strict(),
      )
      .optional(),
  })
  .strict();

/** The profiles the modules suggest: Website always, plus E-shop / Booking. */
export function suggestProfiles(modules: { commerce: boolean; booking: boolean }): AnalyticsProfile[] {
  return ANALYTICS_PROFILES.filter(
    (p) => p === 'website' || (p === 'eshop' && modules.commerce) || (p === 'booking' && modules.booking),
  );
}

/** Read a stored value defensively: anything malformed reads as "nothing chosen". */
export function readTrackingSettings(raw: unknown): TrackingSettings {
  const parsed = trackingSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Every event's two switches: the profile default, then the admin's override.
 * Meta is never on for an event that has no Meta equivalent.
 */
export function resolveEventSwitches(
  settings: TrackingSettings,
  suggested: readonly AnalyticsProfile[] = ['website'],
): EventSwitches {
  const profiles = new Set(settings.profiles ?? suggested);
  const out: EventSwitches = {};
  for (const event of EVENT_CATALOG) {
    const inProfile = event.profiles.some((p) => profiles.has(p));
    const override = settings.events?.[event.id] ?? {};
    const ga4 = override.ga4 ?? inProfile;
    const meta = event.meta === null ? false : (override.meta ?? (inProfile && event.meta.standard));
    out[event.id] = { ga4, meta };
  }
  return out;
}

/**
 * Flip one switch, storing only what differs from the profile default — so a
 * later change of profile still moves every event the admin never touched.
 */
export function setEventSwitch(
  settings: TrackingSettings,
  suggested: readonly AnalyticsProfile[],
  id: string,
  destination: keyof EventSwitch,
  value: boolean,
): TrackingSettings {
  const defaults = resolveEventSwitches({ profiles: settings.profiles }, suggested)[id];
  const events = { ...(settings.events ?? {}) };
  const own = { ...(events[id] ?? {}) };
  if (defaults && defaults[destination] === value) delete own[destination];
  else own[destination] = value;
  if (Object.keys(own).length > 0) events[id] = own;
  else delete events[id];
  return { ...settings, events };
}
