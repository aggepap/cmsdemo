import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import { revalidateTag } from 'next/cache';

import type { CmsConfig } from '../../../config';
import { getDb, schema } from '../../../db';
import type { DocumentStatus } from '../../../db/adapters/mysql/schema/documents';
import { hasPerm, PERMISSIONS } from '../../../modules/auth/permissions';
import { logAudit } from '../../audit';
import { csvRow } from '../../csv';
import { createDocument, updateDocument, type DocumentWriteInput } from '../../documents/service';
import { ApiError, badRequest, invalidInput } from '../../errors';
import { resolveCollectionWithCustomFields } from '../../fields/resolve';
import { importMediaFile } from '../../media/service';
import { revalidateDocument } from '../../read';
import { applySettingsUpdate } from '../../routes/settings';
import { revalidateRedirects } from '../../seo/resolve';
import {
  CUSTOM_FIELDS_KEY,
  getSettingUncached,
  SEO_FIELDS_KEY,
  setSetting,
  SETTINGS_TAG,
} from '../../settings';
import { nextFreeSlug, type ResolvedAction } from '../conflicts';
import type { ManifestFile } from '../format';
import { regenerateAutoIds } from '../global-ids';
import {
  groupDef,
  groupOfItem,
  isTableFamily,
  parseItemKey,
  piiProblem,
  TABLE_FAMILIES,
  type TableFamily,
} from '../groups';
import { TABLE_ADAPTERS } from '../tables/adapters';
import type { BookingMaps } from '../tables/people';
import { TABLE_RECORD_SCHEMAS, tableRecordKey, tableWriteMode } from '../tables/rules';
import { localeMapProblem, mapLocale, type LocaleMap } from '../locale-map';
import {
  docRecordSchema,
  recordMatchesKey,
  mediaRecordSchema,
  settingRecordSchema,
  type DocRecord,
  type DocRow,
} from '../records';
import { publishFieldsFor } from '../publish-fields';
import { pruneToSchema, rewriteData } from '../refs';
import { getStaging, TRANSFER_LIMITS } from '../runtime';
import { customFieldIds, mergeCustomFieldConfigs, rewriteSettingValue } from '../settings-refs';
import type { ZipReader } from '../zip-file';
import { INDEX, SUMMARY, type ImportIndex, type ImportSummary } from './analyze';
import { openPackage, readDataFile, readManifest, type ParsedLine } from './package';
import {
  buildPlan,
  makeResolver,
  type IdMaps,
  type ImportDecisions,
  type ImportPlan,
  type PlannedItem,
} from './plan';

/** A step request that stopped hearing from itself for this long is presumed dead. */
const STEP_LOCK_STALE_MS = 120_000;

const PLAN = 'plan.json';
const JOURNAL = 'journal.json';

export interface ImportOptions {
  localeMap: LocaleMap;
  /** Keep each document's published/scheduled status (needs Publish content); otherwise drafts. */
  keepStatus: boolean;
  /** Copies are always drafts unless this is off. */
  copiesAsDrafts: boolean;
  /** Confirms the importer knows the plan includes personal data (required when it does). */
  acknowledgePii?: boolean;
  /** Write password hashes the package carries (needs `transferUsers`); otherwise accounts need a new password. */
  importPasswordHashes?: boolean;
}

export type Outcome = 'created' | 'updated' | 'copied' | 'merged' | 'skipped' | 'reused' | 'failed';

export interface ItemOutcome {
  outcome: Outcome;
  label: string;
  message?: string;
  /** References that had nowhere to point on this site. */
  dropped?: number;
}

export interface ImportJournal {
  phase: 'ready' | 'running' | 'patching' | 'done' | 'cancelled';
  cursor: number;
  patchCursor: number;
  written: IdMaps;
  existing: IdMaps;
  /** Per copied document: old autoId → new, so every pass and locale agrees. */
  idRemaps: Record<string, Record<string, string>>;
  /** Source rows whose slug another document took after the preview: never written to. */
  clashed: Record<string, true>;
  /** Table items whose write started — see `writeTable`. */
  began: Record<string, true>;
  outcomes: Record<string, ItemOutcome>;
  /** Settings as they were before this import replaced them — for a manual rollback. */
  previous: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}

interface StoredPlan {
  plan: ImportPlan;
  options: ImportOptions;
  labels: Record<string, string>;
}

export interface DryRun {
  summary: ImportPlan['summary'];
  total: number;
  required: Array<{ key: string; label: string; requiredBy: string[] }>;
  external: Array<{ key: string; label: string; referencedBy: string[] }>;
  invalid: Array<{ key: string; message: string }>;
  warnings: Array<{ key: string; message: string }>;
}

export interface ImportProgress {
  phase: ImportJournal['phase'];
  done: number;
  total: number;
  current?: string;
}

async function loadIndex(id: string): Promise<ImportIndex> {
  const index = await getStaging().readJson<ImportIndex>(id, INDEX);
  if (!index) throw badRequest('Analyse the package first.');
  return index;
}

