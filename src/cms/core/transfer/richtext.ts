/**
 * References inside a TipTap rich-text document.
 *
 * Three shapes reach other entities:
 * - the editor's structured `shortcode` node (`attrs.name`, `attrs.attrs`);
 * - a paragraph that is exactly one typed shortcode (see `shortcodes/parse.ts`
 *   — inline brackets and `[[escaped]]` ones are prose, not references);
 * - a link or image pointing at `/api/cms/media/file/<uuid>`.
 *
 * `popup` names a document by id and must be rewritten, as do the media uuids
 * in the `image` of `video` and `map`. `script` and
 * `google-reviews` name a snippet and a review location by slug, which travels
 * unchanged; they are only collected, so the thing they name can travel too.
 */
import { parseShortcode, serializeShortcode } from '../shortcodes/parse';
import { MEDIA_URL, isUuid, mapMediaUrls, type Ref, type RefResolver } from './refs';

const POPUP_COLLECTION = 'popup';

/** Shortcodes whose `image` attribute is a media uuid (their preview picture). */
const IMAGE_SHORTCODES: ReadonlySet<string> = new Set(['video', 'map']);

type Node = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: unknown; attrs?: Record<string, unknown> }>;
  content?: unknown[];
};

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

function paragraphText(node: Node): string | null {
  if (!Array.isArray(node.content)) return null;
  let text = '';
  for (const child of node.content) {
    if (!isNode(child) || child.type !== 'text' || typeof child.text !== 'string') return null;
    text += child.text;
  }
  return text;
}

function shortcodeRefs(name: string, attrs: Record<string, string>, path: string): Ref[] {
  if (name === 'popup' && /^\d+$/.test(attrs.id ?? '')) {
    return [{ kind: 'doc', value: Number(attrs.id), path, collection: POPUP_COLLECTION }];
  }
  if (name === 'script' && attrs.name) return [{ kind: 'script', value: attrs.name, path }];
  if (name === 'google-reviews' && attrs.location && attrs.location !== 'all') {
    return [{ kind: 'reviewLocation', value: attrs.location, path }];
  }
  if (IMAGE_SHORTCODES.has(name) && isUuid(attrs.image)) {
    return [{ kind: 'media', value: attrs.image, path }];
  }
  return [];
}

function stringAttrs(v: unknown): Record<string, string> {
  if (!isNode(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

function mediaInString(value: unknown, path: string): Ref[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(MEDIA_URL)].map((m) => ({ kind: 'media' as const, value: m[1], path }));
}

export function collectRichTextRefs(doc: unknown, path: string): Ref[] {
  const refs: Ref[] = [];
  const visit = (node: unknown): void => {
    if (!isNode(node)) return;
    if (node.type === 'shortcode' && typeof node.attrs?.name === 'string') {
      refs.push(...shortcodeRefs(node.attrs.name, stringAttrs(node.attrs.attrs), path));
    }
    if (node.type === 'paragraph') {
      const text = paragraphText(node);
      const parsed = text === null ? null : parseShortcode(text);
      if (parsed) refs.push(...shortcodeRefs(parsed.name, parsed.attrs, path));
    }
    refs.push(...mediaInString(node.attrs?.src, path), ...mediaInString(node.attrs?.href, path));
    for (const mark of node.marks ?? []) refs.push(...mediaInString(mark.attrs?.href, path));
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return refs;
}

/**
 * The document with popup ids and media URLs mapped. An unresolvable popup id
 * is emptied — the shortcode then renders nothing, which beats rendering some
 * unrelated popup that holds the same id on this site.
 */
export function rewriteRichText(
  doc: unknown,
  resolver: RefResolver,
  path: string,
  dropped: Ref[]
): unknown {
  const media = (uuid: string): string | null => {
    const to = resolver.media(uuid);
    if (to === null) dropped.push({ kind: 'media', value: uuid, path });
    return to;
  };
  const popupAttrs = (attrs: Record<string, string>): Record<string, string> => {
    if (!/^\d+$/.test(attrs.id ?? '')) return attrs;
    const to = resolver.doc(Number(attrs.id), POPUP_COLLECTION);
    if (to === null) {
      dropped.push({ kind: 'doc', value: Number(attrs.id), path, collection: POPUP_COLLECTION });
      return Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'id'));
    }
    return { ...attrs, id: String(to) };
  };
  // An image that did not travel is removed: the block then renders nothing,
  // rather than a broken picture or one of this site's unrelated files.
  const imageAttrs = (attrs: Record<string, string>): Record<string, string> => {
    if (!isUuid(attrs.image)) return attrs;
    const to = media(attrs.image);
    if (to === null) return Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'image'));
    return { ...attrs, image: to };
  };
  const shortcodeAttrs = (name: string, attrs: Record<string, string>) =>
    name === 'popup' ? popupAttrs(attrs) : IMAGE_SHORTCODES.has(name) ? imageAttrs(attrs) : null;
  const mapString = (v: unknown): unknown =>
    typeof v === 'string' ? mapMediaUrls(v, path, media) : v;

  const visit = (node: unknown): unknown => {
    if (!isNode(node)) return node;
    const out: Node = { ...node };
    if (node.attrs) {
      out.attrs = { ...node.attrs };
      if ('src' in out.attrs) out.attrs.src = mapString(out.attrs.src);
      if ('href' in out.attrs) out.attrs.href = mapString(out.attrs.href);
      if (node.type === 'shortcode' && typeof node.attrs.name === 'string') {
        const mapped = shortcodeAttrs(node.attrs.name, stringAttrs(node.attrs.attrs));
        if (mapped) out.attrs.attrs = mapped;
      }
    }
    if (node.marks) {
      out.marks = node.marks.map((mark) =>
        mark.attrs && 'href' in mark.attrs
          ? { ...mark, attrs: { ...mark.attrs, href: mapString(mark.attrs.href) } }
          : mark
      );
    }
    if (node.type === 'paragraph') {
      const text = paragraphText(node);
      const parsed = text === null ? null : parseShortcode(text);
      const mapped = parsed ? shortcodeAttrs(parsed.name, parsed.attrs) : null;
      if (parsed && mapped) {
        return {
          ...out,
          content: [{ type: 'text', text: serializeShortcode(parsed.name, mapped) }],
        };
      }
    }
    if (Array.isArray(node.content)) out.content = node.content.map(visit);
    return out;
  };
  return visit(doc);
}
