import config from '@/site.config';
import { TransferManager } from '@/cms/admin';
import { labelText } from '@/cms/admin/shared';
import { exportableGroups } from '@/cms/core/transfer/export/collect';
import {
  allGroupKeys,
  canExportGroup,
  groupDef,
  moduleOfGroup,
  type GroupKey,
} from '@/cms/core/transfer/groups';
import { hasPerm, PERMISSIONS, requirePerm } from '@/cms/modules/auth';

export const dynamic = 'force-dynamic';

function groupLabel(group: GroupKey): string {
  if (!group.startsWith('documents:')) return groupDef(group).label;
  const key = group.slice('documents:'.length);
  return labelText(config.collectionByKey.get(key)?.labelPlural, 'en', key);
}

/**
 * Export / Import. Either direction opens the screen; each tab and every API
 * call behind it checks its own permission, and each group its area's.
 */
export default async function TransferPage() {
  const user = await requirePerm(PERMISSIONS.access);
  const canExport = hasPerm(user.permissions, PERMISSIONS.transferExport);
  const canImport = hasPerm(user.permissions, PERMISSIONS.transferImport);
  if (!canExport && !canImport) await requirePerm(PERMISSIONS.transferExport);

  const option = (key: GroupKey) => ({
    key,
    label: groupLabel(key),
    pii: groupDef(key).pii,
    module: moduleOfGroup(key, config.collectionByKey),
  });
  // Export offers what is on; an import may hold anything this site has, module on or off.
  const exportable = (await exportableGroups(config))
    .filter((key) => canExportGroup(user.permissions, key))
    .map(option);
  const all = allGroupKeys(config.collections).map(option);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-neutral-900">Export / Import</h1>
      <p className="max-w-3xl text-sm text-neutral-700">
        Move content, media and settings between sites built on this CMS. Export makes a package of
        what you choose; Import reads a package from another site and lets you decide, item by item,
        what to add, skip or overwrite. Service credentials and passwords are never included.
      </p>
      <TransferManager
        groups={canExport ? exportable : []}
        groupLabels={all}
        canExport={canExport}
        canImport={canImport}
        targetLocales={[...config.locales]}
        canManageModules={hasPerm(user.permissions, PERMISSIONS.settingsWrite)}
      />
    </div>
  );
}