/**
 * Turn the user's choices into the plan the run will follow, and answer with
 * the dry run. Nothing is written to the site.
 */
export async function planImport(
  config: CmsConfig,
  user: { userId: number; permissions: readonly string[] },
  id: string,
  decisions: ImportDecisions,
  options: ImportOptions
): Promise<DryRun> {
  const staging = getStaging();
  await staging.meta(id, user.userId);
  // Same lock as a step: planning while the first step runs would swap the plan
  // under a journal that is already counting through the old one.
  const token = randomUUID();
  const stepLock = `step-${id}.lock`;
  if (!(await staging.acquireLock(token, STEP_LOCK_STALE_MS, stepLock))) {
    throw new ApiError('conflict', 'This import is running.');
  }
  try {
    return await planLocked(config, user, id, decisions, options);
  } finally {
    await staging.releaseLock(token, stepLock);
  }
}

async function planLocked(
  config: CmsConfig,
  user: { userId: number; permissions: readonly string[] },
  id: string,
  decisions: ImportDecisions,
  options: ImportOptions
): Promise<DryRun> {
  const staging = getStaging();
  const journal = await staging.readJson<ImportJournal>(id, JOURNAL);
  if (journal && journal.phase !== 'ready')
    throw new ApiError('conflict', 'This import has already started.');

  const summary = await staging.readJson<ImportSummary>(id, SUMMARY);
  if (summary?.compatibility.blockers.length) throw badRequest(summary.compatibility.blockers[0]);
  const index = await loadIndex(id);
  const mapProblem = localeMapProblem(options.localeMap, index.sourceLocales, config.locales);
  if (mapProblem) throw invalidInput(undefined, mapProblem);
  const result = buildPlan(index.items, decisions, {
    perms: user.permissions,
    newGroupId: randomUUID,
  });
  if (!result.ok) throw invalidInput({ formErrors: result.errors }, result.errors[0]);
  const { plan } = result;
  const pii = piiProblem(plan.order, options.acknowledgePii === true);
  if (pii) throw invalidInput({ formErrors: [pii] }, pii);
  if (options.importPasswordHashes && !hasPerm(user.permissions, PERMISSIONS.transferUsers)) {
    throw new ApiError(
      'forbidden',
      'Only someone who may move admin accounts can import password hashes.'
    );
  }

  const labels: Record<string, string> = {};
  for (const item of index.items) labels[item.key] = item.label;
  for (const [sid, row] of Object.entries(index.docRows))
    labels[row.key] ??= `${row.slug} (${row.locale}, #${sid})`;

  await staging.writeJson(id, PLAN, { plan, options, labels } satisfies StoredPlan);
  await staging.writeJson(id, JOURNAL, {
    phase: 'ready',
    cursor: 0,
    patchCursor: 0,
    written: { doc: {}, media: {} },
    existing: await resolveExisting(index, options.localeMap),
    idRemaps: {},
    clashed: {},
    began: {},
    outcomes: {},
    previous: {},
  } satisfies ImportJournal);

  const byKey = new Map(index.items.map((i) => [i.key, i]));
  return {
    summary: plan.summary,
    total: plan.order.length,
    required: Object.entries(plan.required).map(([key, by]) => ({
      key,
      label: labels[key] ?? key,
      requiredBy: by,
    })),
    external: Object.entries(plan.external).map(([key, by]) => ({
      key,
      label: labels[key] ?? key,
      referencedBy: by,
    })),
    invalid: Object.entries(plan.invalid).map(([key, message]) => ({ key, message })),
    warnings: plan.order.flatMap((key) => {
      const w = byKey.get(key)?.warning;
      return w && plan.items[key]?.action !== 'skip' ? [{ key, message: w }] : [];
    }),
  };
}

/**
 * What the package's ids already correspond to on this site, by natural key:
 * a document by (type, slug, language), a file by its content. References to
 * items that are skipped or were never in the package resolve through this.
 */
async function resolveExisting(index: ImportIndex, localeMap: LocaleMap): Promise<IdMaps> {
  const db = getDb();
  const doc: Record<string, number> = {};
  const byType = new Map<string, Array<[string, ImportIndex['docRows'][string]]>>();
  for (const entry of Object.entries(index.docRows))
    byType.set(entry[1].type, [...(byType.get(entry[1].type) ?? []), entry]);
  for (const [type, entries] of byType) {
    const slugs = [...new Set(entries.map(([, r]) => r.slug))];
    const rows = await db
      .select({
        id: schema.documents.id,
        slug: schema.documents.slug,
        locale: schema.documents.locale,
      })
      .from(schema.documents)
      .where(and(eq(schema.documents.type, type), inArray(schema.documents.slug, slugs)));
    for (const [sid, r] of entries) {
      const locale = mapLocale(localeMap, r.locale);
      const hit = rows.find((row) => row.slug === r.slug && row.locale === locale);
      if (hit) doc[sid] = hit.id;
    }
  }
  const media: Record<string, string> = {};
  const hashes = [...new Set(Object.values(index.mediaHashes))];
  if (hashes.length) {
    const rows = await db
      .select({ uuid: schema.mediaFiles.uuid, hash: schema.mediaFiles.hash })
      .from(schema.mediaFiles)
      .where(inArray(schema.mediaFiles.hash, hashes));
    const byHash = new Map(rows.map((r) => [r.hash, r.uuid]));
    for (const [uuid, hash] of Object.entries(index.mediaHashes)) {
      const hit = byHash.get(hash);
      if (hit) media[uuid] = hit;
    }
  }
  return { doc, media };
}

