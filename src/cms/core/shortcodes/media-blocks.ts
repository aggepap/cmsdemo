/**
 * The rules behind `[video]` and `[map]` — both a picture and a link out.
 *
 * Neither embeds anything. The owner's rule is no iframe on any site, and the
 * CSP agrees: no `frame-src`, and `img-src 'self'`. So the preview is always a
 * file from the site's own media library, and a remote thumbnail is not an
 * option either — it would be blocked, and it would hand every visitor's IP
 * address to the video host before they chose to go there.
 *
 * Client-safe: the registry patterns and the render helpers live together so
 * the editor's warning and the public page cannot disagree.
 */

/** The hosts a video link may point at. Exact names: `m.youtube.com`, a
 *  lookalike, or a userinfo trick (`youtube.com@evil.com`) are all refused. */
const VIDEO_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'vimeo.com',
  'www.vimeo.com',
]);

/**
 * The registry's check, typed by the editor. Deliberately the same allow-list
 * as `videoHref`; the host must be followed by a `/`, which is what refuses a
 * port, userinfo and a longer host that merely starts with an allowed one.
 */
export const VIDEO_URL_PATTERN =
  /^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\/[^\s"'<>\\]*$/;

/** A media library id. */
export const MEDIA_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A decimal coordinate, or nothing. The range is checked by `directionsUrl`. */
export const COORDINATE_PATTERN = /^(?:-?\d{1,3}(?:\.\d{1,10})?)?$/;

/** The site's own URL for a media file. */
export function mediaFileUrl(uuid: string): string {
  return `/api/cms/media/file/${encodeURIComponent(uuid)}`;
}

/**
 * The link to open, or null when the URL is not on an allowed host.
 *
 * Parsed with `URL` as well as matched, so what is rendered is what the
 * browser will actually navigate to.
 */
export function videoHref(raw: string): string | null {
  const value = raw.trim();
  if (!VIDEO_URL_PATTERN.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!VIDEO_HOSTS.has(url.hostname)) return null;
  return url.href;
}

function coordinate(raw: string | undefined, limit: number): number | null {
  const value = raw?.trim() ?? '';
  if (!value || !COORDINATE_PATTERN.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/**
 * Google Maps directions to the place, or null when there is nothing to aim
 * at. Coordinates win over the address: they do not depend on how Google
 * happens to read a Greek street name.
 */
export function directionsUrl({
  lat,
  lng,
  address,
}: {
  lat?: string;
  lng?: string;
  address?: string;
}): string | null {
  const la = coordinate(lat, 90);
  const ln = coordinate(lng, 180);
  const destination = la !== null && ln !== null ? `${la},${ln}` : (address ?? '').trim();
  if (!destination) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}
