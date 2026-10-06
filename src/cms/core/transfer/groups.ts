/**
 * The group registry — what can be moved between sites, in what order, and who
 * may move it.
 *
 * An ITEM is the unit a user ticks: one media file, one setting, one document
 * (all of its languages together — a translation group is never split). Its key
 * names its group, so every decision downstream can be checked against the
 * group's rules without a lookup table that could drift.
 *
 *   media:<uuid>   setting:<key>   doc:<collection>:<translationGroupId | id-N>
 *   script:<slug>  cookie:<key>    shipzone:<name>   reviewloc:<slug>
 *   redirect:<digest of kind + source>                seometa:<locale>:<path>
 */
import { hasPerm, PERMISSIONS } from '../../modules/auth/permissions';
import type { TransferAction } from './conflicts';

/** The site-configuration tables (phase B): one group each, keyed like their family. */
export type TableFamily =
  | 'scripts'
  | 'cookies'
  | 'shipping'
  | 'reviewLocations'
  | 'redirects'
  | 'seoMeta'
  // Phase C — people and transactions.
  | 'customers'
  | 'subscribers'
  | 'suppressions'
  | 'productReviews'
  | 'orders'
  | 'reservations'
  | 'bookingSlots'
  | 'roles'
  | 'users';
export type GroupFamily = 'media' | 'settings' | 'documents' | TableFamily;
export type GroupKey = 'media' | 'settings' | `documents:${string}` | TableFamily;

/** Item-key prefix → table family. */
export const TABLE_PREFIXES: Readonly<Record<string, TableFamily>> = {
  script: 'scripts',
  cookie: 'cookies',
  shipzone: 'shipping',
  reviewloc: 'reviewLocations',
  redirect: 'redirects',
  seometa: 'seoMeta',
  customer: 'customers',
  subscriber: 'subscribers',
  suppression: 'suppressions',
  preview: 'productReviews',
  order: 'orders',
  reservation: 'reservations',
  slot: 'bookingSlots',
  role: 'roles',
  user: 'users',
};
export const TABLE_FAMILIES = Object.values(TABLE_PREFIXES);

export function isTableFamily(value: string): value is TableFamily {
  return (TABLE_FAMILIES as string[]).includes(value);
}

export const itemKey = {
  media: (uuid: string) => `media:${uuid}`,
  setting: (key: string) => `setting:${key}`,
  doc: (type: string, groupKey: string) => `doc:${type}:${groupKey}`,
};

export type ParsedItemKey =
  | { family: 'media'; id: string }
  | { family: 'settings'; id: string }
  | { family: 'documents'; type: string; id: string }
  | { family: TableFamily; id: string };

export function parseItemKey(key: string): ParsedItemKey | null {
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (!rest) return null;
  if (prefix === 'media') return { family: 'media', id: rest };
  if (prefix === 'setting') return { family: 'settings', id: rest };
  const table = TABLE_PREFIXES[prefix];
  if (table) return { family: table, id: rest };
  if (prefix === 'doc') {
    const at = rest.indexOf(':');
    if (at <= 0 || at === rest.length - 1) return null;
    return { family: 'documents', type: rest.slice(0, at), id: rest.slice(at + 1) };
  }
  return null;
}

export function groupOfItem(key: string): GroupKey | null {
  const parsed = parseItemKey(key);
  if (!parsed) return null;
  if (parsed.family === 'documents') return `documents:${parsed.type}`;
  return parsed.family;
}

/** A document's translation group, or its own id when it was never grouped. */
export function docGroupKey(row: { id: number; translationGroupId: string | null }): string {
  return row.translationGroupId ?? `id-${row.id}`;
}

export interface GroupDef {
  family: GroupFamily;
  label: string;
  /** Write order: lower first. */
  rank: number;
  exportPerms: string[];
  importPerms: string[];
  /** What a conflicting item may do. Empty: conflicts resolve themselves (media dedups by content). */
  actions: TransferAction[];
  defaultAction: TransferAction;
  /** Holds personal data — needs an explicit acknowledgement. */
  pii: boolean;
  /** The module that must be on for this group to exist on a site. */
  module?: string;
}

