import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import type { CmsConfig, ResolvedCollection } from '../../config';
import { logAudit } from '../../core/audit';
import { createDocument, type DocumentWriteInput } from '../../core/documents/service';
import { isDuplicateKeyError } from '../../core/errors';
import { fetchRemoteImage, toWebp } from '../../core/media/image';
import { deleteMedia, mediaUrl, uploadMedia } from '../../core/media/service';
import { slugify } from '../../core/slug';
import type { BridgePrincipal } from '../../core/tokens/guard';
import { adapter, getDb, schema } from '../../db';
import type { DocumentRow } from '../../db/adapters/mysql/schema/documents';
import { galleryPaths, pmFieldSupport, resolveTitlePath } from './dto';
import { encodeRemoteId } from './identity';
import { absoluteUrl, getAtPath, permalinkFor, setAtPath } from './mapping';

/**
 * `POST /products` — Product Manager creating a product it holds and the site
 * does not.
 *
 * ## Always a draft
 *
 * PM may send `status: "publish"`; it is ignored. Publishing is
 * `cms.content.publish`, which a token deliberately does not hold, and a product
 * with no price, stock or shipping set must not go on sale because an AI tool
 * drafted its copy. A person reviews it and publishes it in the admin.
 *
 * ## Idempotent by PM's key
 *
 * PM retries a create whose response it never saw. The key is claimed in
 * `pm_created_documents` before the product is made, so a retry — even a
 * concurrent one — returns the first product instead of making a second.
 *
 * ## Images are fetched, from allowlisted hosts only
 *
 * PM sends the URL of each image on its own server. The site fetches it, which
 * is a server-side request built from someone else's JSON — so only hosts listed
 * in `CMS_PM_IMAGE_HOSTS` are fetched, over HTTPS, with redirects refused
 * (`fetchRemoteImage`). An image that cannot be fetched does not cost the
 * product: it is created anyway and the image is reported.
 */

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_WIDTH = 2560;
const IMAGE_TIMEOUT_MS = 15_000;
const LIMITS = { name: 255, sku: 64, short: 1_000, alt: 500 } as const;
/** Longer than any create can take: five rounds of four images at the fetch timeout, with room. */
const STALE_CLAIM_MS = 10 * 60 * 1000;
/** Images fetched at once: fast enough for twenty, gentle on PM and on memory. */
const IMAGE_CONCURRENCY = 4;

export interface CreateImage {
  localId: string | null;
  src: string;
  alt: string;
}

export interface CreateInput {
  name: string;
  slug: string | null;
  sku: string | null;
  description: string | null;
  shortDescription: string | null;
  images: CreateImage[];
  idempotencyKey: string;
}

export type ParsedCreate = { ok: true; input: CreateInput } | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const optionalText = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

/** Validate PM's create body. `status` and `type` are read by nobody. */
export function parseCreateBody(body: unknown): ParsedCreate {
  if (!isRecord(body)) return { ok: false, message: 'Expected a JSON object.' };

  const name = optionalText(body.name, LIMITS.name);
  if (!name) return { ok: false, message: 'A product needs a name.' };

  const key = body.idempotency_key;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
    return { ok: false, message: 'An idempotency_key of up to 128 letters, digits and _.:- is required.' };
  }

  const images: CreateImage[] = [];
  if (Array.isArray(body.images)) {
    for (const raw of body.images) {
      if (images.length >= MAX_IMAGES) break;
      if (!isRecord(raw) || typeof raw.src !== 'string' || raw.src === '') continue;
      images.push({
        localId: typeof raw.local_id === 'string' ? raw.local_id : null,
        src: raw.src,
        alt: optionalText(raw.alt, LIMITS.alt) ?? '',
      });
    }
  }

  return {
    ok: true,
    input: {
      name,
      slug: typeof body.slug === 'string' && body.slug !== '' ? body.slug : null,
      sku: optionalText(body.sku, LIMITS.sku),
      description: typeof body.description === 'string' && body.description !== '' ? body.description : null,
      shortDescription: optionalText(body.short_description, LIMITS.short),
      images,
      idempotencyKey: key,
    },
  };
}

/** The image hosts this site will fetch from, from `CMS_PM_IMAGE_HOSTS`. */
export function pmImageHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
}

/**
 * The document a create produces, before images.
 *
 * Fields go where the read side says they are, through the same `pmFieldMap`
 * and `pmFieldSupport` rules a PATCH obeys: a rich-text body refuses PM's HTML
 * here as it does on update, and the refusal is reported in `ignored`.
 */
