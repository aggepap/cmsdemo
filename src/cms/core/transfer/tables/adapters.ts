import 'server-only';

import { and, eq } from 'drizzle-orm';

import { getDb, schema } from '../../../db';
import { checkShippingMethod } from '../../../modules/commerce/shipping-methods';
import { getShippingConfig } from '../../../modules/commerce/shipping';
import {
  createCategory,
  createService,
  revalidateCookies,
  updateCategory,
  updateService,
} from '../../cookies/service';
import { invalidInput } from '../../errors';
import { checkPendingRedirect, checkRedirect, metaBody } from '../../routes/seo';
import { snippetInputSchema } from '../../scripts/schema';
import { createSnippet, revalidateScripts, updateSnippet } from '../../scripts/service';
import { createRedirect, updateRedirect, upsertMeta } from '../../seo/service';
import { revalidateMeta, revalidateRedirects } from '../../seo/resolve';
import { nextFreeName, nextFreeSlug } from '../conflicts';
import type { TableFamily } from '../groups';
import { PEOPLE_ADAPTERS } from './people-adapters';
import { depsOf, iso, type ExportOptions, type TableAdapter, type TableRow } from './shared';
import {
  planChildren,
  rewriteRedirect,
  rewriteReviewPhotos,
  rewriteSeoMeta,
  tableKey,
  type CookieRecord,
  type RedirectRecord,
  type ReviewLocationRecord,
  type ScriptRecord,
  type SeoMetaRecord,
  type ZoneRecord,
} from './rules';

export type {
  TableAdapter,
  TableDepTarget,
  TableRow,
  TableWriteCtx,
  TableWriteResult,
} from './shared';

// ── Scripts ─────────────────────────────────────────────────────────────────

const scripts: TableAdapter = {
  family: 'scripts',
  async list() {
    const rows = await getDb().select().from(schema.scriptSnippets);
    return Promise.all(
      rows.map(async (r) => {
        const record: ScriptRecord = {
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          ...(r.kind === 'external' ? { src: r.src } : { code: r.code }),
          consentCategory: r.consentCategory,
          lazy: r.lazy,
          enabled: r.enabled,
          notes: r.notes,
        };
        return {
          key: tableKey.script(r.slug),
          label: r.name,
          meta: r.slug,
          sid: r.id,
          record,
          deps: await depsOf('scripts', record),
        };
      })
    );
  },
  async match(r) {
    const [hit] = await getDb()
      .select({ id: schema.scriptSnippets.id, name: schema.scriptSnippets.name })
      .from(schema.scriptSnippets)
      .where(eq(schema.scriptSnippets.slug, String(r.slug)))
      .limit(1);
    return hit ? { id: hit.id, label: hit.name } : null;
  },
  async write(record, action) {
    const existing = await this.match(record);
    let slug = String(record.slug);
    if (action === 'copy') {
      const taken = await getDb()
        .select({ slug: schema.scriptSnippets.slug })
        .from(schema.scriptSnippets);
      slug = nextFreeSlug(slug, new Set(taken.map((t) => t.slug)), 64);
    }
    // The Scripts screen's own rules: what may run, and from where.
    const parsed = snippetInputSchema.safeParse({ ...record, slug });
    if (!parsed.success) throw invalidInput(parsed.error.flatten());
    if (action === 'overwrite' && existing) {
      await updateSnippet(existing.id, parsed.data);
      return { outcome: 'updated' };
    }
    await createSnippet(parsed.data);
    return action === 'copy'
      ? { outcome: 'copied', message: `Imported as "${slug}".` }
      : { outcome: 'created' };
  },
  revalidate: revalidateScripts,
};

// ── Cookie categories ───────────────────────────────────────────────────────