interface RunContext {
  config: CmsConfig;
  userId: number;
  canPublish: boolean;
  id: string;
  plan: ImportPlan;
  options: ImportOptions;
  labels: Record<string, string>;
  journal: ImportJournal;
  index: ImportIndex;
  zip: ZipReader;
  files: Map<string, ManifestFile>;
  lines: Map<string, ParsedLine[]>;
  perms: readonly string[];
  origin: string;
  /** Built on first use in a step: translation group and option maps for booking rows. */
  booking?: BookingMaps;
}

async function recordOf(ctx: RunContext, key: string): Promise<Record<string, unknown>> {
  const loc = ctx.index.locations[key];
  const file = loc && ctx.files.get(loc.file);
  if (!loc || !file) throw badRequest(`${key} is not in the package.`);
  let lines = ctx.lines.get(loc.file);
  if (!lines) {
    lines = await readDataFile(ctx.zip, file);
    ctx.lines.set(loc.file, lines);
  }
  const line = lines.find((l) => l.line === loc.line);
  if (!line?.record || line.record.k !== key)
    throw badRequest(`${key} could not be read from the package.`);
  return line.record.r;
}

/**
 * Run the next slice of the import. Call until `phase` is `done` or `cancelled`.
 * `{ cancel: true }` asks the run to stop; it stops before its next item.
 */
export async function importStep(
  config: CmsConfig,
  user: { userId: number; permissions: readonly string[] },
  id: string,
  opts: { cancel?: boolean } = {}
): Promise<ImportProgress> {
  const staging = getStaging();
  await staging.meta(id, user.userId);
  if (opts.cancel) await staging.requestCancel(id, user.userId);

  // One request works on a job at a time. A second one (another tab, a retry)
  // only reports progress: two writers would overwrite each other's journal.
  const token = randomUUID();
  const stepLock = `step-${id}.lock`;
  const mine = await staging.acquireLock(token, STEP_LOCK_STALE_MS, stepLock);
  try {
    const stored = await staging.readJson<StoredPlan>(id, PLAN);
    const journal = await staging.readJson<ImportJournal>(id, JOURNAL);
    if (!stored || !journal) throw badRequest('Plan the import first.');
    const total = stored.plan.order.length + stored.plan.patch.length;
    const progress = (current?: string): ImportProgress => ({
      phase: journal.phase,
      done: journal.cursor + journal.patchCursor,
      total,
      ...(current ? { current } : {}),
    });
    if (!mine || journal.phase === 'done' || journal.phase === 'cancelled') return progress();

    const cancelRun = async (): Promise<ImportProgress> => {
      journal.phase = 'cancelled';
      journal.finishedAt = new Date().toISOString();
      await staging.writeJson(id, JOURNAL, journal);
      await staging.releaseLock(id);
      await logAudit({
        userId: user.userId,
        action: 'transfer.import.cancel',
        subjectType: 'transfer',
        subjectId: id,
        after: counts(journal),
      });
      return progress();
    };
    if (await staging.isCancelRequested(id)) return await cancelRun();

    if (!(await staging.acquireLock(id, TRANSFER_LIMITS.lockStaleMs))) {
      throw new ApiError(
        'conflict',
        'Another import is running on this site. Wait for it to finish.'
      );
    }

    try {
      const zip = await openPackage(staging.uploadPath(id));
      try {
        const manifest = await readManifest(zip);
        const ctx: RunContext = {
          config,
          userId: user.userId,
          canPublish: hasPerm(user.permissions, PERMISSIONS.contentPublish),
          id,
          plan: stored.plan,
          options: stored.options,
          labels: stored.labels,
          journal,
          index: await loadIndex(id),
          zip,
          files: new Map(manifest.files.map((f) => [f.path, f])),
          lines: new Map(),
          perms: user.permissions,
          origin: manifest.source.origin || manifest.source.siteName,
        };

        if (journal.phase === 'ready') {
          journal.phase = 'running';
          journal.startedAt = new Date().toISOString();
          await staging.writeJson(id, JOURNAL, journal);
          await logAudit({
            userId: user.userId,
            action: 'transfer.import.start',
            subjectType: 'transfer',
            subjectId: id,
            after: { summary: stored.plan.summary, total: stored.plan.order.length },
          });
        }

        const started = Date.now();
        let current: string | undefined;
        while (Date.now() - started < TRANSFER_LIMITS.stepBudgetMs) {
          if (await staging.isCancelRequested(id)) return await cancelRun();
          if (journal.phase === 'running') {
            if (journal.cursor >= ctx.plan.order.length) {
              journal.phase = 'patching';
              continue;
            }
            const key = ctx.plan.order[journal.cursor];
            current = ctx.labels[key] ?? key;
            await runItem(ctx, key, ctx.plan.items[key]);
            journal.cursor++;
            await staging.writeJson(id, JOURNAL, journal);
            // Settings are read through a cache; later items must see them in a fresh request.
            const next = ctx.plan.order[journal.cursor];
            if (groupOfItem(key) === 'settings' && (!next || groupOfItem(next) !== 'settings'))
              break;
          } else if (journal.phase === 'patching') {
            if (journal.patchCursor >= ctx.plan.patch.length) {
              await finish(ctx);
              break;
            }
            const key = ctx.plan.patch[journal.patchCursor];
            current = ctx.labels[key] ?? key;
            await patchItem(ctx, key);
            journal.patchCursor++;
            await staging.writeJson(id, JOURNAL, journal);
          } else {
            break;
          }
        }
        await staging.writeJson(id, JOURNAL, journal);
        return progress(current);
      } finally {
        await zip.close();
      }
    } catch (err) {
      // Not an item failure — those are recorded and the run goes on — but the
      // package, the journal or the database itself. Let other imports proceed;
      // the journal still says where this one resumes.
      await staging.releaseLock(id);
      throw err;
    }
  } finally {
    if (mine) await staging.releaseLock(token, stepLock);
  }
}

