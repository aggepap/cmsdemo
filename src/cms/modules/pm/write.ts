import 'server-only';

import { and, eq, ne } from 'drizzle-orm';

import type { CmsConfig, ResolvedCollection } from '../../config';
import { logAudit } from '../../core/audit';
import { resolveCollectionWithCustomFields } from '../../core/fields/resolve';
import {
  documentVersionNumber,
  getDocumentById,
  resolvePath,
  updateDocument,
} from '../../core/documents/service';
import { ApiError } from '../../core/errors';
import { siteOrigin } from '../../core/paths';
import { revalidateDocument } from '../../core/read/revalidate';
import { localeKeyedPath } from '../../core/seo/locale-path';
import { patchMeta } from '../../core/seo/service';
import { revalidateMeta, revalidatePayload } from '../../core/seo/resolve';
import { getDb, schema } from '../../db';
import type { DocumentRow } from '../../db/adapters/mysql/schema/documents';
import type { BridgePrincipal } from '../../core/tokens/guard';
import { pmFieldSupport, resolveTitlePath } from './dto';
import type { PmRef } from './identity';
import { hasPerm } from '../auth/permissions';
import { applyImageAlts, type AltEntry } from './alts';
import {
  getAtPath,
  htmlToPlainText,
  mediaUuidFromUrl,
  parseRobots,
  setAtPath,
  toSameOriginPath,
  unwrapRows,
} from './mapping';

/**
 * Applying Product Manager's pushes.
 *
 * ## Why the result is per-field rather than an HTTP status
 *
 * PM's `interpret()` reads `errors` and surfaces it to the user field by field;
 * a non-2xx aborts the whole batch. So a single unwritable field must never cost
 * the other seven — the response is HTTP 200 with `{written, errors, skipped}`
 * whenever the target was found. `skipped` is praion's addition, and it is what
 * lets PM tell "identical, nothing to do" from "refused".
 *
 * That contract is only honest if the translation loop actually catches per
 * field, which is why every translator throws `FieldError` and the loop
 * continues rather than unwinding.
 */

export interface PmWriteResult {
  written: number;
  errors: Record<string, string>;
  skipped: string[];
}

