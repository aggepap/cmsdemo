'use client';

import { Tabs, type TabDef } from '../ui';
import { ExportPanel } from './ExportPanel';
import { ImportPanel } from './ImportPanel';
import type { GroupOption } from './types';

/**
 * Admin → Export / Import. Each direction is shown only to someone allowed to
 * use it; the API checks the same permissions on every request regardless.
 */
export function TransferManager({
  groups,
  canExport,
  canImport,
  targetLocales,
  groupLabels,
  canManageModules = false,
}: {
  /** What this user may export from this site, labelled. */
  groups: GroupOption[];
  /** Labels for every group this site has — an import may hold groups the user cannot export. */
  groupLabels?: GroupOption[];
  canExport: boolean;
  canImport: boolean;
  targetLocales: string[];
  /** May switch a module on from the import, when a package needs one that is off. */
  canManageModules?: boolean;
}) {
  const tabs: TabDef[] = [];
  if (canExport)
    tabs.push({ id: 'export', label: 'Export', content: <ExportPanel groups={groups} /> });
  if (canImport) {
    tabs.push({
      id: 'import',
      label: 'Import',
      content: (
        <ImportPanel
          siteGroups={groupLabels ?? groups}
          targetLocales={targetLocales}
          canManageModules={canManageModules}
        />
      ),
    });
  }
  return <Tabs tabs={tabs} label="Export or import" />;
}
