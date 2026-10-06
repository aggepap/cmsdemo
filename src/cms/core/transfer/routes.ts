import 'server-only';

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { z } from 'zod';

import type { CmsConfig } from '../../config';
import { groupPartOrder } from '../../config';
import { hasPerm, PERMISSIONS, requireApiPerm } from '../../modules/auth';
import { createRoute } from '../api/handler';
import { ok, paginated } from '../api/respond';
import { logAudit } from '../audit';
import { listDocumentGroups } from '../documents/service';
import { ApiError, badRequest, forbidden, invalidInput } from '../errors';
import { countMedia, listMedia } from '../media/service';
import { managedKeys } from '../routes/settings';
import { getSettingUncached } from '../settings';
import { slugify } from '../slug';
import {
  canExportGroup,
  groupOfItem,
  isGroupKey,
  isTableFamily,
  itemKey,
  piiProblem,
  type GroupKey,
} from './groups';
import { TABLE_ADAPTERS } from './tables/adapters';
import { allKeysOf, exportableGroups, exportClosure } from './export/collect';
import { EXPORT_FILE, exportStatus, exportStep, startExport } from './export/build';
import {
  analyzeImport,
  INDEX,
  SUMMARY,
  type ImportIndex,
  type ImportSummary,
} from './import/analyze';
import { importReport, importStep, planImport, reportCsv } from './import/run';
import { getStaging, TRANSFER_LIMITS } from './runtime';
import { isExportableSetting, settingWarning } from './settings-refs';
import { StagingError } from './staging';

/*
 * Every route needs the transfer permission for its direction; each GROUP it
 * touches is then checked against the area's own permission (see `groups.ts`),
 * so the tool never reaches data the user could not reach in the admin. Jobs
 * are owned: another user's job id answers exactly like a missing one.
 */
const exportGuard = () => requireApiPerm(PERMISSIONS.transferExport);
const importGuard = () => requireApiPerm(PERMISSIONS.transferImport);

/** Steps are called in a loop by the admin; generous, but still bounded. */
const STEP_LIMIT = { max: 600, windowMs: 60_000 };

const itemKeySchema = z.string().min(3).max(300);
const actionSchema = z.enum(['skip', 'overwrite', 'copy', 'merge']);

export const selectionSchema = z.object({
  groups: z.record(
    z.string().max(80),
    z.union([z.literal('all'), z.array(itemKeySchema).max(50_000)])
  ),
  optOut: z.array(itemKeySchema).max(50_000).default([]),
  options: z
    .object({
      includePasswordHashes: z.boolean().optional(),
      acknowledgePii: z.boolean().optional(),
    })
    .default({}),
});

/** Password hashes only for someone who may move admin accounts. */
function assertHashesAllowed(perms: readonly string[], wanted: boolean | undefined): void {
  if (wanted && !hasPerm(perms, PERMISSIONS.transferUsers)) {
    throw forbidden('Only someone who may move admin accounts can include password hashes.');
  }
}

export const planBodySchema = z.object({
  decisions: z.object({
    selection: selectionSchema,
    defaults: z.record(z.string().max(80), actionSchema).default({}),
    overrides: z.record(itemKeySchema, actionSchema).default({}),
  }),
  options: z.object({
    localeMap: z.record(z.string().max(16), z.string().max(16).nullable()),
    keepStatus: z.boolean(),
    copiesAsDrafts: z.boolean(),
    acknowledgePii: z.boolean().optional(),
    importPasswordHashes: z.boolean().optional(),
  }),
});

const NOT_FOUND = 'No such transfer.';

export function stagingToApiError(err: StagingError): ApiError {
  switch (err.code) {
    case 'offset_mismatch':
      return new ApiError('conflict', err.message, { issues: { offset: err.offset } });
    case 'closed':
      return new ApiError('conflict', err.message);
    case 'too_large':
      return new ApiError('invalid_input', err.message);
    case 'bad_path':
      return badRequest(err.message);
    default:
      // `forbidden` included: saying "not yours" would confirm the id exists.
      return new ApiError('not_found', NOT_FOUND);
  }
}

async function staged<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StagingError) throw stagingToApiError(err);
    throw err;
  }
}

function assertExportable(perms: readonly string[], group: string): GroupKey {
  if (!isGroupKey(group)) throw badRequest('Unknown group.');
  if (!canExportGroup(perms, group)) throw forbidden('You do not have permission to export this.');
  return group;
}