const table = (
  family: TableFamily,
  label: string,
  rank: number,
  read: string,
  write: string,
  actions: TransferAction[],
  module?: string,
  extra: { pii?: boolean; alsoNeeds?: string } = {}
): GroupDef => ({
  family,
  label,
  rank,
  exportPerms: [PERMISSIONS.transferExport, read, ...(extra.alsoNeeds ? [extra.alsoNeeds] : [])],
  importPerms: [PERMISSIONS.transferImport, write, ...(extra.alsoNeeds ? [extra.alsoNeeds] : [])],
  actions,
  defaultAction: 'skip',
  pii: extra.pii ?? false,
  ...(module ? { module } : {}),
});

const FAMILIES: Record<GroupFamily, GroupDef> = {
  media: {
    family: 'media',
    label: 'Media files',
    rank: 10,
    exportPerms: [PERMISSIONS.transferExport, PERMISSIONS.mediaRead],
    importPerms: [PERMISSIONS.transferImport, PERMISSIONS.mediaWrite],
    actions: [],
    defaultAction: 'skip',
    pii: false,
  },
  settings: {
    family: 'settings',
    label: 'Settings',
    rank: 20,
    exportPerms: [PERMISSIONS.transferExport, PERMISSIONS.settingsRead],
    importPerms: [PERMISSIONS.transferImport, PERMISSIONS.settingsWrite],
    actions: ['skip', 'overwrite', 'merge'],
    defaultAction: 'skip',
    pii: false,
  },
  documents: {
    family: 'documents',
    label: 'Content',
    rank: 40,
    exportPerms: [PERMISSIONS.transferExport, PERMISSIONS.contentRead],
    importPerms: [PERMISSIONS.transferImport, PERMISSIONS.contentWrite],
    actions: ['skip', 'overwrite', 'copy'],
    defaultAction: 'skip',
    pii: false,
  },
  // Configuration is written before content (a page's shortcode can name a
  // script or a review location); cookies before scripts (a script names its
  // consent category). What points AT content — redirects, per-path meta — after.
  cookies: table(
    'cookies',
    'Cookie categories',
    25,
    PERMISSIONS.settingsRead,
    PERMISSIONS.settingsWrite,
    ['skip', 'overwrite']
  ),
  // Code that runs in every visitor's browser: the Scripts screen's own key, both ways.
  scripts: table(
    'scripts',
    'Script snippets',
    30,
    PERMISSIONS.scriptsManage,
    PERMISSIONS.scriptsManage,
    ['skip', 'overwrite', 'copy']
  ),
  shipping: table(
    'shipping',
    'Shipping zones',
    30,
    PERMISSIONS.settingsRead,
    PERMISSIONS.settingsWrite,
    ['skip', 'overwrite', 'copy'],
    'commerce'
  ),
  reviewLocations: table(
    'reviewLocations',
    'Google review locations',
    30,
    PERMISSIONS.settingsRead,
    PERMISSIONS.settingsWrite,
    ['skip', 'overwrite', 'copy'],
    'googleReviews'
  ),
  redirects: table('redirects', 'Redirects', 50, PERMISSIONS.seoRead, PERMISSIONS.seoWrite, [
    'skip',
    'overwrite',
  ]),
  seoMeta: table('seoMeta', 'SEO meta overrides', 50, PERMISSIONS.seoRead, PERMISSIONS.seoWrite, [
    'skip',
    'overwrite',
  ]),
  // Phase C. Written after the content and configuration they point at. Roles
  // and users also need `transferUsers`: an imported account or role is a way
  // to hand someone access, so it is its own decision.
  roles: table(
    'roles',
    'Admin roles',
    60,
    PERMISSIONS.rolesManage,
    PERMISSIONS.rolesManage,
    ['skip', 'overwrite'],
    undefined,
    { alsoNeeds: PERMISSIONS.transferUsers }
  ),
  users: table(
    'users',
    'Admin users',
    61,
    PERMISSIONS.usersManage,
    PERMISSIONS.usersManage,
    ['skip', 'overwrite'],
    undefined,
    { pii: true, alsoNeeds: PERMISSIONS.transferUsers }
  ),
  customers: table(
    'customers',
    'Customer accounts',
    62,
    PERMISSIONS.customersRead,
    PERMISSIONS.customersWrite,
    ['skip', 'overwrite', 'merge'],
    'customers',
    { pii: true }
  ),
  subscribers: table(
    'subscribers',
    'Newsletter subscribers',
    63,
    PERMISSIONS.newsletterRead,
    PERMISSIONS.newsletterWrite,
    ['skip', 'overwrite'],
    'newsletter',
    { pii: true }
  ),
  suppressions: table(
    'suppressions',
    'Email suppressions',
    63,
    PERMISSIONS.newsletterRead,
    PERMISSIONS.newsletterWrite,
    ['skip', 'overwrite'],
    undefined,
    { pii: true }
  ),
  bookingSlots: table(
    'bookingSlots',
    'Availability overrides',
    64,
    PERMISSIONS.scheduleRead,
    PERMISSIONS.scheduleWrite,
    ['skip', 'overwrite'],
    'booking'
  ),
  productReviews: table(
    'productReviews',
    'Product reviews',
    65,
    PERMISSIONS.reviewsRead,
    PERMISSIONS.reviewsWrite,
    ['skip', 'overwrite'],
    'commerce',
    { pii: true }
  ),
  orders: table(
    'orders',
    'Orders',
    70,
    PERMISSIONS.ordersRead,
    PERMISSIONS.ordersWrite,
    ['skip', 'overwrite'],
    'commerce',
    { pii: true }
  ),
  reservations: table(
    'reservations',
    'Reservations',
    75,
    PERMISSIONS.reservationsRead,
    PERMISSIONS.reservationsWrite,
    ['skip', 'overwrite'],
    'booking',
    { pii: true }
  ),
};