async function finish(ctx: RunContext): Promise<void> {
  ctx.journal.phase = 'done';
  ctx.journal.finishedAt = new Date().toISOString();
  revalidateTag(SETTINGS_TAG, { expire: 0 });
  revalidateRedirects();
  for (const family of TABLE_FAMILIES) {
    if (ctx.plan.order.some((k) => groupOfItem(k) === family)) TABLE_ADAPTERS[family].revalidate();
  }
  await getStaging().releaseLock(ctx.id);
  await logAudit({
    userId: ctx.userId,
    action: 'transfer.import.finish',
    subjectType: 'transfer',
    subjectId: ctx.id,
    after: counts(ctx.journal),
  });
}

function counts(journal: ImportJournal): Record<Outcome, number> {
  const out: Record<Outcome, number> = {
    created: 0,
    updated: 0,
    copied: 0,
    merged: 0,
    skipped: 0,
    reused: 0,
    failed: 0,
  };
  for (const o of Object.values(journal.outcomes)) out[o.outcome]++;
  return out;
}

async function runItem(ctx: RunContext, key: string, planned: PlannedItem): Promise<void> {
  const label = ctx.labels[key] ?? key;
  try {
    const family = parseItemKey(key)?.family;
    if (family === 'media') await writeMedia(ctx, key);
    else if (family === 'settings') await writeSetting(ctx, key, planned.action);
    else if (family === 'documents') {
      await writeDocument(ctx, key, planned);
      ctx.booking = undefined; // a new document changes what source groups map to
    } else if (family && isTableFamily(family)) await writeTable(ctx, key, family, planned.action);
  } catch (err) {
    ctx.journal.outcomes[key] = { outcome: 'failed', label, message: failureMessage(err) };
    if (!(err instanceof ApiError)) console.error('[cms/transfer] import item failed', key, err);
  }
}

/**
 * What went wrong, in words someone can act on. A validation refusal carries
 * its summary ("Validation failed.") and, in `issues`, which field and why — the
 * report shows the specifics, at most three, so a row says what to fix.
 */
export function failureMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not be written. The server log has the details.';
  const issues = err.issues as
    | {
        pathErrors?: Record<string, string[]>;
        fieldErrors?: Record<string, string[]>;
        formErrors?: string[];
      }
    | undefined;
  const byPath = Object.entries(issues?.pathErrors ?? issues?.fieldErrors ?? {}).flatMap(
    ([path, msgs]) => msgs.map((m) => (m.includes(path) ? m : `${path}: ${m}`))
  );
  const specific = [...byPath, ...(issues?.formErrors ?? [])];
  return specific.length ? specific.slice(0, 3).join('; ') : err.message;
}

/** The record must be the item its key names; analysis checked it, the run does not trust a re-read. */
function assertMatches(
  key: string,
  record: { type?: unknown; key?: unknown; uuid?: unknown }
): void {
  if (!recordMatchesKey(key, record))
    throw badRequest(`${key} does not match its record in the package.`);
}

// ── Site-configuration tables ────────────────────────────────────────────────

/**
 * One row of a configuration table (and its child rows).
 *
 * A row with the same natural key that exists BEFORE this item began belongs
 * to someone else — it appeared after the preview — and is left alone. One that
 * exists because an earlier, interrupted attempt of this very item wrote it is
 * completed in place (`began` is saved before the first write).
 */
