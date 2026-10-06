/**
 * Turning one catalogue event into what each destination receives — as data.
 *
 * `runtime.ts` applies the result in the browser; keeping the decision pure lets
 * the rules be tested without one:
 *
 *   - the dataLayer gets the event when GTM is loaded and either switch is on
 *     (the container's own tags, generated from the same switches, decide where
 *     it goes next);
 *   - gtag.js / the Pixel get it when the CMS loads them directly, that switch
 *     is on, and the visitor consented to that category;
 *   - nothing at all without consent;
 *   - never personal data: emails, names, phones and addresses are stripped at
 *     every depth before anything leaves.
 */
import { catalogEvent, type EventSwitches } from '@/cms/core/analytics/catalog';
import type { CustomEvent } from '@/cms/core/analytics/custom-events';

import type { MarketingConsent } from './consent';

export type EventParams = Record<string, unknown>;

export interface DispatchContext {
  switches: EventSwitches;
  /** GTM is loaded on this page. */
  gtm: boolean;
  /** The CMS loaded gtag.js / the Pixel itself. */
  gtag: boolean;
  pixel: boolean;
  consent: MarketingConsent;
  /** `page_location`, `page_title`, `page_type`, `language`. */
  common: EventParams;
}

export interface Dispatch {
  dataLayer?: EventParams;
  gtag?: [string, string, EventParams];
  fbq?: [string, string, EventParams, { eventID: string }?];
}

/** Keys that name personal data. Matched as whole words in a snake/camel key. */
const PII_KEY = /(^|_)(e_?mail|phone|tel|telephone|mobile|name|first_?name|last_?name|full_?name|address|street|city|postcode|post_?code|zip|birthday|dob|ip)(_|$)/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Keys that look like PII but are not: catalogue parameters of the events themselves. */
const ALLOWED_KEYS = new Set(['form_name', 'item_name', 'item_list_name', 'file_name', 'tour_name', 'video_title']);

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

/** Personal data removed, at any depth. Email-looking strings are dropped wherever they sit. */
export function sanitizeParams(params: EventParams): EventParams {
  const out: EventParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED_KEYS.has(key) && PII_KEY.test(snake(key))) continue;
    const clean = sanitizeValue(value);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return EMAIL_VALUE.test(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(sanitizeValue).filter((v) => v !== undefined);
  if (value && typeof value === 'object') return sanitizeParams(value as EventParams);
  return value;
}

interface ItemLike {
  item_id?: unknown;
  quantity?: unknown;
}

/** GA4 ecommerce parameters → Meta's content parameters. */
function metaParams(params: EventParams): EventParams {
  const { items, ...rest } = params;
  const out: EventParams = { ...rest };
  if (Array.isArray(items) && items.length > 0) {
    const list = items as ItemLike[];
    const ids = list.map((i) => String(i.item_id ?? '')).filter(Boolean);
    out.content_ids = ids;
    out.contents = list
      .filter((i) => i.item_id !== undefined)
      .map((i) => ({ id: String(i.item_id), quantity: typeof i.quantity === 'number' ? i.quantity : 1 }));
    out.content_type = 'product';
    out.num_items = list.reduce((n, i) => n + (typeof i.quantity === 'number' ? i.quantity : 1), 0);
  }
  if (typeof rest.search_term === 'string') {
    out.search_string = rest.search_term;
    delete out.search_term;
  }
  return out;
}

export function dispatchEvent(id: string, params: EventParams, ctx: DispatchContext, eventId?: string): Dispatch {
  const event = catalogEvent(id);
  const switches = ctx.switches[id];
  if (!event || !switches || event.serverOnly) return {};
  if (!ctx.consent.analytics && !ctx.consent.marketing) return {};
  if (!switches.ga4 && !switches.meta) return {};

  const own = sanitizeParams({ ...params, ...(event.fixed ?? {}) });
  const metaParamsOut =
    event.meta && switches.meta ? metaParams(sanitizeParams({ ...params, ...(event.metaFixed ?? {}) })) : null;
  const out: Dispatch = {};

  if (ctx.gtm) {
    out.dataLayer = {
      event: event.ga4,
      ...ctx.common,
      ...own,
      ...(eventId ? { event_id: eventId } : {}),
      // What the container's Meta tag sends (`gtm-export.ts`): already mapped.
      ...(event.meta && metaParamsOut
        ? { cms_meta: { name: event.meta.name, method: event.meta.standard ? 'track' : 'trackCustom', params: metaParamsOut } }
        : {}),
    };
  }
  if (ctx.gtag && switches.ga4 && ctx.consent.analytics) {
    out.gtag = ['event', event.ga4, { ...ctx.common, ...own }];
  }
  if (ctx.pixel && metaParamsOut && ctx.consent.marketing && event.meta) {
    out.fbq = [
      event.meta.standard ? 'track' : 'trackCustom',
      event.meta.name,
      metaParamsOut,
      ...(eventId ? [{ eventID: eventId }] : []),
    ] as Dispatch['fbq'];
  }
  return out;
}

/**
 * What kind of page this is, for `page_type`. From the URL, because the routes
 * are fixed by the CMS base; a page that knows better says so with
 * `data-cms-page-type` (read by the runtime before this).
 */
export function pageTypeFor(pathname: string, locales: readonly string[]): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) segments.shift();
  const [first, second] = segments;
  if (!first) return 'home';
  switch (first) {
    case 'shop':
      return second ? 'product' : 'product_list';
    case 'booking':
      return second ? 'booking' : 'booking_list';
    case 'blog':
      return second ? 'article' : 'article_list';
    case 'cart':
    case 'checkout':
    case 'order':
    case 'account':
    case 'wishlist':
      return first;
    default:
      return 'page';
  }
}

/**
 * A custom event (Settings → Analytics & Marketing → Custom events): the
 * trigger's standard parameters plus the admin's fixed ones, to the dataLayer,
 * GA4 and — always as `trackCustom` — Meta, under the same rules as the
 * catalogue: switches, consent, no personal data.
 */
export function dispatchCustomEvent(
  event: CustomEvent,
  params: EventParams,
  ctx: Omit<DispatchContext, 'switches'>,
): Dispatch {
  if (!ctx.consent.analytics && !ctx.consent.marketing) return {};
  if (!event.ga4 && !event.meta) return {};
  const fixed = Object.fromEntries(event.params.map((p) => [p.key, p.value]));
  const own = sanitizeParams({ ...params, ...fixed });
  const out: Dispatch = {};
  if (ctx.gtm) {
    out.dataLayer = {
      event: event.name,
      ...ctx.common,
      ...own,
      ...(event.meta ? { cms_meta: { name: event.name, method: 'trackCustom', params: own } } : {}),
    };
  }
  if (ctx.gtag && event.ga4 && ctx.consent.analytics) out.gtag = ['event', event.name, { ...ctx.common, ...own }];
  if (ctx.pixel && event.meta && ctx.consent.marketing) out.fbq = ['trackCustom', event.name, own];
  return out;
}
