/**
 * Pure state helpers for Settings → Menus, kept out of the component so the
 * reorder rules are testable without a DOM.
 */
import { menusSchema, type MenusConfig } from '../core/settings/menus';

export type EditableMenus = MenusConfig;

/** The item at `index` swapped with its neighbour `delta` away; a move past
 *  either end leaves the list as it is. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** The stored setting as the editor starts it. Unset or malformed is two
 *  empty menus — which the site reads as "use the built-in menus". */
export function parseStoredMenus(raw: unknown): EditableMenus {
  const parsed = menusSchema.safeParse(raw);
  return parsed.success ? parsed.data : { header: [], footer: [] };
}
