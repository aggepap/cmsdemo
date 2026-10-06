import 'server-only';

import { eq, inArray } from 'drizzle-orm';

import { getDb, schema } from '../../../db';
import { docGroupKey, itemKey, type TableFamily } from '../groups';
import type { RefResolver } from '../refs';
import type { Stubs } from '../records';
import type { BookingMaps } from './people';
import { peopleKey } from './people';
import { tableDeps, tableKey } from './rules';

/** A reference to another item; `stub` describes it when it stays behind. */
export interface TableDepTarget {
  key: string;
  stub?:
    | { kind: 'doc'; doc: Stubs['documents'][number] }
    | { kind: 'media'; media: Stubs['media'][number] };
}

export interface TableRow {
  key: string;
  label: string;
  meta?: string | null;
  sid: number | string;
  record: Record<string, unknown>;
  deps: TableDepTarget[];
}

export interface TableWriteResult {
  outcome: 'created' | 'updated' | 'copied' | 'merged' | 'skipped';
  message?: string;
  dropped?: number;
}

export interface ExportOptions {
  /** Include password hashes of admin users and customers (needs `transferUsers`). */
  includePasswordHashes?: boolean;
}

export interface TableWriteCtx {
  resolver: RefResolver;
  userId: number;
  /** The importing user's permissions — nobody grants what they do not hold. */
  perms: readonly string[];
  /** Write password hashes the package carries (needs `transferUsers`). */
  importPasswordHashes: boolean;
  /** The source site, recorded on imported orders and reservations. */
  origin: string;
  /** Translation groups, documents and booking options, source → this site. */
  booking: BookingMaps;
}

export interface TableAdapter {
  family: TableFamily;
  /** Every row, for "export all" and the picker. */
  list(opts?: ExportOptions): Promise<TableRow[]>;
  /** A row on THIS site with the same natural key, for the conflict table. */
  match(record: Record<string, unknown>): Promise<{ id: number; label: string } | null>;
  write(
    record: Record<string, unknown>,
    action: 'create' | 'overwrite' | 'copy' | 'merge',
    ctx: TableWriteCtx
  ): Promise<TableWriteResult>;
  /** Purge whatever the public site caches for this table. */
  revalidate(): void;
}

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function mediaStubs(uuids: string[]): Promise<Map<string, TableDepTarget>> {
  if (!uuids.length) return new Map();
  const rows = await getDb()
    .select()
    .from(schema.mediaFiles)
    .where(inArray(schema.mediaFiles.uuid, uuids));
  return new Map(
    rows.map((m) => [
      m.uuid,
      {
        key: itemKey.media(m.uuid),
        stub: { kind: 'media', media: { uuid: m.uuid, hash: m.hash } },
      },
    ])
  );
}

/** Dependencies of a record, with stubs for documents and media. */
export async function depsOf(
  family: TableFamily,
  record: Record<string, unknown>
): Promise<TableDepTarget[]> {
  const deps = tableDeps(family, record);
  const out: TableDepTarget[] = [];
  const media = await mediaStubs(deps.flatMap((d) => (d.kind === 'media' ? [d.value] : [])));
  for (const d of deps) {
    if (d.kind === 'cookie') out.push({ key: tableKey.cookie(d.value) });
    else if (d.kind === 'customer') out.push({ key: peopleKey.customer(d.value) });
    else if (d.kind === 'zone') out.push({ key: tableKey.zone(d.value) });
    else if (d.kind === 'role') out.push({ key: peopleKey.role(d.value) });
    else if (d.kind === 'media') {
      const hit = media.get(d.value);
      if (hit) out.push(hit);
    } else {
      const [doc] = await getDb()
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.id, d.value))
        .limit(1);
      if (doc) {
        out.push({
          key: itemKey.doc(doc.type, docGroupKey(doc)),
          stub: {
            kind: 'doc',
            doc: {
              sid: doc.id,
              type: doc.type,
              slug: doc.slug,
              locale: doc.locale,
              translationGroupId: doc.translationGroupId,
            },
          },
        });
      }
    }
  }
  return out;
}