export function groupFamily(group: GroupKey): GroupFamily {
  return group.startsWith('documents:') ? 'documents' : (group as GroupFamily);
}

export function groupDef(group: GroupKey): GroupDef {
  return FAMILIES[groupFamily(group)];
}

/**
 * The module a group belongs to, or null for what every site has. A collection
 * belongs to the module it is gated on; one this site does not have belongs to
 * none — switching a module on would not make it appear.
 */
export function moduleOfGroup(
  group: GroupKey,
  collections: ReadonlyMap<string, { module?: string }>
): string | null {
  if (!group.startsWith('documents:')) return groupDef(group).module ?? null;
  return collections.get(group.slice('documents:'.length))?.module ?? null;
}

/** Every group a site has, in write order, whether or not its module is on. */
export function allGroupKeys(
  collections: ReadonlyArray<{ key: string; module?: string }>
): GroupKey[] {
  return [
    'media',
    'settings',
    ...TABLE_FAMILIES,
    ...collections.map((c) => `documents:${c.key}` as GroupKey),
  ];
}

export function isGroupKey(value: string): value is GroupKey {
  return (
    value === 'media' ||
    value === 'settings' ||
    isTableFamily(value) ||
    /^documents:[a-z][a-z0-9_-]*$/i.test(value)
  );
}

export function canExportGroup(granted: readonly string[], group: GroupKey): boolean {
  return groupDef(group).exportPerms.every((p) => hasPerm(granted, p));
}

export function canImportGroup(granted: readonly string[], group: GroupKey): boolean {
  return groupDef(group).importPerms.every((p) => hasPerm(granted, p));
}

/** Rank of an item, for write ordering. Unknown keys sort last. */
export function itemRank(key: string): number {
  const group = groupOfItem(key);
  return group ? groupDef(group).rank : Number.MAX_SAFE_INTEGER;
}

/**
 * Why a selection cannot go ahead without an explicit acknowledgement, or null.
 * A package of customer data leaves the site as a file anyone holding it can
 * read; the person making or loading it must have said so, by group.
 */
export function piiProblem(keys: readonly string[], acknowledged: boolean): string | null {
  if (acknowledged) return null;
  const groups = new Set<string>();
  for (const key of keys) {
    const group = groupOfItem(key);
    if (group && groupDef(group).pii) groups.add(groupDef(group).label);
  }
  if (groups.size === 0) return null;
  return `This includes personal data (${[...groups].join(', ')}). Confirm you are allowed to move it before continuing.`;
}