const catalogQuery = z.object({
  group: z.string().max(80),
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/** GET /api/cms/transfer/catalog?group=&q=&page= — what can be picked for export. */
export function transferCatalogRoute(config: CmsConfig) {
  return createRoute({
    guard: exportGuard,
    query: catalogQuery,
    handler: async ({ query, auth }) => {
      const group = assertExportable(auth.permissions, query.group);
      if (!(await exportableGroups(config)).includes(group))
        throw badRequest('This group is not available on this site.');
      const pageSize = 50;
      if (group === 'media') {
        const rows = await listMedia({
          limit: pageSize,
          offset: (query.page - 1) * pageSize,
          search: query.q,
        });
        const total = await countMedia(query.q);
        return paginated(
          rows.map((m) => ({
            key: itemKey.media(m.uuid),
            label: m.originalName,
            meta: m.mime,
            url: m.url,
          })),
          { page: query.page, pageSize, total }
        );
      }
      if (group === 'settings') {
        const term = query.q?.toLowerCase() ?? '';
        const items: Array<{ key: string; label: string; meta: string | null }> = [];
        for (const key of managedKeys(config).filter(isExportableSetting)) {
          if (term && !key.toLowerCase().includes(term)) continue;
          if ((await getSettingUncached(key)) === null) continue;
          items.push({ key: itemKey.setting(key), label: key, meta: settingWarning(key) });
        }
        return paginated(items, { page: 1, pageSize: items.length || 1, total: items.length });
      }
      if (isTableFamily(group)) {
        const term = query.q?.toLowerCase() ?? '';
        const rows = (await TABLE_ADAPTERS[group].list()).filter(
          (r) => !term || `${r.label} ${r.meta ?? ''}`.toLowerCase().includes(term)
        );
        return paginated(
          rows
            .slice((query.page - 1) * pageSize, query.page * pageSize)
            .map((r) => ({ key: r.key, label: r.label, meta: r.meta ?? null })),
          { page: query.page, pageSize, total: rows.length }
        );
      }
      const type = group.slice('documents:'.length);
      const collection = config.collectionByKey.get(type);
      const result = await listDocumentGroups(type, {
        search: query.q,
        page: query.page,
        pageSize,
        defaultLocale: config.defaultLocale,
        titlePath: collection?.titlePath,
        titleOrder: collection?.titlePath
          ? (groupPartOrder(collection.fields, collection.titlePath) ?? undefined)
          : undefined,
      });
      return paginated(
        result.items.map((g) => ({
          key: itemKey.doc(type, g.translationGroupId ?? `id-${g.id}`),
          label: g.title ?? g.slug,
          meta: g.variants.map((v) => `${v.locale}:${v.status}`).join(' '),
        })),
        { page: result.page, pageSize: result.pageSize, total: result.total }
      );
    },
  });
}

/** POST /api/cms/transfer/exports/preview — the selection plus what it depends on. */
export function transferExportPreviewRoute(config: CmsConfig) {
  return createRoute({
    guard: exportGuard,
    rateLimit: { scope: 'cms-transfer-preview', max: 60, windowMs: 60_000 },
    input: z.object({ selection: selectionSchema }),
    handler: async ({ input, auth }) => {
      for (const group of Object.keys(input.selection.groups))
        assertExportable(auth.permissions, group);
      assertHashesAllowed(auth.permissions, input.selection.options.includePasswordHashes);
      const preview = await exportClosure(
        config,
        auth.permissions,
        input.selection,
        async () => false
      );
      const selected = new Set(
        (
          await Promise.all(
            Object.entries(input.selection.groups).map(async ([g, choice]) =>
              choice === 'all' ? allKeysOf(config, g as GroupKey) : choice
            )
          )
        ).flat()
      );
      return ok({
        total: preview.keys.length,
        counts: preview.counts,
        /** Set when the package would hold personal data: the UI asks for a yes before building. */
        pii: piiProblem(preview.keys, false),
        required: Object.entries(preview.required)
          .filter(([key]) => !selected.has(key))
          .map(([key, by]) => ({
            key,
            label: preview.labels[key] ?? key,
            group: groupOfItem(key),
            requiredBy: by,
          })),
        external: Object.entries(preview.external).map(([key, by]) => ({
          key,
          label: preview.labels[key] ?? key,
          group: groupOfItem(key),
          referencedBy: by,
        })),
      });
    },
  });
}

/** POST /api/cms/transfer/exports — start building. */
export function transferExportCreateRoute(config: CmsConfig) {
  return createRoute({
    guard: exportGuard,
    rateLimit: { scope: 'cms-transfer-export', max: 20, windowMs: 60_000 },
    input: z.object({ selection: selectionSchema }),
    handler: async ({ input, auth }) => {
      for (const group of Object.keys(input.selection.groups))
        assertExportable(auth.permissions, group);
      const preview = await exportClosure(
        config,
        auth.permissions,
        input.selection,
        async () => false
      );
      if (preview.keys.length === 0)
        throw badRequest('Nothing to export: select at least one item.');
      assertHashesAllowed(auth.permissions, input.selection.options.includePasswordHashes);
      const pii = piiProblem(preview.keys, input.selection.options.acknowledgePii === true);
      if (pii) throw invalidInput({ formErrors: [pii] }, pii);
      return ok(await staged(() => startExport(auth.userId, preview.keys, input.selection)));
    },
  });
}

/** GET /api/cms/transfer/exports/:id — progress. */
export function transferExportStatusRoute() {
  return createRoute({
    guard: exportGuard,
    handler: async ({ params, auth }) =>
      ok(await staged(() => exportStatus(auth.userId, params.id))),
  });
}

/** DELETE /api/cms/transfer/exports/:id */
export function transferExportDeleteRoute() {
  return createRoute({
    guard: exportGuard,
    handler: async ({ params, auth }) => {
      await staged(() => getStaging().remove(params.id, auth.userId));
      return ok({ ok: true });
    },
  });
}

/** POST /api/cms/transfer/exports/:id/step — build the next slice. */
export function transferExportStepRoute(config: CmsConfig) {
  return createRoute({
    guard: exportGuard,
    rateLimit: { scope: 'cms-transfer-export-step', ...STEP_LIMIT },
    handler: async ({ params, auth }) =>
      ok(await staged(() => exportStep(config, auth.userId, params.id))),
  });
}

/** GET /api/cms/transfer/exports/:id/download */
export function transferExportDownloadRoute(config: CmsConfig) {
  return createRoute({
    guard: exportGuard,
    handler: async ({ params, auth }) => {
      const status = await staged(() => exportStatus(auth.userId, params.id));
      if (status.phase !== 'done')
        throw new ApiError('conflict', 'The export is not finished yet.');
      const path = getStaging().filePath(params.id, EXPORT_FILE);
      const { size } = await stat(path);
      const meta = await staged(() => getStaging().meta(params.id, auth.userId));
      await logAudit({
        userId: auth.userId,
        action: 'transfer.export',
        subjectType: 'transfer',
        subjectId: params.id,
        after: { selection: meta.info.selection, items: status.total, bytes: size },
      });
      const name = `${slugify(config.name) || 'site'}-export-${new Date().toISOString().slice(0, 10)}.zip`;
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': String(size),
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        },
      });
    },
  });
}

