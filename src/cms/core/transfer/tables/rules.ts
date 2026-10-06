/**
 * The site-configuration tables (phase B): what a row looks like in a package,
 * what identifies it on any site, and which references it carries.
 *
 * Each row travels WITH its child rows — a cookie category with its services, a
 * shipping zone with its methods, a review location with its synced reviews —
 * because a child means nothing without its parent and its parent's id is
 * different on every site. Children are matched on the target by name.
 *
 * Pure: the database side is in the adapters next to this file.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { courierValues, methodKindValues } from '../../../db/adapters/mysql/schema/shipping';
import { reviewSourceValues } from '../../../db/adapters/mysql/schema/reviews-external';
import { SNIPPET_SLUG } from '../../scripts/schema';
import { MEDIA_URL, isUuid, mapMediaUrls, type RefResolver } from '../refs';
import type { TableFamily } from '../groups';
import { isPeopleFamily, peopleDeps, peopleLabel, peopleRecordKey } from './people';

export const REDIRECT_KINDS = ['literal', 'wildcard', 'regex'] as const;

export const tableKey = {
  script: (slug: string) => `script:${slug}`,
  cookie: (key: string) => `cookie:${key}`,
  zone: (name: string) => `shipzone:${name}`,
  reviewLocation: (slug: string) => `reviewloc:${slug}`,
  seoMeta: (path: string, locale: string) => `seometa:${locale}:${path}`,
  /** A digest: a source can be 512 characters of regex, far past a key's length. */
  redirect: (source: string, kind: string) =>
    `redirect:${createHash('sha1').update(`${kind}\u0000${source}`).digest('hex').slice(0, 24)}`,
};

const localeMap = z.record(z.string().max(8), z.string().max(2000));
const isoDate = z.iso.datetime({ offset: true });

export const redirectRecordSchema = z.object({
  source: z.string().trim().min(1).max(512),
  target: z.string().trim().min(1).max(512),
  statusCode: z.number().int(),
  kind: z.enum(REDIRECT_KINDS),
  active: z.boolean(),
  notes: z.string().max(512).nullable(),
  /** Why an automatic redirect exists (`slug-change`, `unpublish`); null for a hand-made one. */
  reason: z.string().max(32).nullable(),
  /** The document an automatic redirect belongs to, by SOURCE row id. */
  documentSid: z.number().int().positive().nullable(),
});

export const seoMetaRecordSchema = z.object({
  path: z.string().trim().min(1).max(255),
  locale: z.string().max(8),
  title: z.string().max(255).nullable(),
  description: z.string().max(320).nullable(),
  robots: z.string().max(64).nullable(),
  canonical: z.string().max(512).nullable(),
  ogTitle: z.string().max(255).nullable(),
  ogDescription: z.string().max(320).nullable(),
  ogImage: z.string().max(512).nullable(),
});

/**
 * Only the slug is checked here; the whole snippet goes through the Scripts
 * screen's own `snippetInputSchema` when it is written, which is where its
 * code and source rules live.
 */
export const scriptRecordSchema = z
  .object({
    slug: z.string().max(64).regex(SNIPPET_SLUG),
    name: z.string().max(120),
    kind: z.string(),
  })
  .passthrough();

export const cookieRecordSchema = z.object({
  key: z.string().trim().min(1).max(64),
  name: localeMap,
  description: localeMap.nullable(),
  required: z.boolean(),
  sortOrder: z.number().int(),
  services: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(128),
        provider: z.string().max(128).nullable(),
        purpose: localeMap.nullable(),
        enabled: z.boolean(),
      })
    )
    .max(200),
});

export const shippingMethodRecordSchema = z.object({
  name: z.string().trim().min(1).max(120),
  courier: z.enum(courierValues),
  kind: z.enum(methodKindValues),
  cost: z.number().int().min(0),
  freeThreshold: z.number().int().min(0).nullable(),
  etaMinDays: z.number().int().min(0).max(90).nullable(),
  etaMaxDays: z.number().int().min(0).max(90).nullable(),
  codAllowed: z.boolean(),
  pickupLocationId: z.string().trim().max(64).nullable(),
  active: z.boolean(),
  sort: z.number().int().min(0).max(999),
});