/** A refusal that belongs to one field and must not fail the batch. */
class FieldError extends Error {
  constructor(readonly key: string, message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

/** Column widths. Values are rejected, never truncated — see the note below. */
const LIMITS = { metaTitle: 255, metaDescription: 320, slug: 191, canonicalPath: 512 } as const;

/*
 * Ceilings for the free-text fields, which had none.
 *
 * `capped()` was applied to exactly the fields backed by a sized column — slug,
 * seo_title, meta_description — and every field that lands in the `data` JSON
 * column was left unbounded. That column has no width to bump against, so a push
 * could store a value of any size, which is then read on every render of the page
 * and kept in the read cache. The route now caps the whole body too
 * (`pushBodyTooLarge`), and that is what bounds the resource cost; these are
 * about each field being a plausible size for what it is, so one enormous
 * description cannot consume the entire budget.
 *
 * Numbers chosen from what the field means, not from a column: `og_*` mirror
 * their meta equivalents because they are the same kind of string, and
 * `description` is generous because it holds a page body.
 */
const TEXT_LIMITS = {
  description: 100_000,
  short_description: 1_000,
  og_title: LIMITS.metaTitle,
  og_description: LIMITS.metaDescription,
  answer_summary: 2_000,
  schema_raw_override: 20_000,
  faq_question: 500,
  faq_answer: 5_000,
  key_fact: 500,
  focus_keyword: 100,
  pro_con: 500,
} as const;

interface Translation {
  /** Columns and `data` for the single `updateDocument` call. */
  docPatch: Record<string, unknown>;
  /** Partial write to the per-path SEO override layer (archives only). */
  metaPatch: Record<string, unknown>;
  /** A slug change, applied after the batch is read so its new path is computed once. */
  slugChange?: { from: string; to: string };
}

const asString = (key: string, value: unknown): string => {
  if (typeof value !== 'string') throw new FieldError(key, 'Expected a string.');
  return value;
};

/**
 * Reject rather than truncate.
 *
 * A quietly-shortened meta description is exactly the kind of damage nobody
 * notices: it looks like a successful push, the page still renders, and the
 * sentence simply stops mid-word in search results.
 */
function capped(key: string, value: string, max: number): string {
  if (value.length > max) {
    throw new FieldError(key, `Too long: ${value.length} characters, the limit is ${max}.`);
  }
  return value;
}

/**
 * Translate one PM key into a bucket, or refuse it with a reason.
 *
 * Every refusal here is deliberate and is documented in
 * `docs/PM_CONTENT_TYPES.md` §7 as contract rather than as a bug, so PM's users
 * see the same explanation praion gives.
 */
function translate(
  key: string,
  value: unknown,
  ctx: {
    collection: ResolvedCollection;
    row: DocumentRow;
    data: Record<string, unknown>;
    editable: string[];
    refused: Record<string, string>;
    out: Translation;
    seoData: Record<string, unknown>;
  },
): 'written' | 'skipped' {
  const { collection, row, out } = ctx;
  const map = collection.pmFieldMap ?? {};

  switch (key) {
    // Publishing is `cms.content.publish`, a permission a token deliberately
    // does not hold. Dropped silently rather than as an error: PM sends it on
    // every push and an error every time would be noise, not information.
    case 'status':
    // A WooCommerce helper — praion computes the old path itself.
    case 'old_slug':
      return 'skipped';

    case 'name': {
      if (!ctx.editable.includes('name')) {
        // The same sentence the manifest already showed in PM's UI, so the
        // refusal a user reads before pushing matches the one they get after.
        throw new FieldError('name', ctx.refused.name ?? 'This collection does not expose its title for writing.');
      }
      const path = map.name ?? resolveTitlePath(collection)!;
      const next = asString('name', value).trim();
      if (next === '') throw new FieldError('name', 'A title cannot be empty.');
      if (getAtPath(ctx.data, path) === next) return 'skipped';
      out.docPatch.data = setAtPath(
        (out.docPatch.data as Record<string, unknown>) ?? ctx.data,
        path,
        next,
      );
      return 'written';
    }

    case 'slug': {
      const next = capped('slug', asString('slug', value).trim(), LIMITS.slug);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(next)) {
        throw new FieldError('slug', 'A slug may contain only lowercase letters, numbers and dashes.');
      }
      if (next === row.slug) return 'skipped';
      out.docPatch.slug = next;
      out.slugChange = { from: row.slug, to: next };
      return 'written';
    }

    case 'description':
    case 'short_description': {
      if (!ctx.editable.includes(key)) {
        throw new FieldError(key, ctx.refused[key] ?? 'This site has no field for that.');
      }
      const path = key === 'description' ? (map.description ?? 'description') : map.short_description!;
      const next = capped(key, asString(key, value), TEXT_LIMITS[key]);
      if (getAtPath(ctx.data, path) === next) return 'skipped';
      out.docPatch.data = setAtPath(
        (out.docPatch.data as Record<string, unknown>) ?? ctx.data,
        path,
        next,
      );
      return 'written';
    }

    case 'seo_title': {
      const next = capped('seo_title', asString('seo_title', value), LIMITS.metaTitle);
      if ((row.metaTitle ?? '') === next) return 'skipped';
      out.docPatch.metaTitle = next;
      return 'written';
    }

    case 'meta_description': {
      const next = capped(
        'meta_description',
        asString('meta_description', value),
        LIMITS.metaDescription,
      );
      if ((row.metaDescription ?? '') === next) return 'skipped';
      out.docPatch.metaDescription = next;
      return 'written';
    }

    case 'robots': {
      const flags = parseRobots(value);
      if (!flags) {
        throw new FieldError(
          'robots',
          'Only "index/noindex" combined with "follow/nofollow" can be stored. Directives ' +
            'this site cannot honour are refused rather than silently dropped.',
        );
      }
      if (flags.noindex === row.noindex && flags.nofollow === row.nofollow) return 'skipped';
      out.docPatch.noindex = flags.noindex;
      out.docPatch.nofollow = flags.nofollow;
      return 'written';
    }

    case 'canonical_url': {
      const raw = asString('canonical_url', value).trim();
      if (raw === '') return 'skipped';
      const path = toSameOriginPath(raw);
      if (!path) {
        // The SEO-hijack class. A canonical pointing off-origin hands the site's
        // search authority to another domain, and nothing on the rendered page
        // looks wrong — so this is a refusal, not a best-effort write.
        throw new FieldError(
          'canonical_url',
          'A canonical URL must point at this site. An external address would transfer this ' +
            'page’s search ranking to another domain.',
        );
      }
      // PM seeds this from the permalink and never AI-authors it, so receiving
      // our own value back is the normal case, not a change.
      const current = row.canonicalPath ?? null;
      const seoCanonical = ctx.seoData.canonicalUrl;
      if (path === current || raw === seoCanonical) return 'skipped';
      out.docPatch.data = setAtPath(
        (out.docPatch.data as Record<string, unknown>) ?? ctx.data,
        'seo.canonicalUrl',
        raw,
      );
      return 'written';
    }

    case 'og_title':
    case 'og_description':
    case 'twitter_card':
    case 'focus_keywords':
    case 'faqs':
    case 'key_facts':
    case 'answer_summary':
    case 'pros_cons':
    case 'schema_raw_override': {
      const path = SEO_DATA_PATHS[key];
      const next = coerceSeoValue(key, value);
      if (JSON.stringify(getAtPath(ctx.data, path)) === JSON.stringify(next)) return 'skipped';
      out.docPatch.data = setAtPath(
        (out.docPatch.data as Record<string, unknown>) ?? ctx.data,
        path,
        next,
      );
      return 'written';
    }

    case 'og_image': {
      const raw = asString('og_image', value).trim();
      if (raw === '') return 'skipped';
      const uuid = mediaUuidFromUrl(raw);
      if (!uuid) {
        throw new FieldError(
          'og_image',
          'A social image must be a file from this site’s media library.',
        );
      }
      if (row.ogImageUuid === uuid) return 'skipped';
      out.docPatch.ogImageUuid = uuid;
      return 'written';
    }

    default:
      throw new FieldError(key, 'This site does not have a field for that.');
  }
}

/** Where each AEO key lives inside `data.seo`. */
const SEO_DATA_PATHS: Record<string, string> = {
  og_title: 'seo.ogTitle',
  og_description: 'seo.ogDescription',
  twitter_card: 'seo.twitterCard',
  focus_keywords: 'seo.focusKeywords',
  faqs: 'seo.faqs',
  key_facts: 'seo.keyFacts',
  answer_summary: 'seo.answerSummary',
  pros_cons: 'seo.prosCons',
  schema_raw_override: 'seo.schemaOverride',
};

/**
 * PM's repeater value as a list of rows.
 *
 * PM sends a repeater bare or wrapped in `{rows}`; `null` is its "clear this".
 * Anything else is refused rather than read as an empty list — an empty list
 * is an instruction to delete every row.
 */
function rowsOf(key: string, value: unknown): unknown[] {
  if (value === null) return [];
  const rows = unwrapRows(value);
  if (!Array.isArray(rows)) throw new FieldError(key, 'Expected a list.');
  return rows;
}

/**
 * Refuse a non-empty push of which no row was usable.
 *
 * The coercion used to keep only the rows it recognised, so a list in a shape
 * it did not know — `[{keyword}]` when it expected strings — became `[]` and
 * wiped every stored row while reporting success.
 */
function keptRows<T>(key: string, rows: unknown[], kept: T[]): T[] {
  if (rows.length > 0 && kept.length === 0) {
    throw new FieldError(key, 'None of the rows had a shape this site understands, so nothing was written.');
  }
  return kept;
}

/** A row's text, whether PM sent the bare string or a `{[prop]: string}` row. */
function rowText(row: unknown, prop: string): string | null {
  if (typeof row === 'string') return row;
  if (row && typeof row === 'object') {
    const value = (row as Record<string, unknown>)[prop];
    if (typeof value === 'string') return value;
  }
  return null;
}

/** PM's flat shapes → the repeater rows praion's SEO panel edits. */
function coerceSeoValue(key: string, value: unknown): unknown {
  /*
   * The row limits below bound how MANY entries land; these bound how big each
   * one is. Twenty FAQs is a sane list whether each answer is a paragraph or a
   * megabyte, and only one of those should reach the `data` column.
   */
  switch (key) {
    case 'focus_keywords': {
      const rows = rowsOf(key, value);
      const texts = rows.map((r) => rowText(r, 'keyword')).filter((t): t is string => t !== null);
      return keptRows(key, rows, texts)
        .slice(0, 10)
        .map((keyword) => ({ keyword: capped(key, keyword, TEXT_LIMITS.focus_keyword) }));
    }
    case 'key_facts': {
      const rows = rowsOf(key, value);
      const texts = rows.map((r) => rowText(r, 'fact')).filter((t): t is string => t !== null);
      return keptRows(key, rows, texts)
        .slice(0, 12)
        .map((fact) => ({ fact: capped(key, fact, TEXT_LIMITS.key_fact) }));
    }
    case 'faqs': {
      const rows = rowsOf(key, value);
      const faqs = rows.filter((row): row is { question: string; answer: string } =>
        Boolean(row) &&
        typeof row === 'object' &&
        typeof (row as Record<string, unknown>).question === 'string' &&
        typeof (row as Record<string, unknown>).answer === 'string',
      );
      // PM's answer is an HTML field; the site renders it as text.
      return keptRows(key, rows, faqs)
        .slice(0, 20)
        .map((row) => ({
          question: capped(key, htmlToPlainText(row.question), TEXT_LIMITS.faq_question),
          answer: capped(key, htmlToPlainText(row.answer), TEXT_LIMITS.faq_answer),
        }));
    }
    case 'pros_cons': {
      const rows = rowsOf(key, value);
      const objects = rows.filter((row) => Boolean(row) && typeof row === 'object');
      return keptRows(key, rows, objects)
        .slice(0, 10)
        .map((row) => {
          const r = row as Record<string, unknown>;
          return {
            pro: typeof r.pro === 'string' ? capped(key, r.pro, TEXT_LIMITS.pro_con) : '',
            con: typeof r.con === 'string' ? capped(key, r.con, TEXT_LIMITS.pro_con) : '',
          };
        });
    }
    case 'twitter_card':
      if (value !== 'summary' && value !== 'summary_large_image') {
        throw new FieldError('twitter_card', 'Expected "summary" or "summary_large_image".');
      }
      return value;
    case 'schema_raw_override': {
      // Stored as the text the SEO panel's code field holds, so a human can read
      // and edit what PM pushed rather than facing an opaque blob.
      const text = typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value, null, 2);
      return capped(key, text, TEXT_LIMITS.schema_raw_override);
    }
    case 'answer_summary':
      return typeof value === 'string' ? capped(key, htmlToPlainText(value), TEXT_LIMITS.answer_summary) : '';
    case 'og_title':
      return typeof value === 'string' ? capped(key, value, TEXT_LIMITS.og_title) : '';
    case 'og_description':
      return typeof value === 'string' ? capped(key, value, TEXT_LIMITS.og_description) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

/**
 * Would this slug collide?
 *
 * Two unique constraints fire on a slug change and they mean different things,
 * so both are pre-checked with a SELECT. Letting the insert raise `ER_DUP_ENTRY`
 * would surface as a 409 for the *whole request*, discarding every other field
 * in the batch — the opposite of the per-field contract.
 */
async function slugCollision(
  row: DocumentRow,
  nextSlug: string,
  nextPath: string | null,
): Promise<string | null> {
  const db = getDb();

  const [sameSlug] = await db
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.type, row.type),
        eq(schema.documents.slug, nextSlug),
        eq(schema.documents.locale, row.locale),
        ne(schema.documents.id, row.id),
      ),
    )
    .limit(1);
  if (sameSlug) {
    return `Another ${row.type} already uses the slug "${nextSlug}" in this language.`;
  }

  if (nextPath) {
    const [samePath] = await db
      .select({ id: schema.documents.id, type: schema.documents.type })
      .from(schema.documents)
      .where(and(eq(schema.documents.canonicalPath, nextPath), ne(schema.documents.id, row.id)))
      .limit(1);
    if (samePath) {
      return `The URL "${nextPath}" is already used by another page (${samePath.type}).`;
    }
  }
  return null;
}

