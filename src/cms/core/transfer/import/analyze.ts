import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import type { CmsConfig } from '../../../config';
import { getDb, schema } from '../../../db';
import versionFile from '../../../version.json';
import { resolvePath } from '../../documents/service';
import { resolveCollectionWithCustomFields } from '../../fields/resolve';
import { ApiError, badRequest } from '../../errors';
import { collectionAvailable } from '../../routes/collections';
import { managedKeys } from '../../routes/settings';
import { getSettingUncached, resolveModuleFlags } from '../../settings';
import { moduleLabel } from '../../settings/schema';
import { checkCompatibility, type Compatibility } from '../format';
import { classifyDocumentGroup, type TargetMatch } from '../conflicts';
import {
  groupDef,
  isTableFamily,
  itemKey,
  parseItemKey,
  type GroupKey,
  type TableFamily,
} from '../groups';
import { TABLE_ADAPTERS } from '../tables/adapters';
import { peopleKey } from '../tables/people';
import {
  TABLE_RECORD_SCHEMAS,
  tableDeps,
  tableKey,
  tableLabel,
  tableRecordKey,
} from '../tables/rules';
import { defaultLocaleMap, mapLocale, type LocaleMap } from '../locale-map';
import {
  docRecordSchema,
  mediaRecordSchema,
  settingRecordSchema,
  type DocRecord,
} from '../records';
import { collectRefs, isUuid } from '../refs';
import { getStaging } from '../runtime';
import { collectSettingRefs, isExportableSetting, settingWarning } from '../settings-refs';
import { openPackage, readDataFile, readManifest, readStubs } from './package';
import type { ImportIndexItem } from './plan';
import { summarizeGroups, type GroupSummary } from './summary';

export type { GroupSummary };

export const INDEX = 'index.json';
/** One JSONL shard: the exporter writes 50 records per shard, far below this. */
const MAX_DATA_FILE_BYTES = 16 * 1024 * 1024;
/** All data files of one package together (media excluded). */
const MAX_DATA_BYTES = 128 * 1024 * 1024;
export const SUMMARY = 'summary.json';

/** Where an item's record is in the package. */
export interface Location {
  file: string;
  line: number;
}

/** A document row of the package or a stub, by source id — for resolving references by natural key. */
export interface SourceDocRow {
  type: string;
  slug: string;
  locale: string;
  key: string;
}

export interface ImportIndex {
  items: ImportIndexItem[];
  locations: Record<string, Location>;
  docRows: Record<string, SourceDocRow>;
  /** Source media uuid → sha256, for the package's files and the stubs. */
  mediaHashes: Record<string, string>;
  sourceLocales: string[];
}

export interface ImportSummary {
  source: {
    siteName: string;
    origin: string;
    createdAt: string;
    cmsVersion: string;
    locales: string[];
    defaultLocale: string;
  };
  containsPii: boolean;
  compatibility: Compatibility;
  localeMap: LocaleMap;
  targetLocales: string[];
  groups: GroupSummary[];
}

type Parsed =
  | { family: 'media'; key: string; loc: Location; record: import('../records').MediaRecord }
  | { family: 'settings'; key: string; loc: Location; record: import('../records').SettingRecord }
  | { family: 'documents'; key: string; loc: Location; record: DocRecord }
  | { family: TableFamily; key: string; loc: Location; record: Record<string, unknown> };

/**
 * Read and check a whole uploaded package, and describe it against THIS site:
 * what each item references, what already exists here, and what cannot be
 * imported at all. Nothing is written except the analysis itself.
 */