export const zoneRecordSchema = z.object({
  name: z.string().trim().min(1).max(120),
  countries: z.array(z.string().trim().length(2)).min(1).max(100),
  sort: z.number().int().min(0).max(999),
  methods: z.array(shippingMethodRecordSchema).max(200),
});

export const reviewRecordSchema = z.object({
  externalId: z.string().min(1).max(191),
  /** Defaults to the location's source. */
  source: z.enum(reviewSourceValues).optional(),
  authorName: z.string().max(191),
  photoMediaId: z.string().max(64).nullable(),
  rating: z.number().int().min(1).max(5),
  text: z.string().max(20_000).nullable(),
  publishedAt: isoDate,
  ownerReply: z.string().max(20_000).nullable(),
  ownerReplyAt: isoDate.nullable(),
  hidden: z.boolean(),
});

export const reviewLocationRecordSchema = z.object({
  slug: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  label: z.string().trim().min(1).max(191),
  source: z.enum(reviewSourceValues),
  placeId: z.string().max(191).nullable(),
  resourceName: z.string().max(191).nullable(),
  enabled: z.boolean(),
  reviews: z.array(reviewRecordSchema).max(5000),
});

export type RedirectRecord = z.infer<typeof redirectRecordSchema>;
export type SeoMetaRecord = z.infer<typeof seoMetaRecordSchema>;
export type ScriptRecord = z.infer<typeof scriptRecordSchema>;
export type CookieRecord = z.infer<typeof cookieRecordSchema>;
export type ZoneRecord = z.infer<typeof zoneRecordSchema>;
export type ShippingMethodRecord = z.infer<typeof shippingMethodRecordSchema>;
export type ReviewLocationRecord = z.infer<typeof reviewLocationRecordSchema>;
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

/**
 * Phase C records are whole rows; the row codec checks them column by column
 * against the schema when they are written (`row-codec.ts`). Here only their shape.
 */
const rowRecord = z.record(z.string(), z.unknown());

export const TABLE_RECORD_SCHEMAS: Readonly<Record<TableFamily, z.ZodType>> = {
  customers: rowRecord,
  subscribers: rowRecord,
  suppressions: rowRecord,
  productReviews: rowRecord,
  orders: rowRecord,
  reservations: rowRecord,
  bookingSlots: rowRecord,
  roles: rowRecord,
  users: rowRecord,
  redirects: redirectRecordSchema,
  seoMeta: seoMetaRecordSchema,
  scripts: scriptRecordSchema,
  cookies: cookieRecordSchema,
  shipping: zoneRecordSchema,
  reviewLocations: reviewLocationRecordSchema,
};

/** The key a record must carry — checked at analysis and again when written. */
export function tableRecordKey(family: TableFamily, r: Record<string, unknown>): string {
  if (isPeopleFamily(family)) return peopleRecordKey(family, r);
  switch (family) {
    case 'redirects':
      return tableKey.redirect(String(r.source), String(r.kind));
    case 'seoMeta':
      return tableKey.seoMeta(String(r.path), String(r.locale));
    case 'scripts':
      return tableKey.script(String(r.slug));
    case 'cookies':
      return tableKey.cookie(String(r.key));
    case 'shipping':
      return tableKey.zone(String(r.name));
    case 'reviewLocations':
      return tableKey.reviewLocation(String(r.slug));
  }
}

/**
 * Child rows matched by name: matches are updated, the rest inserted. Rows only
 * the target has are left alone — an import adds and corrects, it does not
 * delete what someone set up on this site.
 */
export function planChildren<T extends { name: string }>(
  existing: ReadonlyArray<{ id: number; name: string }>,
  incoming: readonly T[]
): { update: Array<{ id: number; row: T }>; insert: T[] } {
  const byName = new Map(existing.map((e) => [e.name, e.id]));
  const update: Array<{ id: number; row: T }> = [];
  const insert: T[] = [];
  for (const row of incoming) {
    const id = byName.get(row.name);
    if (id === undefined) insert.push(row);
    else update.push({ id, row });
  }
  return { update, insert };
}

export function rewriteRedirect(
  record: RedirectRecord,
  resolver: RefResolver
): { documentId: number | null; dropped: number } {
  if (record.documentSid === null) return { documentId: null, dropped: 0 };
  const to = resolver.doc(record.documentSid);
  return { documentId: to, dropped: to === null ? 1 : 0 };
}

