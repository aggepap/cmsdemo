/**
 * The per-group summary of an analysed package — what the import screen shows
 * before anything is chosen. Pure, so the analysis can be checked without a
 * database.
 */
import { groupDef, groupOfItem, moduleOfGroup, type GroupKey } from '../groups';
import type { ImportIndexItem } from './plan';

export interface GroupSummary {
  group: GroupKey;
  label: string;
  total: number;
  conflicts: number;
  invalid: number;
  /** This site can hold it (the collection exists, its module is on). */
  available: boolean;
  pii: boolean;
  /** The module the group belongs to on this site, or null for what every site has. */
  module: string | null;
  /** That module exists here but is switched off — turning it on makes the group importable. */
  moduleOff: boolean;
}

export function summarizeGroups(
  items: readonly ImportIndexItem[],
  site: {
    collections: ReadonlyMap<string, { module?: string }>;
    flags: Readonly<Record<string, boolean>>;
  }
): GroupSummary[] {
  const byGroup = new Map<GroupKey, GroupSummary>();
  for (const item of items) {
    const group = groupOfItem(item.key);
    if (!group) continue;
    let s = byGroup.get(group);
    if (!s) {
      const def = groupDef(group);
      const owner = moduleOfGroup(group, site.collections);
      s = {
        group,
        label: group.startsWith('documents:') ? group.slice('documents:'.length) : def.label,
        total: 0,
        conflicts: 0,
        invalid: 0,
        available: true,
        pii: def.pii,
        module: owner,
        moduleOff: owner !== null && owner in site.flags && site.flags[owner] !== true,
      };
      byGroup.set(group, s);
    }
    s.total++;
    if (item.invalid) s.invalid++;
    else if (item.state !== 'new') s.conflicts++;
  }
  for (const s of byGroup.values()) s.available = s.invalid < s.total || s.total === 0;
  return [...byGroup.values()].sort((a, b) => groupDef(a.group).rank - groupDef(b.group).rank);
}
