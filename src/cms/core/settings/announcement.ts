/**
 * The announcement bar — one short line above the header, set in
 * Settings → Announcement bar.
 *
 * Plain text in each language, one optional link, and whether a visitor may
 * dismiss it. A dismissal is remembered against an id derived from the
 * content, so editing the message (or its link) shows it again to everyone,
 * while re-saving it unchanged does not.
 *
 * Client-safe: the admin screen, the settings validator and the layout share it.
 */
import { z } from 'zod';

import { localizedText } from '../content/localized';
import { isExternalHref, isSiteLinkHref } from './links';

/** The `site_settings` key holding the announcement. */
export const ANNOUNCEMENT_KEY = 'site.announcement';

/** Long enough for one sentence; a bar that wraps to three lines is a banner. */
export const ANNOUNCEMENT_TEXT_MAX = 160;

const LOCALE_KEY = /^[a-z]{2}(?:-[A-Z]{2})?$/;

export const announcementSchema = z
  .object({
    enabled: z.boolean(),
    text: z.record(
      z.string().regex(LOCALE_KEY, 'must be a language code'),
      z
        .string()
        .trim()
        .max(ANNOUNCEMENT_TEXT_MAX)
        // One line of plain text: a line break would be dropped by the HTML
        // anyway, and control characters have no business in it.
        .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), 'must be a single line of plain text')
    ),
    href: z
      .string()
      .trim()
      .refine(
        (v) => v === '' || isSiteLinkHref(v),
        'must be a path on this site (/…) or an https:// address'
      ),
    dismissible: z.boolean(),
  })
  .strict();

export type AnnouncementConfig = z.infer<typeof announcementSchema>;

/**
 * The same shape, read leniently: the link is re-checked separately, so a bad
 * one that reached the database some other way loses the link, not the bar.
 */
const storedSchema = announcementSchema.extend({ href: z.string() });

export const EMPTY_ANNOUNCEMENT: AnnouncementConfig = {
  enabled: false,
  text: {},
  href: '',
  dismissible: true,
};

export interface ResolvedAnnouncement {
  /** Changes whenever the message or its link does — the dismissal key. */
  id: string;
  text: string;
  href: string | null;
  external: boolean;
  dismissible: boolean;
}

/** The stored value as the admin form edits it; anything malformed reads as empty. */
export function parseAnnouncement(raw: unknown): AnnouncementConfig {
  const parsed = announcementSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_ANNOUNCEMENT;
}

/** FNV-1a, 32-bit. Not security: only "has this message changed?". */
function contentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * What the bar shows for one language, or null for nothing at all.
 *
 * The id hashes every language's text, not just this one, so a visitor who
 * dismissed the bar and then switches language is not asked again.
 */
export function resolveAnnouncement(
  raw: unknown,
  locale: string,
  defaultLocale: string
): ResolvedAnnouncement | null {
  const parsed = storedSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.enabled) return null;
  const config = parsed.data;
  const text = localizedText(config.text, locale, defaultLocale).trim();
  if (!text) return null;
  const href = isSiteLinkHref(config.href) ? config.href : null;
  const texts = Object.keys(config.text)
    .sort()
    .map((key) => [key, config.text[key]]);
  return {
    id: contentHash(JSON.stringify([texts, href])),
    text,
    href,
    external: href !== null && isExternalHref(href),
    dismissible: config.dismissible,
  };
}
