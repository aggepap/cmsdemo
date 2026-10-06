/**
 * The export package format.
 *
 * ```
 * manifest.json            what is inside, and a checksum for every data file
 * data/<group>/<n>.jsonl   one record per line: { k: naturalKey, sid: sourceId, r: record }
 * data/stubs.json          entities referenced but not included (mapped by natural key on import)
 * media/<uuid>[.avif]      stored file bytes
 * ```
 *
 * Everything read from a package is validated here before anything else looks
 * at it: a package is a user upload.
 */
import { z } from 'zod';

export const TRANSFER_FORMAT = 'cms-transfer';
/** Bump on a change an older importer would misread. */
export const FORMAT_VERSION = 1;

const DATA_PATH = /^data\/[a-z0-9_:-]+(?:\/[a-z0-9_-]+)*\/\d{4}\.jsonl$/i;
const GROUP_KEY = /^[a-z][a-zA-Z0-9_]*(?::[a-zA-Z0-9_.-]+)?$/;

export const manifestFileSchema = z.object({
  path: z.string().max(256).regex(DATA_PATH),
  group: z.string().max(128).regex(GROUP_KEY),
  count: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});

export const manifestSchema = z.object({
  format: z.literal(TRANSFER_FORMAT),
  formatVersion: z.number().int().positive(),
  cmsVersion: z.string().max(32),
  createdAt: z.string().max(40),
  source: z.object({
    siteName: z.string().max(191),
    origin: z.string().max(512),
    defaultLocale: z.string().max(16),
    locales: z.array(z.string().max(16)).max(32),
    modules: z.record(z.string(), z.boolean()),
  }),
  containsPii: z.boolean(),
  containsPasswordHashes: z.boolean(),
  files: z.array(manifestFileSchema).max(20_000),
  media: z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** The source's `cms.customFields`, always included: it is needed to read `data.custom`. */
  customFields: z.record(z.string(), z.unknown()),
});

export type TransferManifest = z.infer<typeof manifestSchema>;
export type ManifestFile = z.infer<typeof manifestFileSchema>;

/** One JSONL line. `r` is validated per group by its writer. */
export const recordLineSchema = z.object({
  k: z.string().min(1).max(512),
  sid: z.union([z.number().int(), z.string().max(191)]),
  r: z.record(z.string(), z.unknown()),
});
export type RecordLine = z.infer<typeof recordLineSchema>;

export interface Compatibility {
  /** The import cannot proceed. */
  blockers: string[];
  /** It can, but the user should know. */
  warnings: string[];
}

export function checkCompatibility(
  manifest: TransferManifest,
  target: { cmsVersion: string; locales: readonly string[] }
): Compatibility {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (manifest.formatVersion > FORMAT_VERSION) {
    blockers.push(
      `This package was made by a newer CMS (format ${manifest.formatVersion}); this site reads up to format ${FORMAT_VERSION}. Update this site first.`
    );
  }
  if (manifest.cmsVersion !== target.cmsVersion) {
    warnings.push(
      `The package comes from CMS ${manifest.cmsVersion}; this site runs ${target.cmsVersion}. Fields that do not exist here are dropped.`
    );
  }
  const missing = manifest.source.locales.filter((l) => !target.locales.includes(l));
  if (missing.length > 0) {
    warnings.push(
      `Languages this site does not have: ${missing.join(', ')}. Choose where they go, or drop them.`
    );
  }
  return { blockers, warnings };
}