/** GET /api/cms/transfer/jobs — this user's recent imports, to reopen one after a reload. */
export function transferJobsRoute() {
  return createRoute({
    guard: importGuard,
    handler: async ({ auth }) => {
      const jobs = (await getStaging().list(auth.userId)).filter((j) => j.kind === 'import');
      return ok(
        jobs.map((j) => ({
          id: j.id,
          kind: j.kind,
          createdAt: j.createdAt,
          info: { phase: j.info.phase ?? null, filename: j.info.filename ?? null },
        }))
      );
    },
  });
}

/** POST /api/cms/transfer/imports — open an upload. */
export function transferImportCreateRoute() {
  return createRoute({
    guard: importGuard,
    rateLimit: { scope: 'cms-transfer-import', max: 20, windowMs: 60_000 },
    input: z.object({
      filename: z.string().min(1).max(255),
      size: z.number().int().positive(),
    }),
    handler: async ({ input, auth }) => {
      const job = await staged(() =>
        getStaging().create('import', auth.userId, {
          filename: input.filename,
          size: input.size,
          phase: 'uploading',
        })
      );
      return ok({ id: job.id, chunkSize: TRANSFER_LIMITS.chunkBytes, offset: 0 });
    },
  });
}

/** GET /api/cms/transfer/imports/:id — where an import stands, to resume after a reload. */
export function transferImportGetRoute() {
  return createRoute({
    guard: importGuard,
    handler: async ({ params, auth }) => {
      const staging = getStaging();
      const meta = await staged(() => staging.meta(params.id, auth.userId));
      const offset = await staging.uploadSize(params.id);
      const summary = await staging.readJson<ImportSummary>(params.id, SUMMARY);
      const report = await importReport(auth.userId, params.id).catch(() => null);
      return ok({
        id: meta.id,
        info: meta.info,
        offset,
        summary,
        progress: report?.progress ?? null,
      });
    },
  });
}