export async function analyzeImport(
  config: CmsConfig,
  userId: number,
  id: string
): Promise<ImportSummary> {
  const staging = getStaging();
  await staging.meta(id, userId);
  // Once planned, the analysis is what the plan and the journal point into.
  if (await staging.readJson(id, 'plan.json')) {
    throw new ApiError(
      'conflict',
      'This import is already planned. Start a new import to use another package.'
    );
  }
  const zip = await openPackage(staging.uploadPath(id));
  try {
    const manifest = await readManifest(zip);
    // Analysis holds every record in memory at once, so the data (not the media)
    // is capped well below what the zip reader alone would allow.
    let dataBytes = 0;
    for (const file of manifest.files) {
      const size = zip.entries.find((e) => e.name === file.path)?.size ?? 0;
      if (size > MAX_DATA_FILE_BYTES)
        throw badRequest(`${file.path} is too large for a package data file.`);
      dataBytes += size;
    }
    if (dataBytes > MAX_DATA_BYTES) {
      throw badRequest(
        'This package holds too much content to import at once. Export it in smaller parts.'
      );
    }
    const compatibility = checkCompatibility(manifest, {
      cmsVersion: versionFile.version,
      locales: config.locales,
    });
    const localeMap = defaultLocaleMap(manifest.source.locales, config.locales);
    const stubs = await readStubs(zip);

    const items: ImportIndexItem[] = [];
    const locations: Record<string, Location> = {};
    const parsed: Parsed[] = [];
    for (const file of manifest.files) {
      const family = groupDef(file.group as GroupKey).family;
      for (const line of await readDataFile(zip, file)) {
        const loc = { file: file.path, line: line.line };
        if (!line.record) continue;
        const key = line.record.k;
        if (locations[key]) continue; // duplicate: the first wins
        locations[key] = loc;
        const schemaFor = isTableFamily(family)
          ? TABLE_RECORD_SCHEMAS[family]
          : family === 'media'
            ? mediaRecordSchema
            : family === 'settings'
              ? settingRecordSchema
              : docRecordSchema;
        const result = schemaFor.safeParse(line.record.r);
        if (!result.success) {
          items.push({
            key,
            label: key,
            state: 'new',
            deps: [],
            invalid: result.error.issues[0]?.message ?? 'Invalid record.',
          });
          continue;
        }
        parsed.push({ family, key, loc, record: result.data } as Parsed);
      }
    }

    // Every source document row and stub, by id — references are by row id.
    const docRows: Record<string, SourceDocRow> = {};
    for (const p of parsed) {
      if (p.family !== 'documents') continue;
      for (const row of p.record.rows)
        docRows[String(row.sourceId)] = {
          type: p.record.type,
          slug: row.slug,
          locale: row.locale,
          key: p.key,
        };
    }
    for (const s of stubs.documents) {
      docRows[String(s.sid)] ??= {
        type: s.type,
        slug: s.slug,
        locale: s.locale,
        key: itemKey.doc(s.type, s.translationGroupId ?? `id-${s.sid}`),
      };
    }
    const mediaHashes: Record<string, string> = {};
    for (const p of parsed) if (p.family === 'media') mediaHashes[p.record.uuid] = p.record.hash;
    for (const s of stubs.media) mediaHashes[s.uuid] ??= s.hash;

    const depKey = (ref: { kind: string; value: number | string }): string | null => {
      if (ref.kind === 'doc') return docRows[String(ref.value)]?.key ?? null;
      if (ref.kind === 'media' && isUuid(ref.value)) return itemKey.media(ref.value);
      if (ref.kind === 'script') return tableKey.script(String(ref.value));
      if (ref.kind === 'reviewLocation') return tableKey.reviewLocation(String(ref.value));
      if (ref.kind === 'cookie') return tableKey.cookie(String(ref.value));
      if (ref.kind === 'customer') return peopleKey.customer(String(ref.value));
      if (ref.kind === 'zone') return tableKey.zone(String(ref.value));
      if (ref.kind === 'role') return peopleKey.role(String(ref.value));
      return null;
    };

    items.push(...(await describeMedia(parsed)));
    items.push(...(await describeSettings(config, parsed, depKey)));
    items.push(...(await describeTables(config, parsed, depKey)));
    items.push(...(await describeDocuments(config, parsed, depKey, localeMap)));

    const index: ImportIndex = {
      items,
      locations,
      docRows,
      mediaHashes,
      sourceLocales: manifest.source.locales,
    };
    const summary: ImportSummary = {
      source: {
        siteName: manifest.source.siteName,
        origin: manifest.source.origin,
        createdAt: manifest.createdAt,
        cmsVersion: manifest.cmsVersion,
        locales: manifest.source.locales,
        defaultLocale: manifest.source.defaultLocale,
      },
      containsPii: manifest.containsPii,
      compatibility,
      localeMap,
      targetLocales: [...config.locales],
      groups: summarizeGroups(items, {
        collections: config.collectionByKey,
        flags: await resolveModuleFlags(config),
      }),
    };
    await staging.writeJson(id, INDEX, index);
    await staging.writeJson(id, SUMMARY, summary);
    await staging.updateInfo(id, userId, { phase: 'analyzed' });
    return summary;
  } finally {
    await zip.close();
  }
}

