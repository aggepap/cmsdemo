import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import type { CmsConfig } from '../../../config';
import versionFile from '../../../version.json';
import { getAllCustomFields } from '../../fields/resolve';
import { getStorage } from '../../media/storage';
import { avifKey } from '../../media/variants';
import { siteOrigin } from '../../paths';
import { resolveModuleFlags } from '../../settings';
import {
  FORMAT_VERSION,
  TRANSFER_FORMAT,
  type ManifestFile,
  type TransferManifest,
} from '../format';
import { groupDef, itemRank } from '../groups';
import type { ExportOptions } from '../tables/shared';
import type { MediaRecord, Stubs } from '../records';
import { getStaging, TRANSFER_LIMITS } from '../runtime';
import { ZipFileWriter, type ZipWriterState } from '../zip-file';
import { loadItems, type ExportSelection, type LoadedItem } from './collect';

export const EXPORT_FILE = 'export.zip';
const KEYS = 'keys.json';
const STATE = 'state.json';
/** A step request that stopped hearing from itself for this long is presumed dead. */
const STEP_LOCK_STALE_MS = 120_000;
/** Items loaded per round-trip to the database. */
const BATCH = 50;

export interface ExportState {
  phase: 'building' | 'done' | 'failed';
  cursor: number;
  total: number;
  writer: ZipWriterState | null;
  files: ManifestFile[];
  shards: Record<string, number>;
  stubs: {
    documents: Record<string, Stubs['documents'][number]>;
    media: Record<string, Stubs['media'][number]>;
  };
  counts: Record<string, number>;
  media: { count: number; bytes: number };
  /** Items left out, and why — shown when the package is ready. */
  warnings: string[];
  options: ExportOptions;
  containsPii: boolean;
  containsPasswordHashes: boolean;
  error?: string;
}

export interface ExportProgress {
  id: string;
  phase: ExportState['phase'];
  done: number;
  total: number;
  warnings: string[];
  error?: string;
}

const progress = (id: string, s: ExportState): ExportProgress => ({
  id,
  phase: s.phase,
  done: s.cursor,
  total: s.total,
  warnings: s.warnings ?? [],
  ...(s.error ? { error: s.error } : {}),
});

/** Start a job over a confirmed key list (the closure the user reviewed). */
export async function startExport(
  userId: number,
  keys: string[],
  selection: ExportSelection
): Promise<ExportProgress> {
  const staging = getStaging();
  const ordered = [...keys].sort((a, b) => itemRank(a) - itemRank(b));
  const job = await staging.create('export', userId, { selection, total: ordered.length });
  const writer = await ZipFileWriter.create(staging.filePath(job.id, EXPORT_FILE));
  const state: ExportState = {
    phase: 'building',
    cursor: 0,
    total: ordered.length,
    writer: await writer.suspend(),
    files: [],
    shards: {},
    stubs: { documents: {}, media: {} },
    counts: {},
    media: { count: 0, bytes: 0 },
    warnings: [],
    options: { includePasswordHashes: selection.options?.includePasswordHashes === true },
    containsPii: false,
    containsPasswordHashes: false,
  };
  await staging.writeJson(job.id, KEYS, ordered);
  await staging.writeJson(job.id, STATE, state);
  return progress(job.id, state);
}

export async function exportStatus(userId: number, id: string): Promise<ExportProgress> {
  const staging = getStaging();
  await staging.meta(id, userId);
  const state = await staging.readJson<ExportState>(id, STATE);
  if (!state) throw new Error('Export state is missing.');
  return progress(id, state);
}

function shardPath(group: string, n: number): string {
  return `data/${group.replace(':', '/')}/${String(n).padStart(4, '0')}.jsonl`;
}

/** Write the next slice of the export. Call until `phase` is no longer `building`. */
export async function exportStep(
  config: CmsConfig,
  userId: number,
  id: string
): Promise<ExportProgress> {
  const staging = getStaging();
  await staging.meta(id, userId);
  // One request appends to the archive at a time; a concurrent one (a second
  // tab, a retry) only reports progress — two writers would corrupt the zip.
  const token = randomUUID();
  const stepLock = `step-${id}.lock`;
  const mine = await staging.acquireLock(token, STEP_LOCK_STALE_MS, stepLock);
  try {
    const state = await staging.readJson<ExportState>(id, STATE);
    const keys = await staging.readJson<string[]>(id, KEYS);
    if (!state || !keys) throw new Error('Export state is missing.');
    if (!mine || state.phase !== 'building' || !state.writer) return progress(id, state);
    return await buildSlice(config, id, state, state.writer, keys);
  } finally {
    if (mine) await staging.releaseLock(token, stepLock);
  }
}

