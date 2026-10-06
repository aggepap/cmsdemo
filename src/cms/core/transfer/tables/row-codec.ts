/**
 * A database row ⇄ a package record, driven by the table's own column
 * definitions.
 *
 * Phase C moves whole rows — customers, orders, reservations — whose shapes
 * are the schema itself. Rather than restate each table as a zod schema that
 * would drift from it, the columns are read from Drizzle: the type, the length,
 * the enum values and whether the column may be null. On the way in anything a
 * column could not hold is refused, because a package is a user upload.
 */
import { getTableColumns, type Table } from 'drizzle-orm';

type Rec = Record<string, unknown>;

interface ColumnInfo {
  columnType: string;
  notNull: boolean;
  hasDefault: boolean;
  length?: number;
  enumValues?: readonly string[];
}

const MAX_TEXT = 1_000_000;
const MAX_JSON = 1_000_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function columns(table: Table): Record<string, ColumnInfo> {
  return getTableColumns(table) as unknown as Record<string, ColumnInfo>;
}

/** Binary columns hold encrypted secrets (a TOTP seed): never exported, never imported. */
const isBinary = (c: ColumnInfo) =>
  c.columnType === 'MySqlVarBinary' || c.columnType === 'MySqlBinary';

export function encodeRow(table: Table, row: Rec, omit: readonly string[]): Rec {
  const out: Rec = {};
  for (const [key, col] of Object.entries(columns(table))) {
    if (omit.includes(key) || isBinary(col) || !(key in row)) continue;
    const v = row[key];
    out[key] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

function checkValue(
  key: string,
  col: ColumnInfo,
  v: unknown
): { ok: true; value: unknown } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `${key}: ${why}` });
  if (v === null) return col.notNull ? bad('cannot be empty') : { ok: true, value: null };
  switch (col.columnType) {
    case 'MySqlVarChar':
    case 'MySqlChar':
      if (typeof v !== 'string') return bad('expected text');
      if (col.length && v.length > col.length) return bad(`longer than ${col.length} characters`);
      return { ok: true, value: v };
    case 'MySqlText':
    case 'MySqlMediumText':
    case 'MySqlLongText':
      if (typeof v !== 'string') return bad('expected text');
      if (v.length > MAX_TEXT) return bad('too long');
      return { ok: true, value: v };
    case 'MySqlInt':
    case 'MySqlTinyInt':
    case 'MySqlSmallInt':
    case 'MySqlMediumInt':
    case 'MySqlBigInt53':
      return typeof v === 'number' && Number.isSafeInteger(v)
        ? { ok: true, value: v }
        : bad('expected a whole number');
    case 'MySqlBoolean':
      return typeof v === 'boolean' ? { ok: true, value: v } : bad('expected true or false');
    case 'MySqlJson':
      return JSON.stringify(v).length <= MAX_JSON ? { ok: true, value: v } : bad('too large');
    case 'MySqlTimestamp':
    case 'MySqlDateTime':
      return typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v))
        ? { ok: true, value: new Date(v) }
        : bad('expected a date and time');
    case 'MySqlDateString':
      return typeof v === 'string' && DATE_ONLY.test(v)
        ? { ok: true, value: v }
        : bad('expected YYYY-MM-DD');
    case 'MySqlEnumColumn':
      return typeof v === 'string' && col.enumValues?.includes(v)
        ? { ok: true, value: v }
        : bad('not an allowed value');
    default:
      return bad(`unsupported column type ${col.columnType}`);
  }
}

/**
 * Column values for an insert or update, or every reason the record cannot be
 * one. Omitted columns (ids, foreign keys the caller maps itself, secrets) and
 * keys the table does not have are ignored.
 */
export function decodeRow(
  table: Table,
  record: Rec,
  omit: readonly string[]
): { ok: true; values: Rec } | { ok: false; errors: string[] } {
  const values: Rec = {};
  const errors: string[] = [];
  for (const [key, col] of Object.entries(columns(table))) {
    if (omit.includes(key) || isBinary(col)) continue;
    if (!(key in record) || record[key] === undefined) {
      if (col.notNull && !col.hasDefault) errors.push(`${key}: missing`);
      continue;
    }
    const r = checkValue(key, col, record[key]);
    if (r.ok) values[key] = r.value;
    else errors.push(r.error);
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}
