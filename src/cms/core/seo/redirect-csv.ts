/**
 * Reading a redirect list from CSV — the shape a site migration arrives in: a few
 * hundred old URLs from the previous shop, exported to a spreadsheet and filled in
 * with where each one should go now.
 *
 * Columns are `source,target[,status][,notes]`. A header row is optional; when the
 * first row names its columns (`source`/`from`/`old url`, `target`/`to`/`new url`,
 * …) they are mapped by name, in any order. Comma, semicolon and tab separators
 * are all accepted, because a spreadsheet in a Greek locale saves with `;`.
 *
 * This only reads. Whether a row is a valid redirect is decided by the same rules
 * as the admin form (`redirect-import.ts`), so nothing here is a second opinion.
 * Pure: the admin screen previews with the server's answer, and tests call it
 * directly.
 */

/** Largest file accepted, in bytes. A few thousand rows of URLs fit with room to spare. */
export const REDIRECT_CSV_MAX_BYTES = 512 * 1024;
/** Most data rows accepted in one import. */
export const REDIRECT_CSV_MAX_ROWS = 2000;

export interface RedirectCsvRow {
  /** 1-based line in the file, so a problem can be pointed at. */
  line: number;
  source: string;
  /** Empty means "not decided yet": the row becomes a pending mapping. */
  target: string;
  /** As written; blank means the default (301). Validated with the rest of the row. */
  statusCode: string;
  notes: string;
}

export type RedirectCsvResult = { ok: true; rows: RedirectCsvRow[] } | { ok: false; error: string };

type Column = 'source' | 'target' | 'statusCode' | 'notes';

const HEADER_NAMES: Record<Column, readonly string[]> = {
  source: ['source', 'from', 'old', 'old url', 'old path', 'old_url', 'url', 'redirect from'],
  target: ['target', 'to', 'new', 'new url', 'new path', 'new_url', 'destination', 'redirect to'],
  statusCode: ['status', 'status code', 'status_code', 'statuscode', 'code', 'type'],
  notes: ['notes', 'note', 'comment', 'comments', 'description'],
};

const POSITIONAL: readonly Column[] = ['source', 'target', 'statusCode', 'notes'];

/** The separator the first line uses most: `,`, `;` or a tab. */
function detectDelimiter(firstLine: string): string {
  const counts = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

/** RFC 4180 records: quoted fields may hold the separator, `""` and line breaks. */
function records(text: string, delimiter: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;

  const endRecord = () => {
    cells.push(cell);
    out.push({ line: startLine, cells });
    cells = [];
    cell = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (c === '\n') line += 1;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (c === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      startLine = line;
    } else {
      cell += c;
    }
  }
  if (cell !== '' || cells.length) endRecord();
  return out;
}

/** Which column each header cell names, or null when the row is not a header. */
function headerMap(cells: string[]): Partial<Record<Column, number>> | null {
  const map: Partial<Record<Column, number>> = {};
  cells.forEach((raw, i) => {
    const name = raw.trim().toLowerCase();
    for (const col of POSITIONAL) {
      if (map[col] === undefined && HEADER_NAMES[col].includes(name)) map[col] = i;
    }
  });
  return map.source !== undefined && map.target !== undefined ? map : null;
}

/**
 * A full URL in the source column reduced to its path: an export from the old
 * site usually lists absolute addresses, but a redirect only ever sees the path
 * of a request that has already reached this site. The query string is dropped
 * with the origin, since redirects are matched on the path alone.
 */
function sourcePath(raw: string): string {
  const v = raw.trim();
  if (!/^https?:\/\//i.test(v)) return v;
  try {
    return new URL(v).pathname;
  } catch {
    return v;
  }
}

export function parseRedirectCsv(
  text: string,
  limits: { maxBytes?: number; maxRows?: number } = {},
): RedirectCsvResult {
  const maxBytes = limits.maxBytes ?? REDIRECT_CSV_MAX_BYTES;
  const maxRows = limits.maxRows ?? REDIRECT_CSV_MAX_ROWS;
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, error: `The file is too large — at most ${Math.floor(maxBytes / 1024)} KB at a time.` };
  }

  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const all = records(body, detectDelimiter(firstLine)).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!all.length) return { ok: false, error: 'The file has no rows.' };

  const header = headerMap(all[0].cells);
  const data = header ? all.slice(1) : all;
  if (!data.length) return { ok: false, error: 'The file has a header row but no redirects under it.' };
  if (data.length > maxRows) {
    return { ok: false, error: `The file has ${data.length} rows — at most ${maxRows} can be imported at a time.` };
  }

  const at = (cells: string[], col: Column): string => {
    const i = header ? header[col] : POSITIONAL.indexOf(col);
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };

  return {
    ok: true,
    rows: data.map(({ line, cells }) => ({
      line,
      source: sourcePath(at(cells, 'source')),
      target: at(cells, 'target'),
      statusCode: at(cells, 'statusCode'),
      notes: at(cells, 'notes'),
    })),
  };
}