async function describeMedia(parsed: Parsed[]): Promise<ImportIndexItem[]> {
  const media = parsed.flatMap((p) => (p.family === 'media' ? [p] : []));
  if (!media.length) return [];
  const hashes = [...new Set(media.map((m) => m.record.hash))];
  const existing = await getDb()
    .select({
      uuid: schema.mediaFiles.uuid,
      hash: schema.mediaFiles.hash,
      name: schema.mediaFiles.originalName,
    })
    .from(schema.mediaFiles)
    .where(inArray(schema.mediaFiles.hash, hashes));
  const byHash = new Map(existing.map((e) => [e.hash, e]));
  return media.map((m) => {
    const same = byHash.get(m.record.hash);
    return {
      key: m.key,
      label: m.record.originalName,
      state: 'new' as const,
      deps: [],
      // Not a conflict: identical bytes are simply reused.
      match: same ? { id: same.uuid, label: `Already here as ${same.name}` } : null,
    };
  });
}

async function describeSettings(
  config: CmsConfig,
  parsed: Parsed[],
  depKey: (ref: { kind: string; value: number | string }) => string | null
): Promise<ImportIndexItem[]> {
  const allowed = new Set(managedKeys(config).filter(isExportableSetting));
  const out: ImportIndexItem[] = [];
  for (const p of parsed) {
    if (p.family !== 'settings') continue;
    const { key, value } = p.record;
    if (p.key !== itemKey.setting(key)) {
      out.push({
        key: p.key,
        label: key,
        state: 'new',
        deps: [],
        invalid: 'The record does not match its key.',
      });
      continue;
    }
    if (!allowed.has(key)) {
      out.push({
        key: p.key,
        label: key,
        state: 'new',
        deps: [],
        invalid: 'This site has no such setting.',
      });
      continue;
    }
    const current = await getSettingUncached(key);
    const same = JSON.stringify(current) === JSON.stringify(value);
    out.push({
      key: p.key,
      label: key,
      state: current === null ? 'new' : 'conflict',
      deps: [
        ...new Set(
          collectSettingRefs(key, value)
            .map(depKey)
            .filter((k): k is string => k !== null)
        ),
      ],
      warning: settingWarning(key),
      match:
        current === null ? null : { id: key, label: same ? 'Identical here' : 'Different here' },
    });
  }
  return out;
}

