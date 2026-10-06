import { moduleLabel } from '../../core/settings/schema';
import type { GroupOption } from './types';

export interface ModuleSection {
  /** Null for what every site has. */
  module: string | null;
  label: string;
  /** The module is switched off on this site: nothing in it can be picked. */
  off: boolean;
  groups: GroupOption[];
}

/** Groups under one heading per module — what every site has first, then modules in the order met. */
export function sectionsByModule(groups: readonly GroupOption[]): ModuleSection[] {
  const general: ModuleSection = { module: null, label: 'General', off: false, groups: [] };
  const byModule = new Map<string, ModuleSection>();
  for (const group of groups) {
    const owner = group.module ?? null;
    if (owner === null) {
      general.groups.push(group);
      continue;
    }
    const section = byModule.get(owner) ?? {
      module: owner,
      label: moduleLabel(owner),
      off: false,
      groups: [],
    };
    section.groups.push(group);
    section.off ||= group.moduleOff === true;
    byModule.set(owner, section);
  }
  return [...(general.groups.length ? [general] : []), ...byModule.values()];
}
