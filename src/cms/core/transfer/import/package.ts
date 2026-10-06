import 'server-only';

import { createHash } from 'node:crypto';

import { badRequest } from '../../errors';
import {
  manifestSchema,
  recordLineSchema,
  type ManifestFile,
  type RecordLine,
  type TransferManifest,
} from '../format';
import { groupOfItem, isGroupKey } from '../groups';
import { stubsSchema, type Stubs } from '../records';
import { openZip, ZipLimitError, type ZipReader } from '../zip-file';

/** Entry names a package may contain; anything else is ignored, never read. */
const ALLOWED_ENTRY =
  /^(manifest\.json|data\/stubs\.json|data\/[a-z0-9_:/-]+\.jsonl|media\/[0-9a-f-]{36}(\.avif)?)$/i;

export async function openPackage(path: string): Promise<ZipReader> {
  try {
    return await openZip(path);
  } catch (err) {
    if (err instanceof ZipLimitError)
      throw badRequest(`This is not a readable package: ${err.message}`);
    throw err;
  }
}

export async function readManifest(zip: ZipReader): Promise<TransferManifest> {
  if (!zip.has('manifest.json'))
    throw badRequest('This is not a site export package (no manifest).');
  let raw: unknown;
  try {
    raw = JSON.parse((await zip.read('manifest.json')).toString('utf8'));
  } catch {
    throw badRequest('The package manifest is not valid JSON.');
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success)
    throw badRequest('This is not a site export package, or it is from an incompatible version.');
  return parsed.data;
}

export async function readStubs(zip: ZipReader): Promise<Stubs> {
  if (!zip.has('data/stubs.json')) return { documents: [], media: [] };
  const parsed = stubsSchema.safeParse(
    JSON.parse((await zip.read('data/stubs.json')).toString('utf8'))
  );
  return parsed.success ? parsed.data : { documents: [], media: [] };
}

export interface ParsedLine {
  line: number;
  record?: RecordLine;
  error?: string;
}

/**
 * The lines of one data file, after checking it is the file the manifest
 * describes (sha256). A line whose key does not belong to the file's group is
 * refused: it would otherwise be processed under the wrong group's rules and
 * permissions.
 */
export async function readDataFile(zip: ZipReader, file: ManifestFile): Promise<ParsedLine[]> {
  if (!ALLOWED_ENTRY.test(file.path) || !zip.has(file.path))
    throw badRequest(`The package is missing ${file.path}.`);
  if (!isGroupKey(file.group))
    throw badRequest(`The package names an unknown group: ${file.group}.`);
  const body = await zip.read(file.path);
  if (createHash('sha256').update(body).digest('hex') !== file.sha256) {
    throw badRequest(`${file.path} does not match the manifest — the package is damaged.`);
  }
  const out: ParsedLine[] = [];
  body
    .toString('utf8')
    .split('\n')
    .forEach((text, line) => {
      if (!text.trim()) return;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return void out.push({ line, error: 'Not valid JSON.' });
      }
      const parsed = recordLineSchema.safeParse(json);
      if (!parsed.success) return void out.push({ line, error: 'Not a valid record.' });
      if (groupOfItem(parsed.data.k) !== file.group)
        return void out.push({ line, error: 'Record is in the wrong group.' });
      out.push({ line, record: parsed.data });
    });
  return out;
}