export interface ApplyOptions {
  expectedVersion?: number;
  /** Internal: set when retrying once after a concurrent save. */
  isRetry?: boolean;
}

/**
 * PM's `image_alts` rows as alt-text entries.
 *
 * The id is whatever the read handed out as `images[].id` — the media uuid.
 * A numeric id is deliberately NOT read as a position: PM's `(int)` cast turns
 * "5c1e…" into 5, and treating that as "the sixth image" would put one image's
 * alt on another. It is passed through as an id, matches nothing, and is
 * reported. Rows without an alt are dropped so a push never blanks one.
 */
function imageAltEntries(value: unknown): AltEntry[] | null {
  const rows = unwrapRows(value);
  if (!Array.isArray(rows)) return null;
  const entries: AltEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = r.image_id ?? r.id;
    const alt = typeof r.alt === 'string' ? r.alt.trim() : '';
    if (alt === '') continue;
    if (typeof id === 'string' && id !== '') entries.push({ media_id: id, alt });
    else if (typeof id === 'number' && Number.isFinite(id)) entries.push({ media_id: String(id), alt });
  }
  return entries;
}

/** `seo_override` is a flag; anything but a boolean is a mistake worth reporting. */
function parseSeoOverride(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new FieldError('seo_override', 'Expected true or false.');
  return value;
}

