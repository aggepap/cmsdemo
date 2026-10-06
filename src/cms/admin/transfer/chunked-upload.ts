/**
 * Uploading an import package in pieces.
 *
 * A package can be far larger than one request may carry, so it is sent as
 * consecutive byte ranges. The server keeps the offset: after a dropped
 * connection or a reload, the upload continues from where the server says it
 * got to — a range it already has is simply sent again and overwrites itself.
 */
export interface ChunkRange {
  offset: number;
  end: number;
}

export function planChunks(size: number, chunkSize: number, from: number): ChunkRange[] {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error('Invalid chunk size.');
  const out: ChunkRange[] = [];
  for (let offset = Math.max(0, from); offset < size; offset += chunkSize) {
    out.push({ offset, end: Math.min(size, offset + chunkSize) });
  }
  return out;
}

export class UploadError extends Error {}

/** Send `file` from `from` onwards. Resolves when the server holds all of it. */
export async function uploadInChunks(opts: {
  file: Blob;
  id: string;
  chunkSize: number;
  from: number;
  onProgress: (sent: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  let from = opts.from;
  // A 409 moves the offset; the loop replans from the server's number rather than trusting ours.
  for (let attempts = 0; attempts < 5 && from < opts.file.size; attempts++) {
    let resumed = false;
    for (const range of planChunks(opts.file.size, opts.chunkSize, from)) {
      const res = await fetch(`/api/cms/transfer/imports/${opts.id}/chunk?offset=${range.offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: opts.file.slice(range.offset, range.end),
        signal: opts.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; data: { offset: number } }
        | { ok: false; message?: string; issues?: { offset?: number } }
        | null;
      if (res.status === 409 && body && !body.ok && typeof body.issues?.offset === 'number') {
        from = body.issues.offset;
        resumed = true;
        break;
      }
      if (!res.ok || !body || !body.ok) {
        throw new UploadError((body && !body.ok && body.message) || 'The upload failed.');
      }
      from = body.data.offset;
      opts.onProgress(from);
    }
    if (!resumed) return;
  }
  if (from < opts.file.size) throw new UploadError('The upload could not be completed.');
}