export function draftProductInput(
  collection: ResolvedCollection,
  input: CreateInput,
  locale: string,
): DocumentWriteInput & { status: 'draft'; ignored: string[] } {
  const map = collection.pmFieldMap ?? {};
  const { writable } = pmFieldSupport(collection);
  const ignored: string[] = [];
  let data: Record<string, unknown> = {};

  const titlePath = map.name ?? resolveTitlePath(collection) ?? 'title';
  data = setAtPath(data, titlePath, input.name);

  if (input.sku) data = setAtPath(data, 'sku', input.sku);

  if (input.shortDescription) {
    if (writable.includes('short_description') && map.short_description) {
      data = setAtPath(data, map.short_description, input.shortDescription);
    } else {
      ignored.push('short_description');
    }
  }

  if (input.description) {
    if (writable.includes('description')) {
      data = setAtPath(data, map.description ?? 'description', input.description);
    } else {
      ignored.push('description');
    }
  }

  const fromSlug = input.slug ? slugify(input.slug) : '';
  const slug = fromSlug || slugify(input.name) || `product-${input.idempotencyKey.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return { slug, locale, status: 'draft', data, ignored };
}

export interface CreateResponseImage {
  local_id: string | null;
  id: string;
  src: string;
  alt: string;
}

export interface CreateResult {
  status: 200 | 201 | 409 | 422;
  body: Record<string, unknown>;
}

function productBody(
  config: CmsConfig,
  collection: ResolvedCollection,
  row: DocumentRow,
  images: CreateResponseImage[],
): Record<string, unknown> {
  return {
    id: row.id,
    remote_id: encodeRemoteId(row),
    type: 'simple',
    slug: row.slug,
    permalink: permalinkFor(config, collection, row),
    status: 'draft',
    images,
  };
}

/** The images already in an existing product's gallery, for a repeated create. */
function galleryImages(collection: ResolvedCollection, row: DocumentRow): CreateResponseImage[] {
  const gallery = galleryPaths(collection)[0];
  if (!gallery) return [];
  const rows = getAtPath(row.data ?? {}, gallery.path);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((item) => {
    if (!isRecord(item) || typeof item[gallery.imageKey] !== 'string') return [];
    const uuid = item[gallery.imageKey] as string;
    return [{
      local_id: null,
      id: uuid,
      src: absoluteUrl(mediaUrl(uuid)),
      alt: typeof item[gallery.altKey] === 'string' ? (item[gallery.altKey] as string) : '',
    }];
  });
}

/**
 * Run `fn` over `items` with at most `limit` in flight, results in input order.
 *
 * Images are fetched this way rather than one after another: twenty images at
 * up to the fetch timeout each would hold a request open for minutes, longer
 * than PM waits for an answer. A small limit, not `Promise.all`, so one create
 * cannot open twenty connections to PM and decode twenty images at once.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A stored image, and whether this create is what put it in the library. */
export interface StoredImage {
  uuid: string;
  /** False when the library already held these exact bytes and returned that file. */
  fresh: boolean;
}

/**
 * The files to delete when a create fails after its images were stored.
 *
 * Only the ones this create uploaded. A file the library already had (matched
 * by its bytes) belongs to whatever else uses it, and deleting it would break
 * those pages.
 */
export function uploadsToDiscard(stored: readonly (StoredImage | null)[]): string[] {
  return stored.filter((s): s is StoredImage => s !== null && s.fresh).map((s) => s.uuid);
}

/** Fetch, re-encode and store one image. Null on any failure. */
async function storeImage(src: string, hosts: string[]): Promise<StoredImage | null> {
  try {
    const raw = await fetchRemoteImage(src, {
      allowHosts: hosts,
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: IMAGE_TIMEOUT_MS,
    });
    const webp = await toWebp(raw, { maxWidth: IMAGE_WIDTH });
    // No administrator uploaded this; Product Manager did.
    const media = await uploadMedia({ buffer: webp, originalName: 'product.webp', mime: 'image/webp' }, null);
    return { uuid: media.uuid, fresh: !media.duplicate };
  } catch (err) {
    console.warn('[cms/pm] product image not fetched', { src, error: err instanceof Error ? err.message : err });
    return null;
  }
}

/** Delete the files a failed create uploaded. Best effort: a leftover is not worth a second failure. */
async function discardUploads(stored: readonly (StoredImage | null)[]): Promise<void> {
  for (const uuid of uploadsToDiscard(stored)) {
    try {
      await deleteMedia(uuid);
    } catch (err) {
      console.warn('[cms/pm] could not remove an image from a failed create', { uuid, error: err instanceof Error ? err.message : err });
    }
  }
}

/** A clash on slug or SKU in the same collection and language, or null. */
async function findDuplicate(type: string, locale: string, slug: string, sku: string | null): Promise<string | null> {
  const db = getDb();
  const [sameSlug] = await db
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(and(eq(schema.documents.type, type), eq(schema.documents.slug, slug), eq(schema.documents.locale, locale)))
    .limit(1);
  if (sameSlug) return `A product with the slug "${slug}" already exists.`;

  if (sku) {
    const [sameSku] = await db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.type, type),
          eq(schema.documents.locale, locale),
          eq(adapter.jsonScalar(schema.documents.data, 'sku'), sku),
        ),
      )
      .limit(1);
    if (sameSku) return `A product with the SKU "${sku}" already exists.`;
  }
  return null;
}

/** Create a draft product from PM's body. */
export async function createProduct(
  config: CmsConfig,
  collection: ResolvedCollection,
  input: CreateInput,
  locale: string,
  principal: BridgePrincipal,
  isRetry = false,
): Promise<CreateResult> {
  const db = getDb();
  const table = schema.pmCreatedDocuments;

  // Claim the key first, so a concurrent retry hits the unique index.
  try {
    await db.insert(table).values({ idempotencyKey: input.idempotencyKey, documentId: null });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const [claim] = await db.select().from(table).where(eq(table.idempotencyKey, input.idempotencyKey)).limit(1);
    const [row] = claim?.documentId
      ? await db.select().from(schema.documents).where(eq(schema.documents.id, claim.documentId)).limit(1)
      : [];
    if (!row) {
      // A claim with no document whose create died mid-way (a crash, a
      // timeout) would otherwise refuse every retry forever. Past the longest a
      // create can take, it is abandoned: drop it and try once more.
      if (!isRetry && claim && !claim.documentId && Date.now() - claim.createdAt.getTime() > STALE_CLAIM_MS) {
        await db
          .delete(table)
          .where(and(eq(table.idempotencyKey, input.idempotencyKey), isNull(table.documentId)));
        return createProduct(config, collection, input, locale, principal, true);
      }
      return { status: 409, body: { ok: false, error: 'duplicate', message: 'That create is still in progress.' } };
    }
    return { status: 200, body: { data: productBody(config, collection, row, galleryImages(collection, row)) } };
  }

  const release = () => db.delete(table).where(eq(table.idempotencyKey, input.idempotencyKey));

  const draft = draftProductInput(collection, input, locale);
  const duplicate = await findDuplicate(collection.key, locale, draft.slug, input.sku);
  if (duplicate) {
    await release();
    return { status: 409, body: { ok: false, error: 'duplicate', message: duplicate } };
  }

  const hosts = pmImageHosts(process.env.CMS_PM_IMAGE_HOSTS);
  const images: CreateResponseImage[] = [];
  const failed: (string | null)[] = [];
  const gallery = galleryPaths(collection)[0];
  let stored: (StoredImage | null)[] = [];
  if (gallery) {
    stored =
      hosts.length > 0
        ? await mapWithLimit(input.images, IMAGE_CONCURRENCY, (image) => storeImage(image.src, hosts))
        : input.images.map(() => null);
    input.images.forEach((image, i) => {
      const file = stored[i];
      if (!file) {
        failed.push(image.localId);
        return;
      }
      images.push({ local_id: image.localId, id: file.uuid, src: absoluteUrl(mediaUrl(file.uuid)), alt: image.alt });
    });
    if (images.length > 0) {
      draft.data = setAtPath(
        draft.data,
        gallery.path,
        images.map((i) => ({ [gallery.imageKey]: i.id, [gallery.altKey]: i.alt })),
      );
    }
  } else {
    failed.push(...input.images.map((i) => i.localId));
  }

  let row: DocumentRow;
  try {
    row = await createDocument(
      config,
      collection.key,
      { slug: draft.slug, locale: draft.locale, status: draft.status, data: draft.data },
      principal.userId,
      { collection },
    );
  } catch (err) {
    // Nothing references these files yet; without this every failed create
    // would leave its images orphaned in the media library.
    await discardUploads(stored);
    await release();
    if (isDuplicateKeyError(err)) {
      return { status: 409, body: { ok: false, error: 'duplicate', message: 'That product already exists.' } };
    }
    throw err;
  }

  await db.update(table).set({ documentId: row.id }).where(eq(table.idempotencyKey, input.idempotencyKey));

  await logAudit({
    userId: principal.userId,
    actorLabel: principal.actorLabel,
    action: 'pm.product.create',
    subjectType: 'document',
    subjectId: row.id,
    after: { slug: row.slug, images: images.length, imageFailures: failed.length, ignored: draft.ignored },
  });

  const body: Record<string, unknown> = { data: productBody(config, collection, row, images) };
  if (failed.length > 0) {
    body.warnings = {
      // Named as PM's error vocabulary has it; non-fatal, the product exists.
      image_fetch_failed: failed,
      ...(hosts.length === 0 ? { image_hosts: 'CMS_PM_IMAGE_HOSTS is not set on this site.' } : {}),
    };
  }
  if (draft.ignored.length > 0) body.ignored = draft.ignored;
  return { status: 201, body };
}