async function describeDocuments(
  config: CmsConfig,
  parsed: Parsed[],
  depKey: (ref: { kind: string; value: number | string }) => string | null,
  localeMap: LocaleMap
): Promise<ImportIndexItem[]> {
  const db = getDb();
  const flags = await resolveModuleFlags(config);
  const out: ImportIndexItem[] = [];
  const docs = parsed.flatMap((p) => (p.family === 'documents' ? [p] : []));

  const byType = new Map<string, typeof docs>();
  for (const d of docs) byType.set(d.record.type, [...(byType.get(d.record.type) ?? []), d]);

  for (const [type, group] of byType) {
    const collection = config.collectionByKey.get(type);
    if (!collection || !collectionAvailable(collection, flags)) {
      for (const d of group) {
        out.push({
          key: d.key,
          label: d.record.rows[0].slug,
          state: 'new',
          deps: [],
          invalid:
            collection?.module && !collectionAvailable(collection, flags)
              ? `The ${moduleLabel(collection.module)} module is off on this site.`
              : `This site has no "${type}" content.`,
        });
      }
      continue;
    }
    const slugs = [...new Set(group.flatMap((d) => d.record.rows.map((r) => r.slug)))];
    const existing = slugs.length
      ? await db
          .select({
            id: schema.documents.id,
            slug: schema.documents.slug,
            locale: schema.documents.locale,
            groupId: schema.documents.translationGroupId,
          })
          .from(schema.documents)
          .where(and(eq(schema.documents.type, type), inArray(schema.documents.slug, slugs)))
      : [];
    const paths = new Map<string, string>();
    for (const d of group) {
      for (const row of d.record.rows) {
        const locale = mapLocale(localeMap, row.locale);
        const path =
          locale && collection.seo
            ? resolvePath(collection, row.slug, locale, config.defaultLocale)
            : null;
        if (path) paths.set(`${d.key}\u0000${row.locale}`, path);
      }
    }
    const pathRows = paths.size
      ? await db
          .select({ id: schema.documents.id, path: schema.documents.canonicalPath })
          .from(schema.documents)
          .where(inArray(schema.documents.canonicalPath, [...new Set(paths.values())]))
      : [];

    for (const d of group) {
      const p = parseItemKey(d.key);
      if (p?.family !== 'documents' || p.type !== type) {
        out.push({
          key: d.key,
          label: d.record.rows[0].slug,
          state: 'new',
          deps: [],
          invalid: 'The record does not match its key.',
        });
        continue;
      }
      const matches: TargetMatch[] = [];
      for (const row of d.record.rows) {
        const locale = mapLocale(localeMap, row.locale);
        const m = existing.find((e) => e.slug === row.slug && e.locale === locale);
        if (m) matches.push({ locale: m.locale, slug: m.slug, id: m.id, groupId: m.groupId });
      }
      const matchedIds = new Set(matches.map((m) => m.id));
      const pathTaken = d.record.rows.some((row) => {
        const path = paths.get(`${d.key}\u0000${row.locale}`);
        return path !== undefined && pathRows.some((r) => r.path === path && !matchedIds.has(r.id));
      });

      const deps = new Set<string>();
      for (const row of d.record.rows) {
        const fields = (
          await resolveCollectionWithCustomFields(config, type, {
            data: row.data,
            relaxRequired: true,
          })
        ).fields;
        for (const ref of collectRefs(fields, row.data)) {
          const k = depKey(ref);
          if (k && k !== d.key) deps.add(k);
        }
        if (row.ogImageUuid) deps.add(itemKey.media(row.ogImageUuid));
      }
      const first = d.record.rows[0];
      const title = typeof first.data.title === 'string' ? first.data.title : first.slug;
      out.push({
        key: d.key,
        label: title,
        state: classifyDocumentGroup(matches, pathTaken),
        deps: [...deps],
        match: matches.length
          ? {
              id: matches[0].id,
              label: `${matches[0].slug} (${matches.map((m) => m.locale).join(', ')})`,
            }
          : null,
      });
    }
  }
  return out;
}

async function describeTables(
  config: CmsConfig,
  parsed: Parsed[],
  depKey: (ref: { kind: string; value: number | string }) => string | null
): Promise<ImportIndexItem[]> {
  const flags = await resolveModuleFlags(config);
  const out: ImportIndexItem[] = [];
  for (const p of parsed) {
    if (!isTableFamily(p.family)) continue;
    const family = p.family;
    const record = p.record as Record<string, unknown>;
    const adapter = TABLE_ADAPTERS[family];
    const label = tableLabel(family, record);
    if (tableRecordKey(family, record) !== p.key) {
      out.push({
        key: p.key,
        label,
        state: 'new',
        deps: [],
        invalid: 'The record does not match its key.',
      });
      continue;
    }
    const owner = groupDef(family).module;
    if (owner && flags[owner] !== true) {
      out.push({
        key: p.key,
        label,
        state: 'new',
        deps: [],
        invalid: `The ${moduleLabel(owner)} module is off on this site.`,
      });
      continue;
    }
    const match = await adapter.match(record);
    out.push({
      key: p.key,
      label,
      state: match ? 'conflict' : 'new',
      deps: [
        ...new Set(
          tableDeps(family, record)
            .map(depKey)
            .filter((k): k is string => k !== null)
        ),
      ],
      match,
    });
  }
  return out;
}