/**
 * Apply a set of PM values to one document.
 *
 * Two keys are not document fields and take their own path: `image_alts`
 * (spec §6.1, "routed to §8") and `seo_override`, which is a property of the
 * compiled payload row. Everything else goes through one `updateDocument`.
 */
export async function applyPageValues(
  config: CmsConfig,
  target: Extract<PmRef, { kind: 'document' }>,
  values: Record<string, unknown>,
  principal: BridgePrincipal,
  opts: ApplyOptions = {},
): Promise<PmWriteResult> {
  const { image_alts: alts, seo_override: override, ...fields } = values;
  const result = await applyFieldValues(config, target, fields, principal, opts);

  if ('seo_override' in values) {
    try {
      const flag = parseSeoOverride(override);
      if (await setPayloadOverride(target.id, flag)) result.written += 1;
      else result.skipped.push('seo_override');
    } catch (err) {
      if (!(err instanceof FieldError)) throw err;
      result.errors[err.key] = err.message;
    }
  }

  if ('image_alts' in values) {
    const entries = imageAltEntries(alts);
    if (entries === null) {
      result.errors.image_alts = 'Expected a list of {image_id, alt}.';
    } else if (!hasPerm(principal.scopes, 'pm:media')) {
      result.errors.image_alts = 'This credential lacks the pm:media scope, which alt text needs.';
    } else if (entries.length === 0) {
      result.skipped.push('image_alts');
    } else {
      const alt = await applyImageAlts(config, target.id, entries, 'document', principal);
      result.written += alt.written;
      const failures = Object.entries(alt.errors).map(([ref, message]) => `${ref}: ${message}`);
      if (failures.length > 0) result.errors.image_alts = failures.join('; ');
      else if (alt.written === 0) result.skipped.push('image_alts');
    }
  }

  return result;
}

