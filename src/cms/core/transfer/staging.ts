/**
 * The working directory of one export or import job.
 *
 * There is no queue, so a transfer is a series of short requests over a folder
 * on disk: the uploaded package arrives in chunks, analysis and plan are written
 * next to it, and the import journal records how far the run got. Everything is
 * keyed by a server-minted uuid and checked against its owner, and nothing
 * outside the job's own folder is reachable by name.
 *
 * Staging holds whatever the package holds — possibly customer data — so jobs
 * expire (see `cleanupExpired`, run by the `transfer-cleanup` cron job).
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export type JobKind = 'import' | 'export';

export interface JobMeta {
  id: string;
  kind: JobKind;
  ownerId: number;
  createdAt: string;
  /** Kind-specific: `{ filename, size }` for an upload; progress for an export. */
  info: Record<string, unknown>;
}

export type StagingErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'offset_mismatch'
  | 'too_large'
  | 'bad_path'
  /** The upload was analysed: what the plan points into must not change under it. */
  | 'closed';

export class StagingError extends Error {
  constructor(
    readonly code: StagingErrorCode,
    message: string,
    /** For `offset_mismatch`: where the client should resume. */
    readonly offset?: number
  ) {
    super(message);
    this.name = 'StagingError';
  }
}

export interface StagingOptions {
  root: string;
  /** Largest accepted upload. */
  maxBytes: number;
  /** A job untouched for this long is removed by `cleanupExpired`. */
  ttlMs: number;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/;
const UPLOAD = 'upload.zip';
const META = 'meta.json';
const LOCK = 'import.lock';
const CANCEL = 'cancel.flag';
const LOCK_NAME = /^[a-z0-9-]{1,80}\.lock$/;

export function createStaging(opts: StagingOptions) {
  const root = resolve(opts.root);

  const jobDir = (id: string): string => {
    if (!ID.test(id)) throw new StagingError('not_found', 'No such transfer.');
    return join(root, id);
  };

  const filePath = (id: string, name: string): string => {
    if (!FILE_NAME.test(name) || name.includes('..'))
      throw new StagingError('bad_path', 'Invalid file name.');
    const path = resolve(jobDir(id), name);
    if (!path.startsWith(jobDir(id) + sep))
      throw new StagingError('bad_path', 'Invalid file name.');
    return path;
  };

  const lockPath = (name: string): string => {
    if (!LOCK_NAME.test(name)) throw new StagingError('bad_path', 'Invalid lock name.');
    return join(root, name);
  };

  const touch = async (id: string): Promise<void> => {
    const now = new Date();
    await utimes(filePath(id, META), now, now).catch(() => undefined);
  };

  const writeJson = async (id: string, name: string, value: unknown): Promise<void> => {
    const path = filePath(id, name);
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, path);
    if (name !== META) await touch(id);
  };