async function writeTable(
  ctx: RunContext,
  key: string,
  family: TableFamily,
  action: ResolvedAction
): Promise<void> {
  const record = TABLE_RECORD_SCHEMAS[family].parse(await recordOf(ctx, key)) as Record<
    string,
    unknown
  >;
  if (tableRecordKey(family, record) !== key)
    throw badRequest(`${key} does not match its record in the package.`);
  const label = ctx.labels[key] ?? key;
  if (action === 'skip') {
    ctx.journal.outcomes[key] = { outcome: 'skipped', label };
    return;
  }
  const adapter = TABLE_ADAPTERS[family];
  const planned =
    action === 'create' || action === 'copy' || action === 'merge' ? action : 'overwrite';
  const exists =
    planned === 'create' || planned === 'copy' ? Boolean(await adapter.match(record)) : true;
  const mode = tableWriteMode(planned, { exists, resumed: ctx.journal.began[key] === true });
  if (mode === 'skip-appeared' || mode === 'skip-interrupted-copy' || mode === 'skip') {
    ctx.journal.outcomes[key] = {
      outcome: 'skipped',
      label,
      ...(mode === 'skip-appeared'
        ? { message: 'Created on this site after the preview; left as it is.' }
        : mode === 'skip-interrupted-copy'
          ? {
              message:
                'The import was interrupted while copying this; check for a copy before importing it again.',
            }
          : {}),
    };
    return;
  }
  ctx.journal.began[key] = true;
  await getStaging().writeJson(ctx.id, JOURNAL, ctx.journal);
  const resolver = makeResolver(ctx.journal.written, ctx.journal.existing);
  const res = await adapter.write(record, mode, {
    resolver,
    userId: ctx.userId,
    perms: ctx.perms,
    importPasswordHashes:
      ctx.options.importPasswordHashes === true && hasPerm(ctx.perms, PERMISSIONS.transferUsers),
    origin: ctx.origin,
    booking: ctx.booking ?? (ctx.booking = await bookingMaps(ctx)),
  });
  ctx.journal.outcomes[key] = {
    outcome: res.outcome,
    label,
    ...(res.message ? { message: res.message } : {}),
    ...(res.dropped ? { dropped: res.dropped } : {}),
  };
}

/**
 * Source translation groups and booking option ids, as this site has them.
 *
 * A group maps through any of its document rows: the resolver says which row
 * here it became, and that row's group is the answer. An option maps only when
 * its experience was COPIED (and so re-minted its option ids); otherwise it
 * keeps its id, because the experience's data kept it.
 */
async function bookingMaps(ctx: RunContext): Promise<BookingMaps> {
  const resolver = makeResolver(ctx.journal.written, ctx.journal.existing);
  const sidByGroup = new Map<string, number>();
  for (const [sid, row] of Object.entries(ctx.index.docRows)) {
    const group = row.key.slice(row.key.indexOf(':', 4) + 1);
    if (!sidByGroup.has(group)) sidByGroup.set(group, Number(sid));
  }
  const targetIds = [...sidByGroup.values()]
    .map((sid) => resolver.doc(sid))
    .filter((x): x is number => x !== null);
  const targets = targetIds.length
    ? await getDb()
        .select({ id: schema.documents.id, group: schema.documents.translationGroupId })
        .from(schema.documents)
        .where(inArray(schema.documents.id, targetIds))
    : [];
  const groupOf = new Map(targets.map((t) => [t.id, t.group ?? `doc:${t.id}`]));
  const options = new Map<string, string>();
  for (const remap of Object.values(ctx.journal.idRemaps))
    for (const [from, to] of Object.entries(remap)) options.set(from, to);
  return {
    group: (g) => {
      const sid = sidByGroup.get(g);
      const target = sid === undefined ? null : resolver.doc(sid);
      return target === null ? null : (groupOf.get(target) ?? null);
    },
    doc: (id) => resolver.doc(id),
    option: (id) => options.get(id) ?? null,
  };
}

// ── Media ────────────────────────────────────────────────────────────────────

async function folderIdFor(path: string[] | null): Promise<number | null> {
  if (!path?.length) return null;
  const db = getDb();
  let parentId: number | null = null;
  for (const name of path) {
    const [hit] = await db
      .select({ id: schema.mediaFolders.id })
      .from(schema.mediaFolders)
      .where(
        and(
          eq(schema.mediaFolders.name, name),
          parentId === null
            ? isNull(schema.mediaFolders.parentId)
            : eq(schema.mediaFolders.parentId, parentId)
        )
      )
      .limit(1);
    if (hit) {
      parentId = hit.id;
      continue;
    }
    const [res] = await db.insert(schema.mediaFolders).values({ name, parentId }).$returningId();
    parentId = res.id;
  }
  return parentId;
}