/**
 * Flip `seo_override` on the payload rows a document already has.
 *
 * Returns false when there is no row, or it already holds that value: the flag
 * describes how a compiled payload combines with the page, so with no payload
 * there is nothing to store it on — the next `/payload` push carries it anyway.
 */
async function setPayloadOverride(documentId: number, flag: boolean): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.pmHeadPayloads.id, path: schema.pmHeadPayloads.path, seoOverride: schema.pmHeadPayloads.seoOverride })
    .from(schema.pmHeadPayloads)
    .where(eq(schema.pmHeadPayloads.documentId, documentId));
  const changed = rows.filter((r) => r.seoOverride !== flag);
  if (changed.length === 0) return false;
  await db
    .update(schema.pmHeadPayloads)
    .set({ seoOverride: flag })
    .where(eq(schema.pmHeadPayloads.documentId, documentId));
  for (const row of changed) revalidatePayload(row.path);
  return true;
}

/**
 * Apply the document fields of a push.
 *
 * One `updateDocument` per request, never one per field: each call appends a
 * `document_versions` row holding the entire `data` JSON, so per-field writes
 * would multiply history by eight and the storage with it — and make the version
 * list useless as a rollback path, which is the thing that makes a hostile push
 * recoverable.
 */
async function applyFieldValues(
  config: CmsConfig,
  target: Extract<PmRef, { kind: 'document' }>,
  values: Record<string, unknown>,
  principal: BridgePrincipal,
  opts: ApplyOptions = {},
): Promise<PmWriteResult> {
  const result: PmWriteResult = { written: 0, errors: {}, skipped: [] };

  const row = await getDocumentById(target.id);
  if (!row) throw new ApiError('not_found', 'No such document.');

  const base = config.collectionByKey.get(row.type);
  if (!base?.pmPageType) throw new ApiError('not_found', 'No such document.');

  // `relaxRequired` matters: without it `updateDocument` re-validates the WHOLE
  // stored document, so any published page predating a now-required field would
  // 422 on a meta-title push it never touched.
  const collection = await resolveCollectionWithCustomFields(config, row.type, {
    relaxRequired: true,
    data: (row.data ?? {}) as Record<string, unknown>,
  });

  const data = (row.data ?? {}) as Record<string, unknown>;
  const seoData = (data.seo ?? {}) as Record<string, unknown>;
  const { writable: editable, refused } = pmFieldSupport(collection);

  const out: Translation = { docPatch: {}, metaPatch: {} };

  for (const [key, value] of Object.entries(values)) {
    try {
      const outcome = translate(key, value, { collection, row, data, editable, refused, out, seoData });
      if (outcome === 'written') result.written += 1;
      else result.skipped.push(key);
    } catch (err) {
      if (err instanceof FieldError) {
        result.errors[err.key] = err.message;
        continue;
      }
      throw err;
    }
  }

  // A slug change moves the public path. `updateDocument` would recompute it
  // anyway (`nextCanonicalPath`); it is computed here first because the collision
  // check needs it — a clash is reported as a per-field error rather than letting
  // the whole write fail. Sending it keeps the two in agreement by construction.
  let newPath: string | null = null;
  if (out.slugChange) {
    newPath = resolvePath(collection, out.slugChange.to, row.locale, config.defaultLocale);
    const collision = await slugCollision(row, out.slugChange.to, newPath);
    if (collision) {
      result.errors.slug = collision;
      result.written -= 1;
      delete out.docPatch.slug;
      out.slugChange = undefined;
      newPath = null;
    } else if (newPath) {
      out.docPatch.canonicalPath = newPath;
    }
  }

  if (Object.keys(out.docPatch).length === 0) {
    return result;
  }

  let updated: DocumentRow;
  try {
    updated = await updateDocument(
      config,
      row.id,
      {
        ...out.docPatch,
        expectedVersion: opts.expectedVersion ?? (await documentVersionNumber(row.id)),
      },
      principal.userId,
      { collection },
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'conflict' && !opts.isRetry) {
      // Read-modify-write once more. The bridge read the row microseconds ago,
      // so a mismatch is a genuine concurrent admin save rather than a stale tab.
      return applyFieldValues(config, target, values, principal, { isRetry: true });
    }
    if (err instanceof ApiError && err.code === 'conflict') {
      // A 409 would surface in PM as `failure: "HTTP 409"` and abort the batch.
      // A per-field error lets the rest of the sync land.
      return {
        written: 0,
        errors: { _document: 'changed concurrently in the CMS; not overwritten' },
        skipped: result.skipped,
      };
    }
    if (err instanceof ApiError && err.code === 'invalid_input') {
      return { written: 0, errors: { _document: err.message }, skipped: result.skipped };
    }
    throw err;
  }

  // The slug-change 301 is written by `updateDocument` itself
  // (`applySlugChangeRedirect`), as for every other writer; a second one here
  // ignored its rules (live pages only, an admin's rule for the old URL wins).

  if (Object.keys(out.metaPatch).length > 0) {
    await patchMeta(
      {
        // Keyed like the readers ask (unprefixed + locale), not by the public URL.
        path: localeKeyedPath(updated.canonicalPath ?? '', updated.locale, config.defaultLocale),
        locale: updated.locale,
        ...out.metaPatch,
      },
      principal.userId,
    );
    revalidateMeta();
  }

  revalidateDocument(updated);
  // A slug change must purge the OLD path too, or the previous URL serves stale
  // content for up to the cache lifetime.
  if (row.canonicalPath && row.canonicalPath !== updated.canonicalPath) {
    revalidateDocument(row);
  }

  await logAudit({
    userId: principal.userId,
    actorLabel: principal.actorLabel,
    action: 'pm.page.update',
    subjectType: 'document',
    subjectId: row.id,
    before: {
      slug: row.slug,
      metaTitle: row.metaTitle,
      metaDescription: row.metaDescription,
      noindex: row.noindex,
      nofollow: row.nofollow,
    },
    after: {
      keys: Object.keys(values),
      written: result.written,
      errors: Object.keys(result.errors),
    },
  });

  return result;
}

