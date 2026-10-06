/**
 * The status and publishing dates an imported document is written with.
 *
 * Same rule as the editor (`documents/publish-rights.ts`): putting content live
 * — by status OR by a publish/schedule date — and taking it down are one
 * privilege. Without it (or without "keep status"), a new document arrives as a
 * draft with no publishing dates, and an overwrite leaves the document's status
 * and dates exactly as they are on this site: changing its text is allowed,
 * changing whether the public sees it is not.
 */
import type { DocumentStatus } from '../../db/adapters/mysql/schema/documents';
import type { ResolvedAction } from './conflicts';

export interface PublishOptions {
  /** The importing user holds `cms.content.publish`. */
  canPublish: boolean;
  keepStatus: boolean;
  copiesAsDrafts: boolean;
}

export interface PublishFields {
  status?: DocumentStatus;
  publishedAt?: Date | null;
  scheduledFor?: Date | null;
}

const toDate = (s: string | null): Date | null => (s ? new Date(s) : null);

export function publishFieldsFor(
  opts: PublishOptions,
  action: ResolvedAction,
  mode: 'create' | 'update',
  row: { status: DocumentStatus; publishedAt: string | null; scheduledFor: string | null }
): PublishFields {
  const asDraft = action === 'copy' && opts.copiesAsDrafts;
  const mayPublish = opts.canPublish && opts.keepStatus && !asDraft;
  if (mayPublish) {
    return {
      status: row.status,
      publishedAt: toDate(row.publishedAt),
      scheduledFor: toDate(row.scheduledFor),
    };
  }
  if (mode === 'update') return {};
  return { status: 'draft', publishedAt: null, scheduledFor: null };
}
