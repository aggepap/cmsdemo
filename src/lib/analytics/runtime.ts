/**
 * Sending catalogue events from the browser.
 *
 * `track(id, params)` is THE call for every component — the core's and a
 * site's own. It is safe to call at any time:
 *
 *   - before `AnalyticsLoader` has set things up (a page's effects run before
 *     the loader's, which sits after <main>), the event waits in a short queue
 *     and goes once the loader is ready — or is dropped if the visitor refuses;
 *   - without consent, nothing goes anywhere;
 *   - `once` makes an event happen at most once per browser (a reloaded
 *     thank-you page does not count a purchase twice), and an event that could
 *     not be sent is not marked as sent.
 *
 * Call it where the SERVER has confirmed the action (after the 2xx), never on
 * the button click: a failed submit, a refused captcha or an error must not
 * produce an event.
 */
import type { EventSwitches } from '@/cms/core/analytics/catalog';
import {
  matchCustomForm,
  matchCustomPageView,
  type CustomEvent,
  type CustomHit,
} from '@/cms/core/analytics/custom-events';

import type { MarketingConsent } from './consent';
import { dispatchCustomEvent, dispatchEvent, pageTypeFor, type Dispatch, type EventParams } from './dispatch';
import { scrubUrl } from '@/cms/core/analytics/scrub';

export interface AnalyticsRuntimeConfig {
  switches: EventSwitches;
  /** Settings → Analytics & Marketing → Custom events. */
  customEvents: readonly CustomEvent[];
  gtm: boolean;
  gtag: boolean;
  pixel: boolean;
  consent: MarketingConsent;
  /** The visitor has answered the banner (either way). Until then, events wait. */
  decided: boolean;
  locales: readonly string[];
  /** Admin only: every event is logged to the console. */
  debug: boolean;
}

export interface TrackOptions {
  /** Shared with the server-side send (Meta Conversions API) for dedup. */
  eventId?: string;
  /** At most once per browser under this key. */
  once?: string;
}

interface Pending {
  id: string;
  params: EventParams;
  opts: TrackOptions;
  /** The entry page_view: the tags send their own, so only the dataLayer gets it. */
  entryPageView?: boolean;
  /** A custom event the loader matched (click, download, video, section). */
  custom?: CustomHit;
}

const dataLayerOnly = (d: Dispatch): Dispatch => (d.dataLayer ? { dataLayer: d.dataLayer } : {});

const MAX_PENDING = 50;
const ONCE_PREFIX = 'cms:analytics:once:';

let config: AnalyticsRuntimeConfig | null = null;
let pending: Pending[] = [];
/** When the browser will not store a `once` key, remember it for this page life. */
const onceInMemory = new Set<string>();

interface AnalyticsWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  fbq?: (...args: unknown[]) => void;
  location: { href: string; pathname: string };
  localStorage?: Storage;
}

function win(): AnalyticsWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as AnalyticsWindow);
}

