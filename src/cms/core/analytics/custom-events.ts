/**
 * Custom events (REQ-5 §4): defined in the admin, fired by the public runtime,
 * exported into the GTM container.
 *
 * Plain data and pure functions, like the catalogue: the admin table, the
 * runtime and the export all read this file.
 *
 * Triggers, each with standardised parameters (always the same names):
 *   click     an element with `data-track="…"`, or a CSS `#id` / `.class`
 *             → element_id, element_text, link_url
 *   download  a link to a file with one of the listed extensions
 *             → file_name, file_extension, link_url
 *   video     a click on a `[video]` block
 *             → video_title, video_url, video_provider
 *   view      a page (exact path, or `prefix/*`) or a section (`section_id`) shown
 *             → page_path, section_id
 *   form      a form accepted by the server, by its `form_id`
 *             → form_id, form_name
 */
import { z } from 'zod';

import { EVENT_CATALOG } from './catalog';

export const CUSTOM_EVENTS_KEY = 'analytics.customEvents';
export const MAX_CUSTOM_EVENTS = 50;
export const MAX_CUSTOM_PARAMS = 5;

export const TRIGGER_PARAMS = {
  click: ['element_id', 'element_text', 'link_url'],
  download: ['file_name', 'file_extension', 'link_url'],
  video: ['video_title', 'video_url', 'video_provider'],
  view: ['page_path', 'section_id'],
  form: ['form_id', 'form_name'],
} as const;

export type TriggerType = keyof typeof TRIGGER_PARAMS;

/** Names GA4 reserves, or that the catalogue / GA4's own measurement already use. */
const RESERVED_PREFIXES = ['google_', 'ga_', 'firebase_', 'gtm'];
const RESERVED_NAMES = new Set([
  ...EVENT_CATALOG.map((e) => e.ga4),
  'ad_activeview', 'ad_click', 'ad_exposure', 'ad_query', 'ad_reward', 'adunit_exposure', 'app_clear_data',
  'app_exception', 'app_install', 'app_remove', 'app_store_refund', 'app_update', 'app_upgrade', 'click',
  'dynamic_link_app_open', 'dynamic_link_app_update', 'dynamic_link_first_open', 'error', 'first_open',
  'first_visit', 'in_app_purchase', 'notification_dismiss', 'notification_foreground', 'notification_open',
  'notification_receive', 'os_update', 'scroll', 'session_start', 'session_start_with_rollout', 'user_engagement',
  'video_start', 'video_progress', 'video_complete', 'form_start', 'form_submit',
]);
const STANDARD_PARAMS = new Set<string>([
  'page_location', 'page_title', 'page_type', 'language', 'event_id',
  ...Object.values(TRIGGER_PARAMS).flat(),
]);

const SNAKE = /^[a-z][a-z0-9_]*$/;
/** A `data-track` value, `#id` or `.class` — nothing a CSS combinator could turn into something else. */
const SELECTOR = /^(?:[#.]?[A-Za-z][\w-]{0,63})$/;
const PATH = /^\/[^\s?#]{0,190}$/;

const eventName = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(SNAKE, 'must be snake_case: lowercase letters, digits and _')
  .refine((n) => !RESERVED_PREFIXES.some((p) => n.startsWith(p)), { message: 'starts with a prefix GA4 reserves' })
  .refine((n) => !RESERVED_NAMES.has(n), { message: 'is already used by GA4 or by the event list' });

const paramSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(SNAKE, 'must be snake_case')
      .refine((k) => !STANDARD_PARAMS.has(k), { message: 'is a standard parameter already sent with the event' }),
    value: z.string().trim().min(1).max(100),
  })
  .strict();

const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: z.string().trim().regex(SELECTOR, 'must be a data-track value, a #id or a .class') }).strict(),
  z
    .object({
      type: z.literal('download'),
      extensions: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9]{1,8}$/)).min(1).max(20),
    })
    .strict(),
  z.object({ type: z.literal('video') }).strict(),
  z
    .object({
      type: z.literal('view'),
      path: z.string().trim().regex(PATH, 'must start with /').optional(),
      sectionId: z.string().trim().regex(/^[A-Za-z][\w-]{0,63}$/).optional(),
    })
    .strict()
    .refine((t) => Boolean(t.path) !== Boolean(t.sectionId), { message: 'needs either a path or a section id' }),
  z.object({ type: z.literal('form'), formId: z.string().trim().regex(SNAKE).max(64) }).strict(),
]);

