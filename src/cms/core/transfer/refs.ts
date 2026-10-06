/**
 * The reference walker: every place a document's `data` points at another
 * entity, found by walking the collection's field tree.
 *
 * `document_relations` cannot be used for this — it only indexes top-level
 * relation fields (see `core/documents/relations.ts`), so `components[].product`
 * and every image are invisible to it. The field declaration is the only
 * complete map.
 *
 * One transform serves both jobs: collecting (for the dependency graph) and
 * rewriting (source ids → target ids on import). Two walkers would disagree
 * about some nested case sooner or later, and the disagreement would be a
 * reference that is collected but never rewritten.
 */
import type { Field } from '../../config/fields';
import { collectRichTextRefs, rewriteRichText } from './richtext';
import { mapLocalizedValue, type LocaleMap } from './locale-map';

export type RefKind = 'doc' | 'media' | 'script' | 'reviewLocation';

export interface Ref {
  kind: RefKind;
  /** Document id (number), media uuid, or slug. */
  value: number | string;
  /** Dot path inside `data`, e.g. `components.0.product` or `banner.el`. */
  path: string;
  /** For `doc`: the collection the field points at. */
  collection?: string;
}

/** Source → target. `null` means "not available on the target": the reference is dropped. */
export interface RefResolver {
  doc(id: number, collection?: string): number | null;
  media(uuid: string): string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MEDIA_URL =
  /\/api\/cms\/media\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How each kind of reference is handled; returning `null` drops it. */
interface Handlers {
  doc(id: number, path: string, collection: string): number | null;
  media(uuid: string, path: string): string | null;
  richText(doc: unknown, path: string): unknown;
}

/** Media URLs inside free text (MDX bodies, textareas, link hrefs). An unresolved one is left as written. */
export function mapMediaUrls(
  text: string,
  path: string,
  media: (uuid: string, path: string) => string | null
): string {
  return text.replace(MEDIA_URL, (whole, uuid: string) => {
    const to = media(uuid, path);
    return to === null ? whole : whole.replace(uuid, to);
  });
}

function isLocaleMap(field: Field, value: unknown): value is Rec {
  if (!field.localized || !isRecord(value)) return false;
  // A rich-text document is an object too; a locale map of them is not `{ type: 'doc' }`.
  return !(field.kind === 'richText' && value.type === 'doc');
}

function isEmptyRef(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

/**
 * A reference that had nowhere to point: its key (or list entry, or locale
 * entry) is removed. Not `null` — the validator refuses `null` for a single
 * relation or image, so a nulled reference would fail the whole document.
 */
const DROP: unique symbol = Symbol('drop');

function transformBare(field: Field, value: unknown, path: string, h: Handlers): unknown {
  switch (field.kind) {
    case 'relation': {
      const one = (id: unknown, at: string): unknown => {
        if (typeof id !== 'number' || !Number.isInteger(id)) return id;
        const to = h.doc(id, at, field.to);
        return to === null ? DROP : to;
      };
      if (Array.isArray(value)) {
        return value.map((id, i) => one(id, `${path}.${i}`)).filter((id) => id !== DROP);
      }
      return one(value, path);
    }
    case 'image': {
      if (!isUuid(value)) return value;
      const to = h.media(value, path);
      return to === null ? DROP : to;
    }
    case 'repeater': {
      if (!Array.isArray(value)) return value;
      const out: unknown[] = [];
      value.forEach((row, i) => {
        if (!isRecord(row)) return void out.push(row);
        const next = transformObject(field.fields, row, `${path}.${i}`, h);
        // A row that lost its relation (a component without its product) or a
        // required image means nothing any more, and is removed.
        const broken = field.fields.some(
          (sub) =>
            (sub.kind === 'relation' || (sub.kind === 'image' && sub.required)) &&
            !isEmptyRef(row[sub.key]) &&
            isEmptyRef(next[sub.key])
        );
        if (!broken) out.push(next);
      });
      return out;
    }
    case 'group':
      return isRecord(value) ? transformObject(field.fields, value, path, h) : value;
    case 'variations':
      // Each generated row carries an `image` no sub-field declares.
      if (!Array.isArray(value)) return value;
      return value.map((row, i) => {
        if (!isRecord(row) || !isUuid(row.image)) return row;
        const to = h.media(row.image, `${path}.${i}.image`);
        if (to !== null) return { ...row, image: to };
        const rest: Rec = { ...row };
        delete rest.image;
        return rest;
      });
    case 'richText':
      return h.richText(value, path);
    case 'text':
    case 'textarea':
    case 'code':
      return typeof value === 'string' ? mapMediaUrls(value, path, h.media) : value;
    case 'number':
    case 'boolean':
    case 'select':
    case 'date':
    case 'monthDay':
    case 'color':
      return value;
    default: {
      // A new field kind must be classified here before it can ship: one that
      // holds references and is not walked would be copied with source ids.
      const unhandled: never = field;
      return unhandled;
    }
  }
}

function transformValue(field: Field, value: unknown, path: string, h: Handlers): unknown {
  if (isLocaleMap(field, value)) {
    const out: Rec = {};
    for (const [locale, v] of Object.entries(value)) {
      const next = transformBare(field, v, `${path}.${locale}`, h);
      if (next !== DROP) out[locale] = next;
    }
    return out;
  }
  return transformBare(field, value, path, h);
}

function transformObject(fields: readonly Field[], obj: Rec, prefix: string, h: Handlers): Rec {
  const out: Rec = { ...obj };
  for (const field of fields) {
    if (!(field.key in obj)) continue;
    const next = transformValue(
      field,
      obj[field.key],
      prefix ? `${prefix}.${field.key}` : field.key,
      h
    );
    if (next === DROP) delete out[field.key];
    else out[field.key] = next;
  }
  return out;
}

/** Every reference in `data`, in field order. */
export function collectRefs(fields: readonly Field[], data: Rec): Ref[] {
  const refs: Ref[] = [];
  transformObject(fields, data, '', {
    doc: (id, path, collection) => (refs.push({ kind: 'doc', value: id, path, collection }), id),
    media: (uuid, path) => (refs.push({ kind: 'media', value: uuid, path }), uuid),
    richText: (doc, path) => (refs.push(...collectRichTextRefs(doc, path)), doc),
  });
  return refs;
}

/**
 * `data` with every reference mapped through `resolver`. An unresolved single
 * reference becomes `null`, an unresolved entry of a list is removed, and each
 * is reported in `dropped`. The input is not mutated.
 */
export function rewriteData(
  fields: readonly Field[],
  data: Rec,
  resolver: RefResolver
): { data: Rec; dropped: Ref[] } {
  const dropped: Ref[] = [];
  const out = transformObject(fields, structuredClone(data), '', {
    doc: (id, path, collection) => {
      const to = resolver.doc(id, collection);
      if (to === null) dropped.push({ kind: 'doc', value: id, path, collection });
      return to;
    },
    media: (uuid, path) => {
      const to = resolver.media(uuid);
      if (to === null) dropped.push({ kind: 'media', value: uuid, path });
      return to;
    },
    richText: (doc, path) => rewriteRichText(doc, resolver, path, dropped),
  });
  return { data: out, dropped };
}

/**
 * `data` reduced to what the TARGET's schema declares, with localized values
 * re-keyed through `localeMap`.
 *
 * Needed because validation is strict: a field the source site has and the
 * target does not (a newer version, a custom field never defined here) would
 * make the whole document fail to import. Dropping the key and saying so is the
 * better outcome. Groups declared `strict: false` keep unknown keys, as the
 * validator does.
 */
export function pruneToSchema(
  fields: readonly Field[],
  data: Rec,
  localeMap: LocaleMap
): { data: Rec; droppedKeys: string[] } {
  const droppedKeys: string[] = [];

  const pruneBare = (field: Field, value: unknown, path: string): unknown => {
    if (field.kind === 'group' && isRecord(value))
      return pruneObject(field.fields, value, path, field.strict !== false);
    if (field.kind === 'repeater' && Array.isArray(value)) {
      return value.map((row, i) =>
        isRecord(row) ? pruneObject(field.fields, row, `${path}.${i}`, true) : row
      );
    }
    return value;
  };

  const pruneObject = (fs: readonly Field[], obj: Rec, prefix: string, strict: boolean): Rec => {
    const out: Rec = {};
    const byKey = new Map(fs.map((fd) => [fd.key, fd]));
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const field = byKey.get(key);
      if (!field) {
        if (strict) droppedKeys.push(path);
        else out[key] = value;
        continue;
      }
      if (isLocaleMap(field, value)) {
        const mapped = mapLocalizedValue(value, localeMap);
        const next: Rec = {};
        for (const [locale, v] of Object.entries(mapped))
          next[locale] = pruneBare(field, v, `${path}.${locale}`);
        out[key] = next;
      } else {
        out[key] = pruneBare(field, value, path);
      }
    }
    return out;
  };

  return { data: pruneObject(fields, data, '', true), droppedKeys };
}