const cookies: TableAdapter = {
  family: 'cookies',
  async list() {
    const db = getDb();
    const cats = await db.select().from(schema.cookieCategories);
    const services = await db.select().from(schema.cookieServices);
    return cats.map((c) => {
      const record: CookieRecord = {
        key: c.key,
        name: c.name,
        description: c.description ?? null,
        required: c.required,
        sortOrder: c.sortOrder,
        services: services
          .filter((s) => s.categoryId === c.id)
          .map((s) => ({
            name: s.name,
            provider: s.provider,
            purpose: s.purpose ?? null,
            enabled: s.enabled,
          })),
      };
      const label = c.name.en ?? c.name.el ?? Object.values(c.name)[0] ?? c.key;
      return { key: tableKey.cookie(c.key), label, meta: c.key, sid: c.id, record, deps: [] };
    });
  },
  async match(r) {
    const [hit] = await getDb()
      .select({ id: schema.cookieCategories.id, key: schema.cookieCategories.key })
      .from(schema.cookieCategories)
      .where(eq(schema.cookieCategories.key, String(r.key)))
      .limit(1);
    return hit ? { id: hit.id, label: hit.key } : null;
  },
  async write(raw, action) {
    const record = raw as CookieRecord;
    const existing = await this.match(record);
    const fields = {
      key: record.key,
      name: record.name,
      description: record.description,
      required: record.required,
      sortOrder: record.sortOrder,
    };
    let id: number;
    if (action === 'overwrite' && existing) {
      id = existing.id;
      await updateCategory(id, fields);
    } else {
      id = await createCategory(fields);
    }
    const current = await getDb()
      .select({ id: schema.cookieServices.id, name: schema.cookieServices.name })
      .from(schema.cookieServices)
      .where(eq(schema.cookieServices.categoryId, id));
    const plan = planChildren(current, record.services);
    for (const { id: sid, row } of plan.update) await updateService(sid, row);
    for (const row of plan.insert) await createService({ ...row, categoryId: id });
    return { outcome: action === 'overwrite' && existing ? 'updated' : 'created' };
  },
  revalidate: revalidateCookies,
};

// ── Shipping zones ──────────────────────────────────────────────────────────

