/**
 * A ZIP reader and writer that work on a FILE, one entry at a time.
 *
 * `update/zip.mjs` holds the whole archive in memory, which is right for an
 * update package and wrong for an export with hundreds of megabytes of media.
 * Same format subset — deflate or store, UTF-8 names, no encryption, no ZIP64 —
 * and the same checksum and path rule, reused from there.
 *
 * An import package is a user upload, so the reader refuses before it spends:
 * unsafe names, duplicate names, too many entries, a declared total that is too
 * large, and a compression ratio no real package has are all rejected when the
 * archive is opened; an entry is only inflated with a hard output cap.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { assertSafePath, crc32 } from '../../update/zip.mjs';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES_FORMAT = 0xffff;
/** Below this, a high ratio is just a small repetitive file. */
const RATIO_FLOOR_BYTES = 1024 * 1024;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

export interface ZipLimits {
  maxEntries: number;
  /** Largest single entry once inflated. */
  maxEntryBytes: number;
  /** Largest declared total once inflated. */
  maxTotalBytes: number;
  /** Largest uncompressed:compressed ratio for an entry over 1 MiB. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 60_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024 - 1,
  maxRatio: 200,
};

function safeName(name: string): void {
  try {
    assertSafePath(name);
  } catch {
    throw new ZipLimitError(`Unsafe entry name: ${JSON.stringify(name.slice(0, 120))}`);
  }
}

/** What a writer needs to carry on in a later request. JSON-safe. */
export interface ZipWriterState {
  offset: number;
  /** Central directory records written so far, base64. */
  central: string[];
  names: string[];
}

/**
 * Appends entries to a zip file. An export is built over several requests, so
 * a writer can be `suspend`ed — its directory saved as plain data — and
 * `resume`d by the next request; only `close` writes the directory out.
 */
export class ZipFileWriter {
  private offset = 0;
  /** One central-directory record (fixed header + name) per entry. */
  private readonly central: Buffer[] = [];
  private readonly names = new Set<string>();

  private constructor(private readonly fh: FileHandle) {}

  static async create(path: string): Promise<ZipFileWriter> {
    return new ZipFileWriter(await open(path, 'w'));
  }

  static async resume(path: string, state: ZipWriterState): Promise<ZipFileWriter> {
    const writer = new ZipFileWriter(await open(path, 'r+'));
    await writer.fh.truncate(state.offset);
    writer.offset = state.offset;
    for (const record of state.central) writer.central.push(Buffer.from(record, 'base64'));
    for (const name of state.names) writer.names.add(name);
    return writer;
  }

  /** Close the file WITHOUT finishing the archive, returning what `resume` needs. */
  async suspend(): Promise<ZipWriterState> {
    await this.fh.close();
    return {
      offset: this.offset,
      central: this.central.map((r) => r.toString('base64')),
      names: [...this.names],
    };
  }

  get size(): number {
    return this.offset;
  }

  get count(): number {
    return this.names.size;
  }

  /** `store` skips compression — for media, which is already compressed. */
  async add(name: string, data: Buffer, opts: { store?: boolean } = {}): Promise<void> {
    safeName(name);
    if (this.names.has(name)) throw new ZipLimitError(`Duplicate entry: ${name}`);
    if (this.names.size >= MAX_ENTRIES_FORMAT)
      throw new ZipLimitError('Too many entries for one package.');
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = opts.store ? null : deflateRawSync(data);
    const stored = deflated === null || deflated.length >= data.length;
    const body = stored ? data : (deflated as Buffer);
    if (this.offset + 30 + nameBuf.length + body.length > MAX_U32) {
      throw new ZipLimitError('The package would exceed 4 GB. Select fewer items.');
    }
    const crc = crc32(data) as number;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(0x00210000, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(this.offset, 42);

    await this.fh.write(Buffer.concat([local, nameBuf, body]), 0, undefined, this.offset);
    this.offset += 30 + nameBuf.length + body.length;
    this.central.push(Buffer.concat([central, nameBuf]));
    this.names.add(name);
  }

  async close(): Promise<void> {
    const dir = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(this.names.size, 8);
    end.writeUInt16LE(this.names.size, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.offset, 16);
    await this.fh.write(Buffer.concat([dir, end]), 0, undefined, this.offset);
    await this.fh.close();
  }
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
}

interface EntryMeta extends ZipEntryInfo {
  method: number;
  crc: number;
  localAt: number;
}

export interface ZipReader {
  entries: ZipEntryInfo[];
  has(name: string): boolean;
  read(name: string): Promise<Buffer>;
  close(): Promise<void>;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new ZipLimitError('The archive is truncated.');
  return buf;
}

export async function openZip(path: string, limits: Partial<ZipLimits> = {}): Promise<ZipReader> {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipLimitError('Not a zip archive.');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let endAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END) {
        endAt = i;
        break;
      }
    }
    if (endAt < 0) throw new ZipLimitError('Not a zip archive (no end record).');
    const count = tail.readUInt16LE(endAt + 10);
    const dirSize = tail.readUInt32LE(endAt + 12);
    const dirAt = tail.readUInt32LE(endAt + 16);
    if (count > lim.maxEntries)
      throw new ZipLimitError(`The archive has too many entries (${count}).`);
    if (dirAt + dirSize > size) throw new ZipLimitError('The archive is truncated.');
    const dir = await readAt(fh, dirAt, dirSize);