/** DELETE /api/cms/transfer/imports/:id — discard the upload and everything derived from it. */
export function transferImportDeleteRoute() {
  return createRoute({
    guard: importGuard,
    handler: async ({ params, auth }) => {
      const staging = getStaging();
      await staged(() => staging.meta(params.id, auth.userId));
      const report = await importReport(auth.userId, params.id).catch(() => null);
      if (report?.progress.phase === 'running' || report?.progress.phase === 'patching') {
        throw new ApiError('conflict', 'This import is running. Cancel it first.');
      }
      await staged(() => staging.remove(params.id, auth.userId));
      return ok({ ok: true });
    },
  });
}

/** POST /api/cms/transfer/imports/:id/complete — the upload is whole: check and analyse it. */
export function transferImportCompleteRoute(config: CmsConfig) {
  return createRoute({
    guard: importGuard,
    rateLimit: { scope: 'cms-transfer-analyze', max: 20, windowMs: 60_000 },
    handler: async ({ params, auth }) => {
      const staging = getStaging();
      const meta = await staged(() => staging.meta(params.id, auth.userId));
      const size = await staging.uploadSize(params.id);
      if (size !== meta.info.size) throw badRequest('The upload is incomplete.');
      return ok(await staged(() => analyzeImport(config, auth.userId, params.id)));
    },
  });
}

const itemsQuery = z.object({
  group: z.string().max(80),
  filter: z.enum(['all', 'conflicts', 'invalid']).default('all'),
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/** GET /api/cms/transfer/imports/:id/items — one group of the package, for the picker and the conflict table. */
export function transferImportItemsRoute() {
  return createRoute({
    guard: importGuard,
    query: itemsQuery,
    handler: async ({ params, query, auth }) => {
      await staged(() => getStaging().meta(params.id, auth.userId));
      const index = await getStaging().readJson<ImportIndex>(params.id, INDEX);
      if (!index) throw badRequest('Analyse the package first.');
      const term = query.q?.toLowerCase() ?? '';
      const items = index.items.filter(
        (i) =>
          groupOfItem(i.key) === query.group &&
          (query.filter === 'all' ||
            (query.filter === 'conflicts'
              ? !i.invalid && i.state !== 'new'
              : Boolean(i.invalid))) &&
          (!term || i.label.toLowerCase().includes(term))
      );
      const pageSize = 50;
      return paginated(items.slice((query.page - 1) * pageSize, query.page * pageSize), {
        page: query.page,
        pageSize,
        total: items.length,
      });
    },
  });
}

/** POST /api/cms/transfer/imports/:id/plan — the dry run. */
export function transferImportPlanRoute(config: CmsConfig) {
  return createRoute({
    guard: importGuard,
    rateLimit: { scope: 'cms-transfer-plan', max: 60, windowMs: 60_000 },
    input: planBodySchema,
    handler: async ({ params, input, auth }) =>
      ok(await staged(() => planImport(config, auth, params.id, input.decisions, input.options))),
  });
}

/** POST /api/cms/transfer/imports/:id/step — run the next slice, or `{ cancel: true }`. */
export function transferImportStepRoute(config: CmsConfig) {
  return createRoute({
    guard: importGuard,
    rateLimit: { scope: 'cms-transfer-import-step', ...STEP_LIMIT },
    input: z.object({ cancel: z.boolean().optional() }),
    handler: async ({ params, input, auth }) =>
      ok(await staged(() => importStep(config, auth, params.id, input))),
  });
}

/** GET /api/cms/transfer/imports/:id/report?format=json|csv */
export function transferImportReportRoute() {
  return createRoute({
    guard: importGuard,
    query: z.object({ format: z.enum(['json', 'csv']).default('json') }),
    handler: async ({ params, query, auth }) => {
      const report = await staged(() => importReport(auth.userId, params.id));
      if (query.format === 'json') return ok(report);
      return new Response(reportCsv(report.rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="import-report-${params.id.slice(0, 8)}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    },
  });
}