export const customEventSchema = z
  .object({
    name: eventName,
    trigger: triggerSchema,
    params: z
      .array(paramSchema)
      .max(MAX_CUSTOM_PARAMS)
      .refine((ps) => new Set(ps.map((p) => p.key)).size === ps.length, { message: 'has the same parameter twice' }),
    ga4: z.boolean(),
    meta: z.boolean(),
  })
  .strict();

export const customEventsSchema = z
  .array(customEventSchema)
  .max(MAX_CUSTOM_EVENTS)
  .refine((list) => new Set(list.map((e) => e.name)).size === list.length, { message: 'has two events with the same name' });

export type CustomEvent = z.infer<typeof customEventSchema>;
export type CustomTrigger = CustomEvent['trigger'];

export function readCustomEvents(raw: unknown): CustomEvent[] {
  const parsed = customEventsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export interface CustomHit {
  event: CustomEvent;
  params: Record<string, string>;
}

interface ClickElement {
  getAttribute(name: string): string | null;
  id: string;
  classList: { contains(token: string): boolean };
  textContent: string | null;
}

function selectorMatches(selector: string, el: ClickElement): boolean {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  return el.getAttribute('data-track') === selector;
}

/** Click triggers matched by `el` (the element itself; the runtime walks its ancestors). */
export function matchCustomClick(events: readonly CustomEvent[], el: ClickElement): CustomHit[] {
  return events.flatMap((event) => {
    if (event.trigger.type !== 'click' || !selectorMatches(event.trigger.selector, el)) return [];
    return [
      {
        event,
        params: {
          element_id: el.getAttribute('data-track') || el.id || '',
          element_text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
          link_url: el.getAttribute('href') ?? '',
        },
      },
    ];
  });
}

export function matchCustomDownload(events: readonly CustomEvent[], href: string): CustomHit[] {
  let path: string;
  try {
    path = new URL(href, 'https://placeholder.invalid').pathname;
  } catch {
    return [];
  }
  const file = decodeURIComponent(path.split('/').pop() ?? '');
  const ext = file.includes('.') ? (file.split('.').pop() ?? '').toLowerCase() : '';
  if (!ext) return [];
  return events.flatMap((event) =>
    event.trigger.type === 'download' && event.trigger.extensions.includes(ext)
      ? [{ event, params: { file_name: file, file_extension: ext, link_url: href } }]
      : [],
  );
}

export function matchCustomVideo(
  events: readonly CustomEvent[],
  video: { title: string; url: string; provider: string },
): CustomHit[] {
  return events.flatMap((event) =>
    event.trigger.type === 'video'
      ? [{ event, params: { video_title: video.title, video_url: video.url, video_provider: video.provider } }]
      : [],
  );
}

/** Page triggers for `pathname` (locale prefix ignored). Section triggers are matched by the runtime as they scroll in. */
export function matchCustomPageView(events: readonly CustomEvent[], pathname: string, locales: readonly string[]): CustomHit[] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) segments.shift();
  const path = `/${segments.join('/')}`;
  return events.flatMap((event) => {
    const t = event.trigger;
    if (t.type !== 'view' || !t.path) return [];
    const hit = t.path.endsWith('/*') ? path.startsWith(t.path.slice(0, -1)) : path === t.path;
    return hit ? [{ event, params: { page_path: path, section_id: '' } }] : [];
  });
}

export function matchCustomSection(events: readonly CustomEvent[], sectionId: string, pathname: string): CustomHit[] {
  return events.flatMap((event) =>
    event.trigger.type === 'view' && event.trigger.sectionId === sectionId
      ? [{ event, params: { page_path: pathname, section_id: sectionId } }]
      : [],
  );
}

export function matchCustomForm(events: readonly CustomEvent[], params: Record<string, unknown>): CustomHit[] {
  const formId = typeof params.form_id === 'string' ? params.form_id : '';
  if (!formId) return [];
  const formName = typeof params.form_name === 'string' ? params.form_name : '';
  return events.flatMap((event) =>
    event.trigger.type === 'form' && event.trigger.formId === formId
      ? [{ event, params: { form_id: formId, form_name: formName } }]
      : [],
  );
}

/** Parameters always worth a GA4 custom dimension, beyond GA4's built-in ones. */
const BASE_DIMENSIONS = ['page_type', 'form_id', 'form_name'];

/**
 * What to declare in GA4 → Admin → Custom definitions for the parameters to be
 * usable as report columns: the base ones, the standard parameters of the
 * triggers in use, and every custom parameter.
 */
export function customParamsToDeclare(events: readonly CustomEvent[]): string[] {
  const out = new Set(BASE_DIMENSIONS);
  for (const event of events) {
    for (const p of TRIGGER_PARAMS[event.trigger.type]) out.add(p);
    for (const p of event.params) out.add(p.key);
  }
  return [...out];
}
