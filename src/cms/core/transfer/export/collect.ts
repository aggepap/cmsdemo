import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import type { CmsConfig } from '../../../config';
import { getDb, schema } from '../../../db';
import type { DocumentRow } from '../../../db/adapters/mysql/schema/documents';
import { resolveCollectionWithCustomFields } from '../../fields/resolve';
import { collectionAvailable } from '../../routes/collections';
import { managedKeys } from '../../routes/settings';
import { getSettingUncached, resolveModuleFlags } from '../../settings';
import { closure } from '../closure';
import {
  allGroupKeys,
  canExportGroup,
  docGroupKey,
  groupDef,
  groupOfItem,
  isTableFamily,
  itemKey,
  parseItemKey,
  TABLE_FAMILIES,
  type GroupKey,
} from '../groups';
import { loadTableRows, TABLE_ADAPTERS } from '../tables/adapters';
import type { ExportOptions } from '../tables/shared';
import { tableKey } from '../tables/rules';
import { collectRefs, isUuid } from '../refs';
import type { DocRecord, MediaRecord, SettingRecord, Stubs } from '../records';
import { collectSettingRefs, isExportableSetting } from '../settings-refs';

type DocStub = Stubs['documents'][number];
type MediaStub = Stubs['media'][number];

/** A reference from an item to something else, with what to write if that something stays behind. */
/**
 * A reference to another item. `stub` describes it by natural key when it stays
 * behind; a slug-keyed item (a script, a review location) needs none.
 */
export type RefTarget = {
  key: string;
  stub?: { kind: 'doc'; doc: DocStub } | { kind: 'media'; media: MediaStub };
};

export interface LoadedItem {
  key: string;
  group: GroupKey;
  label: string;
  /** The source id: first row id of a document, a media uuid, a setting key. */
  sid: number | string;
  record: DocRecord | MediaRecord | SettingRecord | Record<string, unknown>;
  refs: RefTarget[];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function docTitle(data: Record<string, unknown>, fallback: string): string {
  for (const k of ['title', 'name', 'label', 'question']) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const first = Object.values(v as Record<string, unknown>).find(
        (x) => typeof x === 'string' && x.trim()
      );
      if (typeof first === 'string') return first.trim();
    }
  }
  return fallback;
}

