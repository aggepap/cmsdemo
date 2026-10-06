import type { MenuLink } from '@/cms/core/settings/menus';
import { NAV_ITEMS, navItems, type NavFlags, type NavLeaf } from '@/lib/nav';

/**
 * Which menu the header and footer render: the one built in Settings → Menus,
 * or — when none is set — the code-defined tables in `nav.ts`, so a site
 * nobody has configured renders exactly what it always did.
 *
 * Its own file rather than part of `nav.ts`: a generated site rewrites
 * `nav.ts` with its own tables, and this must survive that untouched.
 */

/** A rendered menu entry — the built-in tables and an admin menu alike. */
export interface NavLink {
  /** Unique within its list, for React. */
  key: string;
  label: string;
  href: string;
  newTab: boolean;
  children: NavLink[];
}

type Translate = (key: string) => string;

const fromLeaf =
  (t: Translate) =>
  (leaf: NavLeaf): NavLink => ({
    key: leaf.labelKey,
    label: t(leaf.labelKey),
    href: leaf.href,
    newTab: false,
    children: [],
  });

function fromAdmin(links: ReadonlyArray<MenuLink>, prefix = ''): NavLink[] {
  return links.map((link, i) => ({
    key: `${prefix}${i}`,
    label: link.label,
    href: link.href,
    newTab: link.newTab,
    children: fromAdmin(link.children, `${prefix}${i}.`),
  }));
}

/**
 * The header menu: the admin's when one is set, otherwise the built-in one
 * with its module links. An admin menu gets no module links added — the owner
 * placed (or left out) the shop link themselves.
 */
export function headerLinks(
  admin: ReadonlyArray<MenuLink> | null,
  flags: NavFlags,
  t: Translate
): NavLink[] {
  return admin ? fromAdmin(admin) : navItems(flags).map(fromLeaf(t));
}

/** The footer's "Explore" column: the admin's menu, or the base items. */
export function footerLinks(admin: ReadonlyArray<MenuLink> | null, t: Translate): NavLink[] {
  return admin ? fromAdmin(admin) : NAV_ITEMS.map(fromLeaf(t));
}
