/**
 * What to do with one media file from a package.
 *
 * The type is decided by the bytes (`sniffMime`), exactly as the upload route
 * does — the package's own `mime` is attacker-supplied and was the vector for
 * stored XSS via SVG before. A file whose bytes this site already holds is
 * reused, and the source uuid is kept when free so media URLs written into
 * text keep resolving.
 */
import { sniffMime, type AllowedMime } from '../media/mime';
import { isUuid } from './refs';

export type MediaImportPlan =
  | { kind: 'reuse'; uuid: string }
  | { kind: 'store'; uuid: string; mime: AllowedMime }
  | { kind: 'reject'; reason: string };

export function planMediaImport(input: {
  sourceUuid: string;
  bytes: Buffer;
  /** The uuid of a stored file with the same sha256, if any. */
  existingByHash: string | null;
  /** Whether a row already uses `sourceUuid`. */
  sourceUuidTaken: boolean;
  newUuid: () => string;
}): MediaImportPlan {
  if (input.existingByHash) return { kind: 'reuse', uuid: input.existingByHash };
  const mime = sniffMime(input.bytes);
  if (!mime) return { kind: 'reject', reason: 'Not an allowed file type.' };
  const keep = isUuid(input.sourceUuid) && !input.sourceUuidTaken;
  return { kind: 'store', uuid: keep ? input.sourceUuid.toLowerCase() : input.newUuid(), mime };
}