async function loadDocs(config: CmsConfig, keys: string[]): Promise<LoadedItem[]> {
  const db = getDb();
  const byType = new Map<string, { groups: string[]; ids: number[] }>();
  for (const key of keys) {
    const p = parseItemKey(key);
    if (p?.family !== 'documents') continue;
    const bucket = byType.get(p.type) ?? { groups: [], ids: [] };
    const idMatch = /^id-(\d+)$/.exec(p.id);
    if (idMatch) bucket.ids.push(Number(idMatch[1]));
    else bucket.groups.push(p.id);
    byType.set(p.type, bucket);
  }

  const rows: DocumentRow[] = [];
  for (const [type, { groups, ids }] of byType) {
    if (groups.length) {
      rows.push(
        ...(await db
          .select()
          .from(schema.documents)
          .where(
            and(
              eq(schema.documents.type, type),
              inArray(schema.documents.translationGroupId, groups)
            )
          ))
      );
    }
    if (ids.length) {
      rows.push(
        ...(await db
          .select()
          .from(schema.documents)
          .where(and(eq(schema.documents.type, type), inArray(schema.documents.id, ids))))
      );
    }
  }

  const grouped = new Map<string, DocumentRow[]>();
  for (const row of rows) {
    const key = itemKey.doc(row.type, docGroupKey(row));
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  // Every reference, resolved in one pass so a referenced row's group key is known.
  const perRow = new Map<number, ReturnType<typeof collectRefs>>();
  for (const row of rows) {
    const collection = await resolveCollectionWithCustomFields(config, row.type, {
      data: row.data,
      relaxRequired: true,
    });
    const refs = collectRefs(collection.fields, row.data);
    if (row.ogImageUuid) refs.push({ kind: 'media', value: row.ogImageUuid, path: 'ogImageUuid' });
    perRow.set(row.id, refs);
  }
  const allRefs = [...perRow.values()].flat();
  const docIds = [
    ...new Set(allRefs.filter((r) => r.kind === 'doc').map((r) => r.value as number)),
  ];
  const uuids = [
    ...new Set(
      allRefs.filter((r) => r.kind === 'media' && isUuid(r.value)).map((r) => r.value as string)
    ),
  ];
  const targets = docIds.length
    ? await db.select().from(schema.documents).where(inArray(schema.documents.id, docIds))
    : [];
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const media = uuids.length
    ? await db.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.uuid, uuids))
    : [];
  const mediaByUuid = new Map(media.map((m) => [m.uuid, m]));

  const out: LoadedItem[] = [];
  for (const [key, group] of grouped) {
    const first = group[0];
    const refs: RefTarget[] = [];
    for (const row of group) {
      for (const ref of perRow.get(row.id) ?? []) {
        if (ref.kind === 'doc') {
          const t = targetById.get(ref.value as number);
          if (!t) continue;
          refs.push({
            key: itemKey.doc(t.type, docGroupKey(t)),
            stub: {
              kind: 'doc',
              doc: {
                sid: t.id,
                type: t.type,
                slug: t.slug,
                locale: t.locale,
                translationGroupId: t.translationGroupId,
              },
            },
          });
        } else if (ref.kind === 'media') {
          const m = mediaByUuid.get(ref.value as string);
          if (m)
            refs.push({
              key: itemKey.media(m.uuid),
              stub: { kind: 'media', media: { uuid: m.uuid, hash: m.hash } },
            });
        } else if (ref.kind === 'script') {
          // A shortcode names a snippet by slug: nothing to rewrite, but it should come along.
          refs.push({ key: tableKey.script(String(ref.value)) });
        } else if (ref.kind === 'reviewLocation') {
          refs.push({ key: tableKey.reviewLocation(String(ref.value)) });
        }
      }
    }
    out.push({
      key,
      group: `documents:${first.type}`,
      label: docTitle(first.data, first.slug),
      sid: first.id,
      record: {
        type: first.type,
        translationGroupId: first.translationGroupId,
        rows: group.map((row) => ({
          sourceId: row.id,
          slug: row.slug,
          locale: row.locale,
          status: row.status,
          publishedAt: iso(row.publishedAt),
          scheduledFor: iso(row.scheduledFor),
          modifiedAt: iso(row.modifiedAt),
          metaTitle: row.metaTitle,
          metaDescription: row.metaDescription,
          noindex: row.noindex,
          nofollow: row.nofollow,
          includeInSitemap: row.includeInSitemap,
          ogImageUuid: row.ogImageUuid,
          data: row.data,
        })),
      },
      refs,
    });
  }
  return out;
}

