/**
 * The shape of each kind of record in a package, with the database's own
 * column limits. A record failing here is reported as invalid and never
 * imported; nothing downstream has to wonder whether a slug fits its column.
 */
import { z } from 'zod';

import { documentStatusValues } from '../../db/adapters/mysql/schema/documents';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.iso.datetime({ offset: true }).nullable();
const locale = z.string().min(1).max(8);

export const docRowSchema = z.object({
  sourceId: z.number().int().positive(),
  slug: z.string().min(1).max(191),
  locale,
  status: z.enum(documentStatusValues),
  publishedAt: isoDate,
  scheduledFor: isoDate,
  modifiedAt: isoDate,
  metaTitle: z.string().max(255).nullable(),
  metaDescription: z.string().max(320).nullable(),
  noindex: z.boolean(),
  nofollow: z.boolean(),
  includeInSitemap: z.boolean(),
  ogImageUuid: uuid.nullable(),
  data: z.record(z.string(), z.unknown()),
});

export const docRecordSchema = z
  .object({
    type: z.string().min(1).max(64),
    translationGroupId: z.string().max(36).nullable(),
    rows: z.array(docRowSchema).min(1).max(32),
  })
  .refine((r) => new Set(r.rows.map((row) => row.locale)).size === r.rows.length, {
    message: 'Two rows of one document share a language.',
    path: ['rows'],
  });

export const mediaRecordSchema = z.object({
  uuid,
  hash: sha256,
  originalName: z.string().max(255),
  altText: z.string().max(512).nullable(),
  /** Folder names from the root, so the folder tree can be rebuilt by name. */
  folderPath: z.array(z.string().min(1).max(191)).max(20).nullable(),
  hasAvif: z.boolean(),
});

export const settingRecordSchema = z.object({
  key: z.string().min(1).max(191),
  value: z.unknown(),
});

export const stubsSchema = z.object({
  documents: z.array(
    z.object({
      sid: z.number().int().positive(),
      type: z.string().min(1).max(64),
      slug: z.string().min(1).max(191),
      locale,
      translationGroupId: z.string().max(36).nullable(),
    })
  ),
  media: z.array(z.object({ uuid, hash: sha256 })),
});

export type DocRow = z.infer<typeof docRowSchema>;
export type DocRecord = z.infer<typeof docRecordSchema>;
export type MediaRecord = z.infer<typeof mediaRecordSchema>;
export type SettingRecord = z.infer<typeof settingRecordSchema>;
export type Stubs = z.infer<typeof stubsSchema>;

/**
 * Whether a record is the item its key names. Analysis refuses a mismatch; the
 * run checks again rather than trusting the file it re-reads.
 */
export function recordMatchesKey(
  key: string,
  record: { type?: unknown; key?: unknown; uuid?: unknown }
): boolean {
  if (key.startsWith('doc:'))
    return typeof record.type === 'string' && key.startsWith(`doc:${record.type}:`);
  if (key.startsWith('setting:')) return key === `setting:${String(record.key)}`;
  if (key.startsWith('media:')) return key === `media:${String(record.uuid)}`;
  return false;
}
