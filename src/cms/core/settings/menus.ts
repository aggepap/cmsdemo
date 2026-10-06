/**
 * Admin-built header and footer menus — Settings → Menus.
 *
 * Unset, or saved empty, means "the menu the site's code defines" (`lib/nav`),
 * so an existing site looks exactly as it did until somebody builds a menu.
 * Once set, the menu is exactly what the admin built: no module links are
 * slipped in, because an owner who has arranged their own menu has also
 * decided where the shop goes.
 *
 * The header may nest one level (a parent with sub-items); the footer is a
 * flat list. Every href is a path on this site or an https URL (`links.ts`).
 *
 * Client-safe: the admin screen, the settings validator and the site share it.
 */
import { z } from 'zod';

import { localizedText } from '../content/localized';
import { isExternalHref, isSiteLinkHref } from './links';

/** The `site_settings` key holding both menus. */
export const MENUS_KEY = 'site.menus';

/** How many items each list may hold. A header with more than this does not fit. */
export const MENU_LIMITS = { header: 12, children: 12, footer: 24 } as const;

export const MENU_LABEL_MAX = 60;

const LOCALE_KEY = /^[a-z]{2}(?:-[A-Z]{2})?$/;

const label = z
  .record(
    z.string().regex(LOCALE_KEY, 'must be a language code'),
    z.string().trim().max(MENU_LABEL_MAX)
  )
  .refine(
    (map) => Object.values(map).some((v) => v.length > 0),
    'needs a label in at least one language'
  );

const href = z
  .string()
  .trim()
  .refine(isSiteLinkHref, 'must be a path on this site (/…) or an https:// address');

const leaf = z.object({ label, href, newTab: z.boolean().default(false) }).strict();

const headerItem = leaf
  .extend({ children: z.array(leaf).max(MENU_LIMITS.children).optional() })
  .strict();

export const menusSchema = z
  .object({
    header: z.array(headerItem).max(MENU_LIMITS.header),
    footer: z.array(leaf).max(MENU_LIMITS.footer),
  })
  .strict();

export type MenusConfig = z.infer<typeof menusSchema>;
export type MenuItemConfig = z.infer<typeof headerItem>;

/** One menu item as the site renders it. */
export interface MenuLink {
  label: string;
  href: string;
  newTab: boolean;
  external: boolean;
  children: MenuLink[];
}

/* Read leniently, item by item: one bad item that reached the database some
   other way is dropped, rather than costing the whole menu. */
const storedItem = z.object({
  label: z.unknown(),
  href: z.unknown(),
  newTab: z.unknown().optional(),
  children: z.array(z.unknown()).optional(),
});

function toLink(
  raw: unknown,
  locale: string,
  defaultLocale: string,
  depth: number
): MenuLink | null {
  const parsed = storedItem.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  if (!isSiteLinkHref(item.href)) return null;
  const text = localizedText(item.label, locale, defaultLocale).trim();
  if (!text) return null;
  const children =
    depth === 0
      ? (item.children ?? [])
          .map((child) => toLink(child, locale, defaultLocale, 1))
          .filter((child): child is MenuLink => child !== null)
      : [];
  return {
    label: text,
    href: item.href,
    newTab: item.newTab === true,
    external: isExternalHref(item.href),
    children,
  };
}

/**
 * One menu for one language, or null when there is none — the caller then
 * renders the built-in menu. The footer never has children.
 */
export function resolveMenu(
  raw: unknown,
  which: 'header' | 'footer',
  locale: string,
  defaultLocale: string
): MenuLink[] | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (raw as Record<string, unknown>)[which];
  if (!Array.isArray(list)) return null;
  const links = list
    .map((item) => toLink(item, locale, defaultLocale, which === 'header' ? 0 : 1))
    .filter((link): link is MenuLink => link !== null);
  return links.length > 0 ? links : null;
}