async function writeMedia(ctx: RunContext, key: string): Promise<void> {
  const record = mediaRecordSchema.parse(await recordOf(ctx, key));
  assertMatches(key, record);
  const label = record.originalName;
  const existing = ctx.journal.existing.media[record.uuid];
  if (existing) {
    ctx.journal.written.media[record.uuid] = existing;
    ctx.journal.outcomes[key] = {
      outcome: 'reused',
      label,
      message: 'This file is already on this site.',
    };
    return;
  }
  const bytes = await ctx.zip.read(`media/${record.uuid}`);
  const avifName = `media/${record.uuid}.avif`;
  const avif = record.hasAvif && ctx.zip.has(avifName) ? await ctx.zip.read(avifName) : null;
  const result = await importMediaFile(
    {
      sourceUuid: record.uuid,
      bytes,
      avif,
      originalName: record.originalName,
      altText: record.altText,
      folderId: await folderIdFor(record.folderPath),
    },
    ctx.userId
  );
  if (result.outcome === 'rejected') {
    ctx.journal.outcomes[key] = { outcome: 'failed', label, message: result.reason };
    return;
  }
  ctx.journal.written.media[record.uuid] = result.uuid;
  ctx.journal.outcomes[key] = {
    outcome: result.outcome === 'reused' ? 'reused' : 'created',
    label,
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

async function writeSetting(ctx: RunContext, key: string, action: ResolvedAction): Promise<void> {
  const record = settingRecordSchema.parse(await recordOf(ctx, key));
  assertMatches(key, record);
  const label = record.key;
  if (action === 'skip') {
    ctx.journal.outcomes[key] = { outcome: 'skipped', label };
    return;
  }
  const resolver = makeResolver(ctx.journal.written, ctx.journal.existing);
  const { value, dropped } = rewriteSettingValue(record.key, record.value, resolver);
  // What was here before this import — recorded, and saved, BEFORE writing, so a
  // crash between the two cannot leave the imported value recorded as "previous".
  if (!(record.key in ctx.journal.previous)) {
    ctx.journal.previous[record.key] = await getSettingUncached(record.key);
    await getStaging().writeJson(ctx.id, JOURNAL, ctx.journal);
  }
  const before = ctx.journal.previous[record.key] ?? null;
  const current = await getSettingUncached(record.key);
  let next = value;
  if (action === 'merge') {
    next =
      record.key === CUSTOM_FIELDS_KEY
        ? mergeCustomFieldConfigs(current, value, customFieldIds(before))
        : isRecord(current) && isRecord(value)
          ? { ...value, ...current }
          : (current ?? value);
  }
  await writeSettingValue(ctx, record.key, next);
  ctx.journal.outcomes[key] = {
    outcome: action === 'merge' ? 'merged' : before === null ? 'created' : 'updated',
    label,
    ...(dropped.length ? { dropped: dropped.length } : {}),
  };
}

/** Through the settings screen's own validation, so an import cannot store what the screen would refuse. */
async function writeSettingValue(ctx: RunContext, key: string, value: unknown): Promise<void> {
  const input: Rec = { [key]: value };
  // The edit baselines guard against overwriting a concurrent edit; an import
  // replaces deliberately, so it states what is stored now.
  if (key === CUSTOM_FIELDS_KEY) {
    const stored = await getSettingUncached<Rec>(CUSTOM_FIELDS_KEY);
    const baseline: Rec = {};
    for (const collection of Object.keys(isRecord(value) ? value : {}))
      baseline[collection] = stored?.[collection] ?? null;
    input['cms.customFields.baseline'] = baseline;
  }
  if (key === SEO_FIELDS_KEY)
    input['cms.seoFields.baseline'] = await getSettingUncached(SEO_FIELDS_KEY);
  await applySettingsUpdate(ctx.config, input, ctx.userId, {
    read: getSettingUncached,
    write: setSetting,
  });
}

// ── Documents ────────────────────────────────────────────────────────────────

const publishFields = (
  ctx: RunContext,
  row: DocRow,
  action: ResolvedAction,
  mode: 'create' | 'update'
) =>
  publishFieldsFor(
    {
      canPublish: ctx.canPublish,
      keepStatus: ctx.options.keepStatus,
      copiesAsDrafts: ctx.options.copiesAsDrafts,
    },
    action,
    mode,
    row
  );

const toDate = (s: string | null): Date | null => (s ? new Date(s) : null);

async function prepareRow(
  ctx: RunContext,
  key: string,
  type: string,
  row: DocRow,
  action: ResolvedAction
): Promise<{
  /** Everything but the slug, language and publishing fields (see `publishFieldsFor`). */
  input: Omit<DocumentWriteInput, 'slug' | 'locale' | 'status' | 'publishedAt' | 'scheduledFor'>;
  dropped: number;
  collection: Awaited<ReturnType<typeof resolveCollectionWithCustomFields>>;
}> {
  const config = ctx.config;
  const base = await resolveCollectionWithCustomFields(config, type, {
    data: row.data,
    relaxRequired: true,
  });
  const pruned = pruneToSchema(base.fields, row.data, ctx.options.localeMap);
  const resolver = makeResolver(ctx.journal.written, ctx.journal.existing);
  const rewritten = rewriteData(base.fields, pruned.data, resolver);
  let data = rewritten.data;
  if (action === 'copy') {
    const remap = new Map(Object.entries(ctx.journal.idRemaps[key] ?? {}));
    data = regenerateAutoIds(base.fields, data, remap, randomUUID);
    ctx.journal.idRemaps[key] = Object.fromEntries(remap);
  }
  const ogImageUuid = row.ogImageUuid ? resolver.media(row.ogImageUuid) : null;
  const collection = await resolveCollectionWithCustomFields(config, type, { data });
  return {
    input: {
      data,
      metaTitle: row.metaTitle,
      metaDescription: row.metaDescription,
      noindex: row.noindex,
      nofollow: row.nofollow,
      includeInSitemap: row.includeInSitemap,
      ogImageUuid,
      modifiedAt: toDate(row.modifiedAt),
    },
    dropped: rewritten.dropped.length + (row.ogImageUuid && !ogImageUuid ? 1 : 0),
    collection,
  };
}

/**
 * A NEW document that fails validation only because this site insists on
 * something for live content (a required field the source did not have) is
 * created as a draft rather than lost — the editor can finish it here. Never
 * used for an overwrite: demoting an existing live page would take it off the
 * site, which is a publishing decision the import does not get to make.
 */
async function withDraftFallback<T>(
  input: { status?: DocumentStatus },
  write: (status: DocumentStatus | undefined) => Promise<T>
): Promise<{ row: T; demoted: boolean }> {
  try {
    return { row: await write(input.status), demoted: false };
  } catch (err) {
    const live = input.status === 'published' || input.status === 'scheduled';
    if (!live || !(err instanceof ApiError) || err.code !== 'invalid_input') throw err;
    return { row: await write('draft'), demoted: true };
  }
}

async function writeDocument(ctx: RunContext, key: string, planned: PlannedItem): Promise<void> {
  const record: DocRecord = docRecordSchema.parse(await recordOf(ctx, key));
  assertMatches(key, record);
  const { type } = record;
  const label = ctx.labels[key] ?? key;
  const db = getDb();
  const action = planned.action;

  if (action === 'skip') {
    for (const row of record.rows) {
      const tid = ctx.journal.existing.doc[String(row.sourceId)];
      if (tid) ctx.journal.written.doc[String(row.sourceId)] = tid;
    }
    ctx.journal.outcomes[key] = { outcome: 'skipped', label };
    return;
  }

  const rows = record.rows.flatMap((row) => {
    const locale = mapLocale(ctx.options.localeMap, row.locale);
    return locale ? [{ row, locale }] : [];
  });
  if (!rows.length) {
    ctx.journal.outcomes[key] = {
      outcome: 'skipped',
      label,
      message: 'None of its languages exist on this site.',
    };
    return;
  }

  // The group everything is written into: planned for new items and copies, the existing one for overwrites.
  let groupId = planned.targetGroupId ?? null;
  let adoptGroup = false;
  if (action === 'overwrite') {
    const ids = rows
      .map(({ row }) => ctx.journal.existing.doc[String(row.sourceId)])
      .filter((x): x is number => !!x);
    const [target] = ids.length
      ? await db
          .select({ groupId: schema.documents.translationGroupId })
          .from(schema.documents)
          .where(inArray(schema.documents.id, ids))
          .limit(1)
      : [];
    // A matched item with no translation group adopts the planned id, so the
    // languages this import adds join it — and a retry adds them to the same group.
    adoptGroup = !target?.groupId;
    groupId = target?.groupId ?? planned.targetGroupId ?? randomUUID();
  }
  const already = groupId
    ? await db
        .select({ id: schema.documents.id, locale: schema.documents.locale })
        .from(schema.documents)
        .where(
          and(eq(schema.documents.type, type), eq(schema.documents.translationGroupId, groupId))
        )
    : [];

  let dropped = 0;
  let demoted = false;
  let clashes = 0;
  const messages: string[] = [];
  for (const { row, locale } of rows) {
    const sid = String(row.sourceId);
    const prepared = await prepareRow(ctx, key, type, row, action);
    dropped += prepared.dropped;
    const opts = { collection: prepared.collection };

    // Overwrite in place when this language exists; otherwise add it to the group.
    const target =
      action === 'overwrite'
        ? (ctx.journal.existing.doc[sid] ?? already.find((a) => a.locale === locale)?.id)
        : already.find((a) => a.locale === locale)?.id; // written by an interrupted earlier attempt
    if (target) {
      const updated = await updateDocument(
        ctx.config,
        target,
        {
          ...prepared.input,
          ...publishFields(ctx, row, action, 'update'),
          ...(adoptGroup && groupId ? { translationGroupId: groupId } : {}),
        },
        ctx.userId,
        opts
      );
      ctx.journal.written.doc[sid] = updated.id;
      revalidateDocument(updated);
      continue;
    }

    let slug = row.slug;
    if (action === 'copy') {
      const taken = await db
        .select({ slug: schema.documents.slug })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.type, type),
            eq(schema.documents.locale, locale),
            like(schema.documents.slug, `${row.slug.replace(/[\\%_]/g, '\\$&')}%`)
          )
        );
      slug = nextFreeSlug(row.slug, new Set(taken.map((t) => t.slug)));
    } else {
      const [clash] = await db
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.type, type),
            eq(schema.documents.slug, slug),
            eq(schema.documents.locale, locale)
          )
        )
        .limit(1);
      if (clash) {
        // Someone else's document now: links resolve to it, but nothing here —
        // not even the second pass — may write into it.
        messages.push(`${locale}: "${slug}" was taken after the preview; left as it is.`);
        ctx.journal.written.doc[sid] = clash.id;
        ctx.journal.clashed[sid] = true;
        clashes++;
        continue;
      }
    }
    const publish = publishFields(ctx, row, action, 'create');
    const res = await withDraftFallback(publish, (status) =>
      createDocument(
        ctx.config,
        type,
        { ...prepared.input, ...publish, status, slug, locale, translationGroupId: groupId },
        ctx.userId,
        opts
      )
    );
    demoted ||= res.demoted;
    ctx.journal.written.doc[sid] = res.row.id;
    revalidateDocument(res.row);
  }

  if (demoted)
    messages.push(
      'Saved as a draft: it is missing something this site requires before publishing.'
    );
  if (rows.length < record.rows.length)
    messages.push(`${record.rows.length - rows.length} language(s) left out.`);
  ctx.journal.outcomes[key] = {
    outcome:
      clashes === rows.length
        ? 'skipped'
        : action === 'copy'
          ? 'copied'
          : action === 'overwrite'
            ? 'updated'
            : 'created',
    label,
    ...(messages.length ? { message: messages.join(' ') } : {}),
    ...(dropped ? { dropped } : {}),
  };
}

