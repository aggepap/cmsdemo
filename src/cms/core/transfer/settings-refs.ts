/**
 * Settings that point at other entities, and settings that must not travel.
 *
 * Most settings are plain values (a currency, a site name) and move as they
 * are. Two are not: the brand identity names its logos by media uuid, and the
 * custom-field definitions name the categories each field applies to by
 * document id. Those are walked and rewritten like a document's data.
 */
import { ANALYTICS_TRACKING_KEY } from '../analytics/catalog';
import { CUSTOM_EVENTS_KEY } from '../analytics/custom-events';
import { GOOGLE_ADS_KEY } from '../analytics/google-ads';
import { META_CAPI_KEY } from '../analytics/meta-capi-settings';
import { GTM_LAST_EXPORT_KEY } from '../analytics/gtm-export';
import { BRAND_IDENTITY_KEY, BRAND_PALETTE_KEY } from '../brand/policy';
import {
  CUSTOM_FIELDS_KEY,
  ECOMMERCE_COUPONS_KEY,
  ECOMMERCE_GIFTCARDS_KEY,
  ECOMMERCE_SHIPPING_KEY,
  ECOMMERCE_WISHLIST_KEY,
  GOOGLE_REVIEWS_KEY,
  I18N_LOCALES_KEY,
  MODULE_PREFIX,
  SECURITY_REQUIRE_2FA_KEY,
  SEO_FIELDS_KEY,
  ECOMMERCE_PAYMENT_PROVIDER_KEY,
  BOOKING_PAYMENT_PROVIDER_KEY,
} from '../settings/schema';
import { ANNOUNCEMENT_KEY } from '../settings/announcement';
import { MENUS_KEY } from '../settings/menus';
import { SCHEMA_POLICY_KEY } from '../structured-data/policy';
import { isUuid, type Ref, type RefResolver } from './refs';

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

interface SettingRefSpec {
  collect(value: unknown): Ref[];
  rewrite(value: unknown, resolver: RefResolver, dropped: Ref[]): unknown;
}

const BRAND_MEDIA_KEYS = ['logoId', 'logoDarkId', 'faviconId', 'ogImageId'] as const;

/** Each store location names its photo by media uuid, at `locations.<i>.imageId`. */
const brandLocations = (value: Rec): unknown[] =>
  Array.isArray(value.locations) ? value.locations : [];

const brandIdentity: SettingRefSpec = {
  collect(value) {
    if (!isRecord(value)) return [];
    const refs: Ref[] = BRAND_MEDIA_KEYS.filter((k) => isUuid(value[k])).map((k) => ({
      kind: 'media' as const,
      value: value[k] as string,
      path: k,
    }));
    brandLocations(value).forEach((loc, i) => {
      if (isRecord(loc) && isUuid(loc.imageId))
        refs.push({ kind: 'media', value: loc.imageId, path: `locations.${i}.imageId` });
    });
    return refs;
  },
  rewrite(value, resolver, dropped) {
    if (!isRecord(value)) return value;
    const out: Rec = { ...value };
    for (const k of BRAND_MEDIA_KEYS) {
      if (!isUuid(value[k])) continue;
      const to = resolver.media(value[k]);
      if (to === null) dropped.push({ kind: 'media', value: value[k], path: k });
      out[k] = to;
    }
    if (Array.isArray(value.locations)) {
      out.locations = value.locations.map((loc, i) => {
        if (!isRecord(loc) || !isUuid(loc.imageId)) return loc;
        const to = resolver.media(loc.imageId);
        if (to === null)
          dropped.push({ kind: 'media', value: loc.imageId, path: `locations.${i}.imageId` });
        return { ...loc, imageId: to };
      });
    }
    return out;
  },
};

/** `{ [collection]: { groups, fields: [{ categoryIds, subFields }] } }` */
function mapCustomFieldDefs(
  defs: unknown,
  path: string,
  visit: (id: number, path: string) => number | null
): unknown {
  if (!Array.isArray(defs)) return defs;
  const out: unknown[] = [];
  defs.forEach((def, i) => {
    if (!isRecord(def)) return void out.push(def);
    const next: Rec = { ...def };
    const at = `${path}.${i}`;
    if (Array.isArray(def.categoryIds)) {
      const ids = def.categoryIds
        .map((id, j) => (typeof id === 'number' ? visit(id, `${at}.categoryIds.${j}`) : id))
        .filter((id) => id !== null);
      // An empty list means "every document". A field limited to categories
      // none of which exist here is left out rather than widened to all.
      if (def.categoryIds.length > 0 && ids.length === 0) return;
      next.categoryIds = ids;
    }
    if (Array.isArray(def.subFields))
      next.subFields = mapCustomFieldDefs(def.subFields, `${at}.subFields`, visit);
    out.push(next);
  });
  return out;
}

function mapCustomFields(
  value: unknown,
  visit: (id: number, path: string) => number | null
): unknown {
  if (!isRecord(value)) return value;
  const out: Rec = {};
  for (const [collection, cfg] of Object.entries(value)) {
    out[collection] = isRecord(cfg)
      ? { ...cfg, fields: mapCustomFieldDefs(cfg.fields, `${collection}.fields`, visit) }
      : cfg;
  }
  return out;
}

/** Field ids per collection in a custom-fields value. */
export function customFieldIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(value)) return ids;
  for (const cfg of Object.values(value)) {
    if (!isRecord(cfg) || !Array.isArray(cfg.fields)) continue;
    for (const f of cfg.fields) if (isRecord(f) && typeof f.id === 'string') ids.add(f.id);
  }
  return ids;
}