    const entries = new Map<string, EntryMeta>();
    let total = 0;
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > dir.length || dir.readUInt32LE(at) !== CENTRAL) {
        throw new ZipLimitError('The archive directory is broken.');
      }
      const flags = dir.readUInt16LE(at + 8);
      const method = dir.readUInt16LE(at + 10);
      const crc = dir.readUInt32LE(at + 16);
      const compressedSize = dir.readUInt32LE(at + 20);
      const usize = dir.readUInt32LE(at + 24);
      const nameLen = dir.readUInt16LE(at + 28);
      const extraLen = dir.readUInt16LE(at + 30);
      const commentLen = dir.readUInt16LE(at + 32);
      const localAt = dir.readUInt32LE(at + 42);
      const name = dir.toString('utf8', at + 46, at + 46 + nameLen);
      at += 46 + nameLen + extraLen + commentLen;

      safeName(name);
      if (flags & 0x1) throw new ZipLimitError(`${name} is encrypted.`);
      if (method !== 0 && method !== 8)
        throw new ZipLimitError(`${name} uses an unsupported compression method.`);
      if (compressedSize === MAX_U32 || usize === MAX_U32)
        throw new ZipLimitError('ZIP64 archives are not supported.');
      if (entries.has(name)) throw new ZipLimitError(`The archive has a duplicate entry: ${name}.`);
      if (usize > RATIO_FLOOR_BYTES && usize / Math.max(compressedSize, 1) > lim.maxRatio) {
        throw new ZipLimitError(`${name} has an implausible compression ratio.`);
      }
      total += usize;
      if (total > lim.maxTotalBytes)
        throw new ZipLimitError('The archive is too large once unpacked.');
      entries.set(name, { name, size: usize, compressedSize, method, crc, localAt });
    }

    return {
      entries: [...entries.values()].map(({ name, size: s, compressedSize: c }) => ({
        name,
        size: s,
        compressedSize: c,
      })),
      has: (name) => entries.has(name),
      async read(name) {
        const e = entries.get(name);
        if (!e) throw new ZipLimitError(`${name} is not in the archive.`);
        if (e.size > lim.maxEntryBytes) throw new ZipLimitError(`${name} is too large.`);
        const local = await readAt(fh, e.localAt, 30);
        if (local.readUInt32LE(0) !== LOCAL)
          throw new ZipLimitError(`${name} has no local header.`);
        const start = e.localAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const body = await readAt(fh, start, e.compressedSize);
        let data: Buffer;
        if (e.method === 0) {
          data = body;
        } else {
          try {
            data = inflateRawSync(body, { maxOutputLength: Math.max(e.size, 1) });
          } catch {
            throw new ZipLimitError(`${name} is corrupted or too large.`);
          }
        }
        if (data.length !== e.size || (crc32(data) as number) !== e.crc) {
          throw new ZipLimitError(`${name} is corrupted (checksum mismatch).`);
        }
        return data;
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close();
    throw err;
  }
}