export function rewriteSeoMeta(
  record: SeoMetaRecord,
  resolver: RefResolver
): { record: SeoMetaRecord; dropped: number } {
  let dropped = 0;
  const media = (uuid: string) => {
    const to = resolver.media(uuid);
    if (to === null) dropped++;
    return to;
  };
  const map = (v: string | null) => (v === null ? null : mapMediaUrls(v, '', media));
  return {
    record: { ...record, canonical: map(record.canonical), ogImage: map(record.ogImage) },
    dropped,
  };
}

export function rewriteReviewPhotos(
  reviews: readonly ReviewRecord[],
  resolver: RefResolver
): { reviews: ReviewRecord[]; dropped: number } {
  let dropped = 0;
  const out = reviews.map((r) => {
    if (!isUuid(r.photoMediaId)) return r;
    const to = resolver.media(r.photoMediaId);
    if (to === null) dropped++;
    return { ...r, photoMediaId: to };
  });
  return { reviews: out, dropped };
}

export type TableDep =
  | { kind: 'doc'; value: number }
  | { kind: 'media'; value: string }
  | { kind: 'cookie'; value: string }
  | { kind: 'customer'; value: string }
  | { kind: 'zone'; value: string }
  | { kind: 'role'; value: string };

/** What a row needs to come along with it. */
export function tableDeps(family: TableFamily, r: Record<string, unknown>): TableDep[] {
  if (isPeopleFamily(family)) return peopleDeps(family, r);
  const mediaIn = (v: unknown): TableDep[] =>
    typeof v === 'string'
      ? [...v.matchAll(MEDIA_URL)].map((m) => ({ kind: 'media' as const, value: m[1] }))
      : [];
  switch (family) {
    case 'scripts':
      return typeof r.consentCategory === 'string' && r.consentCategory
        ? [{ kind: 'cookie', value: r.consentCategory }]
        : [];
    case 'redirects':
      return typeof r.documentSid === 'number' ? [{ kind: 'doc', value: r.documentSid }] : [];
    case 'seoMeta':
      return [...mediaIn(r.ogImage), ...mediaIn(r.canonical)];
    case 'reviewLocations':
      return (Array.isArray(r.reviews) ? r.reviews : []).flatMap((rev) =>
        rev && typeof rev === 'object' && isUuid((rev as Record<string, unknown>).photoMediaId)
          ? [{ kind: 'media' as const, value: (rev as { photoMediaId: string }).photoMediaId }]
          : []
      );
    case 'cookies':
    case 'shipping':
      return [];
  }
}

/** A row as its admin screen names it — for the picker, the conflict table and the report. */
export function tableLabel(family: TableFamily, r: Record<string, unknown>): string {
  if (isPeopleFamily(family)) return peopleLabel(family, r);
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (family) {
    case 'redirects':
      return `${s(r.source)} → ${s(r.target)}`;
    case 'seoMeta':
      return `${s(r.path)} (${s(r.locale)})`;
    case 'cookies': {
      const name = r.name && typeof r.name === 'object' ? (r.name as Record<string, string>) : {};
      return name.en || name.el || Object.values(name)[0] || s(r.key);
    }
    case 'reviewLocations':
      return s(r.label) || s(r.slug);
    case 'scripts':
    case 'shipping':
      return s(r.name);
  }
}

/**
 * How a planned action is written, given what the target has now.
 *
 * A create that finds its row already there either lost a race — someone made
 * it after the preview, so it is left alone — or finds what an interrupted
 * earlier attempt of this same item wrote (`resumed`), which it completes. An
 * interrupted copy cannot tell its copy from the original, so it stops and says so.
 */
export function tableWriteMode(
  action: 'create' | 'overwrite' | 'copy' | 'merge' | 'skip',
  state: { exists: boolean; resumed: boolean }
): 'create' | 'overwrite' | 'copy' | 'merge' | 'skip' | 'skip-appeared' | 'skip-interrupted-copy' {
  if (action === 'create' && state.exists) return state.resumed ? 'overwrite' : 'skip-appeared';
  if (action === 'copy' && state.exists && state.resumed) return 'skip-interrupted-copy';
  return action;
}