/**
 * "Merge" for custom-field definitions: the union per collection. A field this
 * site had BEFORE the import (`keep`) is left as it is; any other field takes
 * the package's version — including one an earlier pass of this same import
 * wrote, so the second pass can complete what the first could not resolve.
 */
export function mergeCustomFieldConfigs(
  current: unknown,
  incoming: unknown,
  keep: ReadonlySet<string>
): unknown {
  if (!isRecord(current) || !isRecord(incoming)) return incoming;
  const out: Rec = { ...current };
  for (const [collection, cfg] of Object.entries(incoming)) {
    const mine = current[collection];
    if (!isRecord(mine) || !isRecord(cfg)) {
      out[collection] = mine ?? cfg;
      continue;
    }
    const mineFields = Array.isArray(mine.fields) ? mine.fields : [];
    const theirs = Array.isArray(cfg.fields) ? cfg.fields : [];
    const theirById = new Map(theirs.filter(isRecord).map((f) => [String(f.id), f] as const));
    const fields: unknown[] = mineFields.map((f) => {
      if (!isRecord(f) || keep.has(String(f.id))) return f;
      return theirById.get(String(f.id)) ?? f;
    });
    const present = new Set(mineFields.filter(isRecord).map((f) => String(f.id)));
    for (const f of theirs) if (!isRecord(f) || !present.has(String(f.id))) fields.push(f);
    const mineGroups = Array.isArray(mine.groups) ? mine.groups : [];
    const groupKeys = new Set(mineGroups.filter(isRecord).map((g) => String(g.key)));
    const groups = [
      ...mineGroups,
      ...(Array.isArray(cfg.groups) ? cfg.groups : []).filter(
        (g) => !isRecord(g) || !groupKeys.has(String(g.key))
      ),
    ];
    out[collection] = { ...mine, groups, fields };
  }
  return out;
}

const customFields: SettingRefSpec = {
  collect(value) {
    const refs: Ref[] = [];
    mapCustomFields(value, (id, path) => (refs.push({ kind: 'doc', value: id, path }), id));
    return refs;
  },
  rewrite(value, resolver, dropped) {
    return mapCustomFields(value, (id, path) => {
      const to = resolver.doc(id);
      if (to === null) dropped.push({ kind: 'doc', value: id, path });
      return to;
    });
  },
};

/** Settings holding references, by key. */
export const SETTING_REFS: Readonly<Record<string, SettingRefSpec>> = {
  [BRAND_IDENTITY_KEY]: brandIdentity,
  [CUSTOM_FIELDS_KEY]: customFields,
};

/**
 * Structured settings checked to hold no ids — listed so a test fails when a
 * new structured setting appears and nobody has said which kind it is.
 */
export const REF_FREE_STRUCTURED: ReadonlySet<string> = new Set([
  BRAND_PALETTE_KEY,
  SCHEMA_POLICY_KEY,
  GOOGLE_REVIEWS_KEY,
  ECOMMERCE_SHIPPING_KEY,
  ECOMMERCE_COUPONS_KEY,
  ECOMMERCE_WISHLIST_KEY,
  ECOMMERCE_GIFTCARDS_KEY,
  SEO_FIELDS_KEY,
  I18N_LOCALES_KEY,
  // Links are paths and URLs, which mean the same thing on the receiving site.
  ANNOUNCEMENT_KEY,
  MENUS_KEY,
  // Profiles and per-event switches: event names, no documents.
  ANALYTICS_TRACKING_KEY,
  CUSTOM_EVENTS_KEY,
  GOOGLE_ADS_KEY,
  META_CAPI_KEY,
]);

/** Machine state and edit baselines: meaningless, or harmful, on another site. */
const NEVER_EXPORTED = new Set([
  'integrations.googleReviews.oauthState',
  'cms.customFields.baseline',
  'cms.seoFields.baseline',
  // What this site's GTM container last received: another site's is a different container.
  GTM_LAST_EXPORT_KEY,
]);

export function isExportableSetting(key: string): boolean {
  return !NEVER_EXPORTED.has(key);
}

const WARNINGS: Readonly<Record<string, string>> = {
  [I18N_LOCALES_KEY]: 'Changes which languages this site edits and shows to visitors.',
  [SECURITY_REQUIRE_2FA_KEY]: 'Changes whether every admin must use two-factor sign-in.',
  [ECOMMERCE_PAYMENT_PROVIDER_KEY]:
    'Changes which payment methods the shop offers. Payment credentials are never exported, so enter them here before taking orders.',
  [BOOKING_PAYMENT_PROVIDER_KEY]:
    'Changes which payment methods bookings offer. Payment credentials are never exported, so enter them here before taking bookings.',
  [GOOGLE_REVIEWS_KEY]:
    'The Google connection itself is not exported; connect it again on this site.',
};

/** Why importing this setting deserves a second look, or null when it does not. */
export function settingWarning(key: string): string | null {
  if (key.startsWith(MODULE_PREFIX)) return 'Turns a whole module on or off on this site.';
  return WARNINGS[key] ?? null;
}

export function collectSettingRefs(key: string, value: unknown): Ref[] {
  return SETTING_REFS[key]?.collect(value) ?? [];
}

export function rewriteSettingValue(
  key: string,
  value: unknown,
  resolver: RefResolver
): { value: unknown; dropped: Ref[] } {
  const spec = SETTING_REFS[key];
  if (!spec) return { value, dropped: [] };
  const dropped: Ref[] = [];
  return { value: spec.rewrite(structuredClone(value), resolver, dropped), dropped };
}