async function folderPaths(): Promise<Map<number, string[]>> {
  const folders = await getDb().select().from(schema.mediaFolders);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<number, string[]>();
  for (const f of folders) {
    const path: string[] = [];
    const seen = new Set<number>();
    let at: typeof f | undefined = f;
    while (at && !seen.has(at.id) && path.length < 20) {
      seen.add(at.id);
      path.unshift(at.name);
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    paths.set(f.id, path);
  }
  return paths;
}

async function loadMedia(
  keys: string[],
  hasAvif: (uuid: string) => Promise<boolean>
): Promise<LoadedItem[]> {
  const uuids = keys.map(parseItemKey).flatMap((p) => (p?.family === 'media' ? [p.id] : []));
  if (!uuids.length) return [];
  const rows = await getDb()
    .select()
    .from(schema.mediaFiles)
    .where(inArray(schema.mediaFiles.uuid, uuids));
  const folders = rows.some((r) => r.folderId) ? await folderPaths() : new Map<number, string[]>();
  const out: LoadedItem[] = [];
  for (const m of rows) {
    out.push({
      key: itemKey.media(m.uuid),
      group: 'media',
      label: m.originalName,
      sid: m.uuid,
      record: {
        uuid: m.uuid,
        hash: m.hash,
        originalName: m.originalName,
        altText: m.altText,
        folderPath: m.folderId ? (folders.get(m.folderId) ?? null) : null,
        hasAvif: await hasAvif(m.uuid),
      },
      refs: [],
    });
  }
  return out;
}

async function loadSettings(config: CmsConfig, keys: string[]): Promise<LoadedItem[]> {
  const allowed = new Set(managedKeys(config).filter(isExportableSetting));
  const out: LoadedItem[] = [];
  const settingKeys = keys
    .map(parseItemKey)
    .flatMap((p) => (p?.family === 'settings' ? [p.id] : []));
  for (const key of settingKeys) {
    if (!allowed.has(key)) continue;
    const value = await getSettingUncached(key);
    if (value === null || value === undefined) continue;
    const refs: RefTarget[] = [];
    const refList = collectSettingRefs(key, value);
    const docIds = refList.filter((r) => r.kind === 'doc').map((r) => r.value as number);
    const uuids = refList.filter((r) => r.kind === 'media').map((r) => r.value as string);
    if (docIds.length) {
      const targets = await getDb()
        .select()
        .from(schema.documents)
        .where(inArray(schema.documents.id, docIds));
      for (const t of targets) {
        refs.push({
          key: itemKey.doc(t.type, docGroupKey(t)),
          stub: {
            kind: 'doc',
            doc: {
              sid: t.id,
              type: t.type,
              slug: t.slug,
              locale: t.locale,
              translationGroupId: t.translationGroupId,
            },
          },
        });
      }
    }
    if (uuids.length) {
      const media = await getDb()
        .select()
        .from(schema.mediaFiles)
        .where(inArray(schema.mediaFiles.uuid, uuids));
      for (const m of media)
        refs.push({
          key: itemKey.media(m.uuid),
          stub: { kind: 'media', media: { uuid: m.uuid, hash: m.hash } },
        });
    }
    out.push({
      key: itemKey.setting(key),
      group: 'settings',
      label: key,
      sid: key,
      record: { key, value },
      refs,
    });
  }
  return out;
}

/** Load items by key. Keys that name nothing (deleted since, or unknown) are left out. */
export async function loadItems(
  config: CmsConfig,
  keys: string[],
  hasAvif: (uuid: string) => Promise<boolean>,
  opts: ExportOptions = {}
): Promise<LoadedItem[]> {
  const tables: LoadedItem[] = [];
  for (const family of TABLE_FAMILIES) {
    const wanted = keys.filter((k) => groupOfItem(k) === family);
    if (!wanted.length) continue;
    for (const row of await loadTableRows(family, wanted, opts)) {
      tables.push({
        key: row.key,
        group: family,
        label: row.label,
        sid: row.sid,
        record: row.record,
        refs: row.deps,
      });
    }
  }
  return [
    ...(await loadMedia(keys, hasAvif)),
    ...(await loadSettings(config, keys)),
    ...tables,
    ...(await loadDocs(config, keys)),
  ];
}

/** The groups this site can export, in write order. Collections of a switched-off module are left out. */
export async function exportableGroups(config: CmsConfig): Promise<GroupKey[]> {
  const flags = await resolveModuleFlags(config);
  return allGroupKeys(config.collections).filter((group) => {
    if (!group.startsWith('documents:')) {
      const owner = groupDef(group).module;
      return !owner || flags[owner] === true;
    }
    return collectionAvailable(config.collectionByKey.get(group.slice('documents:'.length)), flags);
  });
}

/** Every item key of a group — for "export all". */
export async function allKeysOf(config: CmsConfig, group: GroupKey): Promise<string[]> {
  const db = getDb();
  if (group === 'media') {
    const rows = await db.select({ uuid: schema.mediaFiles.uuid }).from(schema.mediaFiles);
    return rows.map((r) => itemKey.media(r.uuid));
  }
  if (isTableFamily(group)) return (await TABLE_ADAPTERS[group].list()).map((r) => r.key);
  if (group === 'settings') {
    const keys = managedKeys(config).filter(isExportableSetting);
    const out: string[] = [];
    for (const key of keys)
      if ((await getSettingUncached(key)) !== null) out.push(itemKey.setting(key));
    return out;
  }
  const type = group.slice('documents:'.length);
  const rows = await db
    .select({ id: schema.documents.id, translationGroupId: schema.documents.translationGroupId })
    .from(schema.documents)
    .where(eq(schema.documents.type, type));
  return [...new Set(rows.map((r) => itemKey.doc(type, docGroupKey(r))))];
}

export interface ExportSelection {
  groups: Record<string, 'all' | string[]>;
  optOut: string[];
  options?: ExportOptions & {
    /** Confirms the exporter knows the package will hold personal data (required when it does). */
    acknowledgePii?: boolean;
  };
}

export interface ExportPreview {
  keys: string[];
  required: Record<string, string[]>;
  external: Record<string, string[]>;
  labels: Record<string, string>;
  counts: Record<string, number>;
}

/**
 * The selection plus everything it depends on, loaded breadth-first. A
 * dependency in a group the user may not export is not followed: it stays
 * behind as a stub, like one they opted out of.
 */
export async function exportClosure(
  config: CmsConfig,
  perms: readonly string[],
  selection: ExportSelection,
  hasAvif: (uuid: string) => Promise<boolean>
): Promise<ExportPreview & { items: Map<string, LoadedItem> }> {
  const available = new Set(await exportableGroups(config));
  const allowed = (key: string): boolean => {
    const group = groupOfItem(key);
    return group !== null && available.has(group) && canExportGroup(perms, group);
  };

  const selected: string[] = [];
  for (const [group, choice] of Object.entries(selection.groups)) {
    if (!available.has(group as GroupKey) || !canExportGroup(perms, group as GroupKey)) continue;
    const keys = choice === 'all' ? await allKeysOf(config, group as GroupKey) : choice;
    selected.push(...keys.filter((k) => groupOfItem(k) === group));
  }

  const optOut = new Set(selection.optOut);
  const items = new Map<string, LoadedItem>();
  // Every key asked for once, found or not — a key that loads nothing (deleted since) must not loop.
  const tried = new Set<string>();
  let frontier = [...new Set(selected)];
  while (frontier.length > 0) {
    const batch = frontier.filter((k) => !tried.has(k) && allowed(k));
    for (const k of batch) tried.add(k);
    const loaded = batch.length ? await loadItems(config, batch, hasAvif, selection.options) : [];
    const next = new Set<string>();
    for (const item of loaded) {
      items.set(item.key, item);
      for (const ref of item.refs) {
        if (!tried.has(ref.key) && !optOut.has(ref.key) && allowed(ref.key)) next.add(ref.key);
      }
    }
    frontier = [...next];
  }

  const graph = new Map(
    [...items.values()].map((i) => [i.key, [...new Set(i.refs.map((r) => r.key))]])
  );
  const result = closure(graph, new Set(items.keys()), selected, optOut);
  const keys = [...result.included];
  const counts: Record<string, number> = {};
  const labels: Record<string, string> = {};
  for (const key of keys) {
    const item = items.get(key) as LoadedItem;
    counts[item.group] = (counts[item.group] ?? 0) + 1;
    labels[key] = item.label;
  }
  for (const key of result.external.keys()) {
    for (const item of items.values()) {
      const ref = item.refs.find((r) => r.key === key);
      if (ref) {
        labels[key] = !ref.stub
          ? key.slice(key.indexOf(':') + 1)
          : ref.stub.kind === 'doc'
            ? ref.stub.doc.slug
            : ref.stub.media.uuid;
        break;
      }
    }
  }
  return {
    keys,
    required: Object.fromEntries(result.required),
    external: Object.fromEntries(result.external),
    labels,
    counts,
    items,
  };
}