/** Second pass for items written before something they reference existed. */
async function patchItem(ctx: RunContext, key: string): Promise<void> {
  const planned = ctx.plan.items[key];
  const outcome = ctx.journal.outcomes[key];
  if (!planned || !outcome || outcome.outcome === 'failed' || outcome.outcome === 'skipped') return;
  try {
    const family = parseItemKey(key)?.family;
    if (family === 'settings') {
      const record = settingRecordSchema.parse(await recordOf(ctx, key));
      const { value, dropped } = rewriteSettingValue(
        record.key,
        record.value,
        makeResolver(ctx.journal.written, ctx.journal.existing)
      );
      const next =
        planned.action === 'merge' && record.key === CUSTOM_FIELDS_KEY
          ? mergeCustomFieldConfigs(
              await getSettingUncached(record.key),
              value,
              customFieldIds(ctx.journal.previous[record.key])
            )
          : value;
      await writeSettingValue(ctx, record.key, next);
      outcome.dropped = dropped.length || undefined;
      return;
    }
    if (family !== 'documents') return;
    const record = docRecordSchema.parse(await recordOf(ctx, key));
    let dropped = 0;
    for (const row of record.rows) {
      const target = ctx.journal.written.doc[String(row.sourceId)];
      if (!target || ctx.journal.clashed[String(row.sourceId)]) continue;
      if (!mapLocale(ctx.options.localeMap, row.locale)) continue;
      const prepared = await prepareRow(ctx, key, record.type, row, planned.action);
      dropped += prepared.dropped;
      const updated = await updateDocument(
        ctx.config,
        target,
        { data: prepared.input.data },
        ctx.userId,
        {
          collection: prepared.collection,
        }
      );
      revalidateDocument(updated);
    }
    outcome.dropped = dropped || undefined;
  } catch (err) {
    outcome.message = `${outcome.message ? `${outcome.message} ` : ''}Its links to other imported items could not be completed: ${failureMessage(err)}`;
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface ReportRow {
  key: string;
  group: string;
  label: string;
  action: string;
  outcome: Outcome | 'pending';
  message: string;
  dropped: number;
}

export async function importReport(
  userId: number,
  id: string
): Promise<{
  progress: ImportProgress;
  rows: ReportRow[];
  previousSettings: Record<string, unknown>;
}> {
  const staging = getStaging();
  await staging.meta(id, userId);
  const stored = await staging.readJson<StoredPlan>(id, PLAN);
  const journal = await staging.readJson<ImportJournal>(id, JOURNAL);
  if (!stored || !journal) throw badRequest('Nothing has been planned yet.');
  const rows: ReportRow[] = stored.plan.order.map((key) => {
    const o = journal.outcomes[key];
    const group = groupOfItem(key);
    return {
      key,
      group: group
        ? group.startsWith('documents:')
          ? group.slice(10)
          : groupDef(group).label
        : '',
      label: o?.label ?? stored.labels[key] ?? key,
      action: stored.plan.items[key]?.action ?? '',
      outcome: o?.outcome ?? 'pending',
      message: o?.message ?? '',
      dropped: o?.dropped ?? 0,
    };
  });
  return {
    progress: {
      phase: journal.phase,
      done: journal.cursor + journal.patchCursor,
      total: stored.plan.order.length + stored.plan.patch.length,
    },
    rows,
    previousSettings: journal.previous,
  };
}

export function reportCsv(rows: readonly ReportRow[]): string {
  const header = csvRow(['Group', 'Item', 'Action', 'Outcome', 'References dropped', 'Notes']);
  return [
    header,
    ...rows.map((r) => csvRow([r.group, r.label, r.action, r.outcome, r.dropped, r.message])),
  ].join('\r\n');
}