  const readJson = async <T = unknown>(id: string, name: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(filePath(id, name), 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };

  const meta = async (id: string, ownerId: number): Promise<JobMeta> => {
    const m = await readJson<JobMeta>(id, META);
    if (!m) throw new StagingError('not_found', 'No such transfer.');
    if (m.ownerId !== ownerId)
      throw new StagingError('forbidden', 'This transfer belongs to another user.');
    return m;
  };

  const fileSize = async (path: string): Promise<number> => {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  };

  return {
    root,
    filePath,
    readJson,
    writeJson,
    meta,

    async create(kind: JobKind, ownerId: number, info: Record<string, unknown>): Promise<JobMeta> {
      if (typeof info.size === 'number' && info.size > opts.maxBytes) {
        throw new StagingError(
          'too_large',
          `The package is too large (limit ${Math.floor(opts.maxBytes / 1024 / 1024)} MB).`
        );
      }
      const id = randomUUID();
      await mkdir(jobDir(id), { recursive: true, mode: 0o700 });
      const m: JobMeta = { id, kind, ownerId, createdAt: new Date().toISOString(), info };
      await writeJson(id, META, m);
      return m;
    },

    async updateInfo(
      id: string,
      ownerId: number,
      patch: Record<string, unknown>
    ): Promise<JobMeta> {
      const m = await meta(id, ownerId);
      const next = { ...m, info: { ...m.info, ...patch } };
      await writeJson(id, META, next);
      return next;
    },

    /**
     * Write `chunk` at `offset` of the upload and return the new size.
     * An offset behind the current size is a retry: the tail is replaced. One
     * ahead of it would leave a hole — refused with the offset to resume from.
     */
    async appendChunk(id: string, ownerId: number, offset: number, chunk: Buffer): Promise<number> {
      const m = await meta(id, ownerId);
      if (m.info.phase !== undefined && m.info.phase !== 'uploading') {
        throw new StagingError(
          'closed',
          'This package has already been checked; start a new import to upload another.'
        );
      }
      const declared = typeof m.info.size === 'number' ? m.info.size : opts.maxBytes;
      if (offset + chunk.length > declared || offset + chunk.length > opts.maxBytes) {
        throw new StagingError('too_large', 'The chunk goes past the declared size of the upload.');
      }
      const path = filePath(id, UPLOAD);
      const current = await fileSize(path);
      if (offset > current)
        throw new StagingError('offset_mismatch', 'Upload out of order.', current);
      const fh = await open(path, current === 0 ? 'w' : 'r+');
      try {
        if (offset < current) await truncate(path, offset);
        await fh.write(chunk, 0, chunk.length, offset);
      } finally {
        await fh.close();
      }
      await touch(id);
      return offset + chunk.length;
    },

    uploadSize: (id: string) => fileSize(filePath(id, UPLOAD)),
    uploadPath: (id: string) => filePath(id, UPLOAD),

    async list(ownerId: number): Promise<JobMeta[]> {
      const names = await readdir(root).catch(() => [] as string[]);
      const out: JobMeta[] = [];
      for (const name of names) {
        if (!ID.test(name)) continue;
        const m = await readJson<JobMeta>(name, META).catch(() => null);
        if (m && m.ownerId === ownerId) out.push(m);
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async remove(id: string, ownerId: number): Promise<void> {
      await meta(id, ownerId);
      await rm(jobDir(id), { recursive: true, force: true });
    },

    /**
     * A lock file in the staging root, held by `owner`.
     *
     * `import.lock` (the default) lets one import run at a time, site-wide: two
     * imports interleaving their writes would each plan against a target the
     * other is changing. `step-<id>.lock` lets one request at a time work on a
     * job, so a second tab cannot step the same job and write over its journal.
     * A lock not refreshed for `staleMs` belongs to a request that died and is
     * taken over; re-acquiring as the holder refreshes it.
     */
    async acquireLock(owner: string, staleMs: number, name: string = LOCK): Promise<boolean> {
      const path = lockPath(name);
      await mkdir(root, { recursive: true, mode: 0o700 });
      try {
        await writeFile(path, owner, { flag: 'wx' });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const holder = await readFile(path, 'utf8').catch(() => '');
      const age =
        Date.now() -
        (await stat(path)
          .then((s) => s.mtimeMs)
          .catch(() => 0));
      if (holder === owner || age > staleMs) {
        await writeFile(path, owner);
        return true;
      }
      return false;
    },

    async releaseLock(owner: string, name: string = LOCK): Promise<void> {
      const path = lockPath(name);
      const holder = await readFile(path, 'utf8').catch(() => null);
      if (holder === owner) await rm(path, { force: true });
    },

    /**
     * Ask a running import to stop. A flag rather than a journal write: the
     * request running the import holds the journal in memory and would write
     * its own copy back over a "cancelled" written by someone else.
     */
    async requestCancel(id: string, ownerId: number): Promise<void> {
      await meta(id, ownerId);
      await writeFile(filePath(id, CANCEL), new Date().toISOString());
    },

    async isCancelRequested(id: string): Promise<boolean> {
      return stat(filePath(id, CANCEL))
        .then(() => true)
        .catch(() => false);
    },

    /** Remove every job untouched for longer than the TTL. Returns how many. */
    async cleanupExpired(now: number): Promise<number> {
      const names = await readdir(root).catch(() => [] as string[]);
      let removed = 0;
      for (const name of names) {
        if (!ID.test(name)) continue;
        const touched = await stat(join(root, name, META))
          .then((s) => s.mtimeMs)
          .catch(() => 0);
        if (now - touched > opts.ttlMs) {
          await rm(join(root, name), { recursive: true, force: true });
          removed++;
        }
      }
      return removed;
    },
  };
}

export type Staging = ReturnType<typeof createStaging>;