const shipping: TableAdapter = {
  family: 'shipping',
  async list() {
    const db = getDb();
    const zones = await db.select().from(schema.shippingZones);
    const methods = await db.select().from(schema.shippingMethods);
    return zones.map((z) => {
      const record: ZoneRecord = {
        name: z.name,
        countries: z.countries,
        sort: z.sort,
        methods: methods
          .filter((m) => m.zoneId === z.id)
          .map((m) => ({
            name: m.name,
            courier: m.courier,
            kind: m.kind,
            cost: m.cost,
            freeThreshold: m.freeThreshold,
            etaMinDays: m.etaMinDays,
            etaMaxDays: m.etaMaxDays,
            codAllowed: m.codAllowed,
            pickupLocationId: m.pickupLocationId,
            active: m.active,
            sort: m.sort,
          })),
      };
      return {
        key: tableKey.zone(z.name),
        label: z.name,
        meta: z.countries.join(', '),
        sid: z.id,
        record,
        deps: [],
      };
    });
  },
  async match(r) {
    const [hit] = await getDb()
      .select({ id: schema.shippingZones.id, name: schema.shippingZones.name })
      .from(schema.shippingZones)
      .where(eq(schema.shippingZones.name, String(r.name)))
      .limit(1);
    return hit ? { id: hit.id, label: hit.name } : null;
  },
  async write(raw, action) {
    const record = raw as ZoneRecord;
    const db = getDb();
    const existing = await this.match(record);
    const countries = record.countries.map((c) => c.toUpperCase());
    let id: number;
    let name = record.name;
    if (action === 'overwrite' && existing) {
      id = existing.id;
      await db
        .update(schema.shippingZones)
        .set({ countries, sort: record.sort })
        .where(eq(schema.shippingZones.id, id));
    } else {
      if (action === 'copy') {
        const taken = await db
          .select({ name: schema.shippingZones.name })
          .from(schema.shippingZones);
        name = nextFreeName(name, new Set(taken.map((t) => t.name)), 120);
      }
      const [res] = await db
        .insert(schema.shippingZones)
        .values({ name, countries, sort: record.sort })
        .$returningId();
      id = res.id;
    }
    // Checkout's own rule: a method it could never honour (a pickup point this
    // site does not have) is left out, and said so.
    const pickupIds = (await getShippingConfig()).pickup.locations.map((l) => l.id);
    const skipped: string[] = [];
    const usable = record.methods.filter((m) => {
      const problem = checkShippingMethod(m, pickupIds);
      if (problem) skipped.push(`${m.name}: ${problem}`);
      return !problem;
    });
    const current = await db
      .select({ id: schema.shippingMethods.id, name: schema.shippingMethods.name })
      .from(schema.shippingMethods)
      .where(eq(schema.shippingMethods.zoneId, id));
    const plan = planChildren(current, usable);
    for (const { id: mid, row } of plan.update) {
      await db.update(schema.shippingMethods).set(row).where(eq(schema.shippingMethods.id, mid));
    }
    for (const row of plan.insert)
      await db.insert(schema.shippingMethods).values({ ...row, zoneId: id });
    const message = [
      action === 'copy' ? `Imported as "${name}".` : '',
      skipped.length ? `Left out: ${skipped.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      outcome:
        action === 'overwrite' && existing ? 'updated' : action === 'copy' ? 'copied' : 'created',
      ...(message ? { message } : {}),
    };
  },
  revalidate: () => undefined,
};

// ── Google review locations ─────────────────────────────────────────────────

const reviewLocations: TableAdapter = {
  family: 'reviewLocations',
  async list() {
    const db = getDb();
    const locs = await db.select().from(schema.reviewLocations);
    const reviews = locs.length ? await db.select().from(schema.reviewsExternal) : [];
    return Promise.all(
      locs.map(async (l) => {
        const record: ReviewLocationRecord = {
          slug: l.slug,
          label: l.label,
          source: l.source,
          placeId: l.placeId,
          resourceName: l.resourceName,
          enabled: l.enabled,
          reviews: reviews
            .filter((r) => r.locationId === l.id)
            .map((r) => ({
              externalId: r.externalId,
              source: r.source,
              authorName: r.authorName,
              photoMediaId: r.photoMediaId,
              rating: r.rating,
              text: r.text,
              publishedAt: r.publishedAt.toISOString(),
              ownerReply: r.ownerReply,
              ownerReplyAt: iso(r.ownerReplyAt),
              hidden: r.hidden,
            })),
        };
        return {
          key: tableKey.reviewLocation(l.slug),
          label: l.label,
          meta: `${record.reviews.length} review(s)`,
          sid: l.id,
          record,
          deps: await depsOf('reviewLocations', record),
        };
      })
    );
  },
  async match(r) {
    const [hit] = await getDb()
      .select({ id: schema.reviewLocations.id, label: schema.reviewLocations.label })
      .from(schema.reviewLocations)
      .where(eq(schema.reviewLocations.slug, String(r.slug)))
      .limit(1);
    return hit ? { id: hit.id, label: hit.label } : null;
  },
  async write(raw, action, { resolver }) {
    const record = raw as ReviewLocationRecord;
    const db = getDb();
    const existing = await this.match(record);
    const fields = {
      label: record.label,
      source: record.source,
      placeId: record.placeId,
      resourceName: record.resourceName,
      enabled: record.enabled,
    };
    let id: number;
    let slug = record.slug;
    if (action === 'overwrite' && existing) {
      id = existing.id;
      await db.update(schema.reviewLocations).set(fields).where(eq(schema.reviewLocations.id, id));
    } else {
      if (action === 'copy') {
        const taken = await db
          .select({ slug: schema.reviewLocations.slug })
          .from(schema.reviewLocations);
        slug = nextFreeSlug(slug, new Set(taken.map((t) => t.slug)), 64);
      }
      const [res] = await db
        .insert(schema.reviewLocations)
        .values({ slug, ...fields })
        .$returningId();
      id = res.id;
    }
    const { reviews, dropped } = rewriteReviewPhotos(record.reviews, resolver);
    for (const r of reviews) {
      const values = {
        locationId: id,
        externalId: r.externalId,
        source: r.source ?? record.source,
        authorName: r.authorName,
        photoMediaId: r.photoMediaId,
        rating: r.rating,
        text: r.text,
        publishedAt: new Date(r.publishedAt),
        ownerReply: r.ownerReply,
        ownerReplyAt: r.ownerReplyAt ? new Date(r.ownerReplyAt) : null,
        hidden: r.hidden,
      };
      // (location, externalId) is unique: a review already here is refreshed, not duplicated.
      const update: Partial<typeof values> = { ...values };
      delete update.locationId;
      delete update.externalId;
      await db.insert(schema.reviewsExternal).values(values).onDuplicateKeyUpdate({ set: update });
    }
    return {
      outcome:
        action === 'overwrite' && existing ? 'updated' : action === 'copy' ? 'copied' : 'created',
      ...(action === 'copy' ? { message: `Imported as "${slug}".` } : {}),
      ...(dropped ? { dropped } : {}),
    };
  },
  revalidate: () => undefined,
};

// ── Redirects ───────────────────────────────────────────────────────────────

const redirects: TableAdapter = {
  family: 'redirects',
  async list() {
    const rows = await getDb().select().from(schema.seoRedirects);
    return Promise.all(
      rows.map(async (r) => {
        const record: RedirectRecord = {
          source: r.source,
          target: r.target,
          statusCode: r.statusCode,
          kind: r.kind,
          active: r.active,
          notes: r.notes,
          reason: r.reason,
          documentSid: r.documentId,
        };
        return {
          key: tableKey.redirect(r.source, r.kind),
          label: `${r.source} → ${r.target}`,
          meta: `${r.statusCode} ${r.kind}`,
          sid: r.id,
          record,
          deps: await depsOf('redirects', record),
        };
      })
    );
  },
  async match(r) {
    const [hit] = await getDb()
      .select({ id: schema.seoRedirects.id, target: schema.seoRedirects.target })
      .from(schema.seoRedirects)
      .where(
        and(
          eq(schema.seoRedirects.source, String(r.source)),
          eq(schema.seoRedirects.kind, r.kind as RedirectRecord['kind'])
        )
      )
      .limit(1);
    return hit ? { id: hit.id, label: `→ ${hit.target}` } : null;
  },
  async write(raw, action, { resolver, userId }) {
    const record = raw as RedirectRecord;
    const existing = await this.match(record);
    // The SEO screen's own checks: shape, a regex safe to run, no loops. A pending
    // mapping (no target yet, never served — `seo/pending.ts`) travels as one.
    const fields = {
      source: record.source,
      statusCode: record.statusCode,
      kind: record.kind,
      notes: record.notes,
    };
    const input =
      record.target === ''
        ? { ...checkPendingRedirect(fields), target: '', active: false }
        : await checkRedirect(
            { ...fields, target: record.target, active: record.active },
            action === 'overwrite' ? existing?.id : undefined
          );
    const { documentId, dropped } = rewriteRedirect(record, resolver);
    let id: number;
    if (action === 'overwrite' && existing) {
      id = existing.id;
      await updateRedirect(id, input);
    } else {
      id = (await createRedirect(input, userId)).id;
    }
    await getDb()
      .update(schema.seoRedirects)
      .set({ documentId, reason: record.reason })
      .where(eq(schema.seoRedirects.id, id));
    return {
      outcome: action === 'overwrite' && existing ? 'updated' : 'created',
      ...(dropped
        ? { dropped, message: 'Its document is not on this site; kept as an ordinary redirect.' }
        : {}),
    };
  },
  revalidate: revalidateRedirects,
};

// ── Per-path SEO meta ───────────────────────────────────────────────────────

const seoMeta: TableAdapter = {
  family: 'seoMeta',
  async list() {
    const rows = await getDb().select().from(schema.seoMeta);
    return Promise.all(
      rows.map(async (r) => {
        const record: SeoMetaRecord = {
          path: r.path,
          locale: r.locale,
          title: r.title,
          description: r.description,
          robots: r.robots,
          canonical: r.canonical,
          ogTitle: r.ogTitle,
          ogDescription: r.ogDescription,
          ogImage: r.ogImage,
        };
        return {
          key: tableKey.seoMeta(r.path, r.locale),
          label: `${r.path} (${r.locale})`,
          meta: r.title,
          sid: r.id,
          record,
          deps: await depsOf('seoMeta', record),
        };
      })
    );
  },
  async match(r) {
    const [hit] = await getDb()
      .select({ id: schema.seoMeta.id, title: schema.seoMeta.title })
      .from(schema.seoMeta)
      .where(
        and(eq(schema.seoMeta.path, String(r.path)), eq(schema.seoMeta.locale, String(r.locale)))
      )
      .limit(1);
    return hit ? { id: hit.id, label: hit.title ?? '(no title)' } : null;
  },
  async write(raw, action, { resolver, userId }) {
    const { record, dropped } = rewriteSeoMeta(raw as SeoMetaRecord, resolver);
    // The SEO screen's own rules (a canonical or social image must be a publishable URL).
    const parsed = metaBody.safeParse(record);
    if (!parsed.success) throw invalidInput(parsed.error.flatten());
    const existing = await this.match(record);
    await upsertMeta(parsed.data, userId);
    return {
      outcome: action === 'overwrite' && existing ? 'updated' : 'created',
      ...(dropped ? { dropped } : {}),
    };
  },
  revalidate: revalidateMeta,
};

export const TABLE_ADAPTERS: Readonly<Record<TableFamily, TableAdapter>> = {
  scripts,
  cookies,
  shipping,
  reviewLocations,
  redirects,
  seoMeta,
  ...PEOPLE_ADAPTERS,
};

/** The rows of `keys` — the ones that still exist. */
export async function loadTableRows(
  family: TableFamily,
  keys: readonly string[],
  opts: ExportOptions = {}
): Promise<TableRow[]> {
  const wanted = new Set(keys);
  return (await TABLE_ADAPTERS[family].list(opts)).filter((r) => wanted.has(r.key));
}