async function buildSlice(
  config: CmsConfig,
  id: string,
  state: ExportState,
  writerState: ZipWriterState,
  keys: string[]
): Promise<ExportProgress> {
  const staging = getStaging();
  const included = new Set(keys);
  const writer = await ZipFileWriter.resume(staging.filePath(id, EXPORT_FILE), writerState);
  const storage = getStorage();
  const started = Date.now();

  try {
    while (state.cursor < keys.length && Date.now() - started < TRANSFER_LIMITS.stepBudgetMs) {
      const batch = keys.slice(state.cursor, state.cursor + BATCH);
      const avif = new Map<string, Buffer>();
      const options = state.options ?? {};
      const items = await loadItems(
        config,
        batch,
        async (uuid) => {
          const bytes = await storage.read(avifKey(uuid)).catch(() => null);
          if (bytes) avif.set(uuid, bytes);
          return bytes !== null;
        },
        options
      );

      const lines = new Map<string, string[]>();
      for (const item of items) {
        if (groupDef(item.group).pii) state.containsPii = true;
        if ('passwordHash' in item.record) state.containsPasswordHashes = true;
        if (item.group === 'media') {
          const record = item.record as MediaRecord;
          const added = await addMediaBytes(
            writer,
            state,
            item,
            avif.get(String(item.sid)) ?? null
          );
          if (!added) {
            // The row is there but its file is not. Leave the file out and say
            // so; as a stub, the importing site can still match it by content.
            state.warnings.push(
              `${item.label}: the file is missing on this site and was left out.`
            );
            state.stubs.media[record.uuid] = { uuid: record.uuid, hash: record.hash };
            continue;
          }
        }
        lines.set(item.group, [
          ...(lines.get(item.group) ?? []),
          JSON.stringify({ k: item.key, sid: item.sid, r: item.record }),
        ]);
        state.counts[item.group] = (state.counts[item.group] ?? 0) + 1;
        for (const ref of item.refs) addStub(state, ref, included);
      }
      for (const [group, groupLines] of lines) {
        const n = (state.shards[group] ?? 0) + 1;
        state.shards[group] = n;
        const body = Buffer.from(`${groupLines.join('\n')}\n`, 'utf8');
        const path = shardPath(group, n);
        await writer.add(path, body);
        state.files.push({
          path,
          group,
          count: groupLines.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          bytes: body.length,
        });
      }
      state.cursor += batch.length;
    }

    if (state.cursor >= keys.length) {
      const stubs: Stubs = {
        documents: Object.values(state.stubs.documents),
        media: Object.values(state.stubs.media),
      };
      await writer.add('data/stubs.json', Buffer.from(JSON.stringify(stubs)));
      await writer.add(
        'manifest.json',
        Buffer.from(JSON.stringify(await buildManifest(config, state), null, 2))
      );
      await writer.close();
      state.writer = null;
      state.phase = 'done';
    } else {
      state.writer = await writer.suspend();
    }
  } catch (err) {
    await writer.suspend().catch(() => undefined);
    state.phase = 'failed';
    state.error = err instanceof Error ? err.message : 'The export failed.';
    console.error('[cms/transfer] export step failed', err);
  }
  await staging.writeJson(id, STATE, state);
  return progress(id, state);
}

function addStub(
  state: ExportState,
  ref: LoadedItem['refs'][number],
  included: ReadonlySet<string>
): void {
  if (included.has(ref.key) || !ref.stub) return;
  if (ref.stub.kind === 'doc') state.stubs.documents[String(ref.stub.doc.sid)] = ref.stub.doc;
  else state.stubs.media[ref.stub.media.uuid] = ref.stub.media;
}

async function addMediaBytes(
  writer: ZipFileWriter,
  state: ExportState,
  item: LoadedItem,
  avif: Buffer | null
): Promise<boolean> {
  const uuid = String(item.sid);
  const bytes = await getStorage()
    .read(uuid)
    .catch(() => null);
  if (!bytes) return false;
  // Stored, not deflated: WebP/AVIF/PDF are already compressed.
  await writer.add(`media/${uuid}`, bytes, { store: true });
  if (avif) await writer.add(`media/${uuid}.avif`, avif, { store: true });
  state.media.count++;
  state.media.bytes += bytes.length + (avif?.length ?? 0);
  return true;
}

async function buildManifest(config: CmsConfig, state: ExportState): Promise<TransferManifest> {
  return {
    format: TRANSFER_FORMAT,
    formatVersion: FORMAT_VERSION,
    cmsVersion: versionFile.version,
    createdAt: new Date().toISOString(),
    source: {
      siteName: config.name,
      origin: siteOrigin(),
      defaultLocale: config.defaultLocale,
      locales: [...config.locales],
      modules: await resolveModuleFlags(config),
    },
    containsPii: state.containsPii,
    containsPasswordHashes: state.containsPasswordHashes,
    files: state.files,
    media: state.media,
    counts: state.counts,
    customFields: await getAllCustomFields(),
  };
}