/**
 * Archives have no document, so they write to the per-path SEO layer instead.
 *
 * This is the one place the bridge writes `seo_meta` for something a human also
 * edits, and it is unavoidable: there is no row to hold the values.
 */
export async function applyArchiveValues(
  config: CmsConfig,
  path: string,
  locale: string,
  values: Record<string, unknown>,
  principal: BridgePrincipal,
): Promise<PmWriteResult> {
  const result: PmWriteResult = { written: 0, errors: {}, skipped: [] };
  const patch: Record<string, unknown> = {};

  const assign = (key: string, column: string, max: number) => {
    try {
      const next = capped(key, asString(key, values[key]), max);
      patch[column] = next;
      result.written += 1;
    } catch (err) {
      if (err instanceof FieldError) result.errors[err.key] = err.message;
      else throw err;
    }
  };

  if (values.seo_title !== undefined) assign('seo_title', 'title', LIMITS.metaTitle);
  if (values.meta_description !== undefined) {
    assign('meta_description', 'description', LIMITS.metaDescription);
  }
  if (values.og_title !== undefined) assign('og_title', 'ogTitle', 255);
  if (values.og_description !== undefined) assign('og_description', 'ogDescription', 320);

  if (values.robots !== undefined) {
    const flags = parseRobots(values.robots);
    if (!flags) {
      result.errors.robots = 'Only "index/noindex" combined with "follow/nofollow" can be stored.';
    } else {
      patch.robots = `${flags.noindex ? 'noindex' : 'index'}, ${flags.nofollow ? 'nofollow' : 'follow'}`;
      result.written += 1;
    }
  }

  for (const key of Object.keys(values)) {
    if (!['seo_title', 'meta_description', 'og_title', 'og_description', 'robots'].includes(key)) {
      result.skipped.push(key);
    }
  }

  if (Object.keys(patch).length > 0) {
    await patchMeta({ path, locale, ...patch }, principal.userId);
    revalidateMeta();
    await logAudit({
      userId: principal.userId,
      actorLabel: principal.actorLabel,
      action: 'pm.archive.update',
      subjectType: 'seo_meta',
      subjectId: path,
      after: { keys: Object.keys(patch) },
    });
  }

  return result;
}

/** Exported for the tests, which is the only reason it is not module-private. */
export const __testables = {
  capped,
  coerceSeoValue,
  imageAltEntries,
  parseSeoOverride,
  parseRobotsForTest: parseRobots,
  siteOriginForTest: siteOrigin,
};