function alreadySent(key: string): boolean {
  if (onceInMemory.has(key)) return true;
  try {
    return win()?.localStorage?.getItem(ONCE_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function markSent(key: string): void {
  onceInMemory.add(key);
  try {
    win()?.localStorage?.setItem(ONCE_PREFIX + key, '1');
  } catch {
    /* blocked storage: remembered for this page life only */
  }
}

function commonParams(w: AnalyticsWindow, locales: readonly string[]): EventParams {
  const override = typeof document !== 'undefined' ? document.querySelector('[data-cms-page-type]') : null;
  return {
    page_location: scrubUrl(w.location.href),
    page_title: typeof document !== 'undefined' ? document.title : '',
    page_type: override?.getAttribute('data-cms-page-type') || pageTypeFor(w.location.pathname, locales),
    language: typeof document !== 'undefined' ? document.documentElement.lang : '',
  };
}

function apply(w: AnalyticsWindow, d: Dispatch): boolean {
  let sent = false;
  if (d.dataLayer) {
    (w.dataLayer ??= []).push(d.dataLayer);
    sent = true;
  }
  if (d.gtag && typeof w.gtag === 'function') {
    w.gtag(...d.gtag);
    sent = true;
  }
  if (d.fbq && typeof w.fbq === 'function') {
    w.fbq(...d.fbq);
    sent = true;
  }
  return sent;
}

function sendCustom(hit: CustomHit, current: AnalyticsRuntimeConfig, w: AnalyticsWindow): void {
  const d = dispatchCustomEvent(hit.event, hit.params, { ...current, common: commonParams(w, current.locales) });
  apply(w, d);
  if (current.debug) console.info('[cms analytics] custom', hit.event.name, { params: hit.params, sent: d });
}

function send(item: Pending, current: AnalyticsRuntimeConfig, w: AnalyticsWindow): void {
  if (item.custom) {
    sendCustom(item.custom, current, w);
    return;
  }
  if (item.opts.once && alreadySent(item.opts.once)) return;
  const ctx = { ...current, common: commonParams(w, current.locales) };
  let d = dispatchEvent(item.id, item.params, ctx, item.opts.eventId);
  if (item.entryPageView) d = dataLayerOnly(d);
  const sent = apply(w, d);
  if (sent && item.opts.once) markSent(item.opts.once);
  // The custom events this one triggers: a form's own event, a page's own event.
  const follow =
    item.id === 'page_view'
      ? matchCustomPageView(current.customEvents, w.location.pathname, current.locales)
      : matchCustomForm(current.customEvents, item.params);
  for (const hit of follow) sendCustom(hit, current, w);
  if (current.debug) console.info('[cms analytics]', item.id, { params: item.params, sent: d });
}

/** Set (or update, on a consent change) what the runtime may do; flushes the queue once decided. */
export function configureAnalyticsRuntime(next: AnalyticsRuntimeConfig | null): void {
  config = next;
  const w = win();
  if (!next || !next.decided || !w) return;
  const queued = pending;
  pending = [];
  for (const item of queued) send(item, next, w);
}

export function track(id: string, params: EventParams = {}, opts: TrackOptions = {}): void {
  const w = win();
  if (!w) return;
  if (!config || !config.decided) {
    if (pending.length < MAX_PENDING) pending.push({ id, params, opts });
    return;
  }
  send({ id, params, opts }, config, w);
}

/**
 * A page view. The ENTRY one is already sent by the tags themselves (gtag's
 * `config`, the Pixel's init) — only GTM needs it, from the dataLayer. Page
 * changes without a reload go everywhere.
 */
export function trackPageView(entry: boolean): void {
  const w = win();
  if (!w) return;
  const item: Pending = { id: 'page_view', params: {}, opts: {}, entryPageView: entry };
  if (!config || !config.decided) {
    if (pending.length < MAX_PENDING) pending.push(item);
    return;
  }
  send(item, config, w);
}

/** Custom events the loader matched on the page (clicks, downloads, videos, sections). */
export function trackCustomHits(hits: readonly CustomHit[]): void {
  const w = win();
  if (!w) return;
  for (const hit of hits) {
    const item: Pending = { id: hit.event.name, params: hit.params, opts: {}, custom: hit };
    if (!config || !config.decided) {
      if (pending.length < MAX_PENDING) pending.push(item);
    } else {
      send(item, config, w);
    }
  }
}

/** File types a link click counts as a download for. */
export const DOWNLOAD_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'csv', 'txt', 'rtf', 'zip', 'rar', '7z', 'epub', 'dwg',
] as const;

interface ClickTarget {
  getAttribute(name: string): string | null;
}

/**
 * What a click on a link (or a card) counts as, if anything. The address in a
 * `mailto:` is never sent — only its domain.
 */
export function clickEventFor(el: ClickTarget): { id: string; params: EventParams } | null {
  const contentType = el.getAttribute('data-cms-content-type');
  const contentId = el.getAttribute('data-cms-content-id');
  if (contentType && contentId) {
    return { id: 'select_content', params: { content_type: contentType, content_id: contentId } };
  }

  const itemId = el.getAttribute('data-cms-item-id');
  if (itemId) {
    const price = Number(el.getAttribute('data-cms-item-price'));
    return {
      id: 'select_item',
      params: {
        item_list_id: el.getAttribute('data-cms-item-list') ?? '',
        items: [
          {
            item_id: itemId,
            item_name: el.getAttribute('data-cms-item-name') ?? '',
            ...(Number.isFinite(price) ? { price } : {}),
          },
        ],
      },
    };
  }

  const href = el.getAttribute('href');
  if (!href) return null;
  if (/^tel:/i.test(href)) return { id: 'click_to_call', params: { link_url: href } };
  if (/^mailto:/i.test(href)) {
    const domain = href.slice('mailto:'.length).split('?')[0].split('@')[1] ?? '';
    return { id: 'click_to_email', params: { link_url: 'mailto:', link_domain: domain.toLowerCase() } };
  }

  let path: string;
  try {
    path = new URL(href, 'https://placeholder.invalid').pathname;
  } catch {
    return null;
  }
  const file = decodeURIComponent(path.split('/').pop() ?? '');
  const ext = file.includes('.') ? (file.split('.').pop() ?? '').toLowerCase() : '';
  if ((DOWNLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return { id: 'file_download', params: { file_name: file, file_extension: ext, link_url: href } };
  }
  return null;
}

/** Test seam: forget module state, as a page reload would (storage is kept). */
export function resetAnalyticsRuntimeForTests(): void {
  config = null;
  pending = [];
  onceInMemory.clear();
}
