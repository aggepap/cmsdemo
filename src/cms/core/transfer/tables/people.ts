/**
 * Phase C rules — people and transactions. Pure.
 *
 * Rows here are keyed by an email or a business reference, which ARE their
 * identity: they are never copied, only skipped, overwritten or (customers)
 * merged. What changes between sites is what they point at — a reservation's
 * experience and its calendar, an order's products and customer, a user's roles.
 */
import { createHash } from 'node:crypto';

import { ALL_PERMISSIONS, hasPerm } from '../../../modules/auth/permissions';

const digest = (...parts: string[]) =>
  createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 24);
const email = (e: string) => e.trim().toLowerCase();

export const peopleKey = {
  customer: (e: string) => `customer:${email(e)}`,
  subscriber: (e: string) => `subscriber:${email(e)}`,
  suppression: (e: string) => `suppression:${email(e)}`,
  order: (reference: string) => `order:${reference}`,
  reservation: (reference: string) => `reservation:${reference}`,
  role: (name: string) => `role:${name}`,
  user: (e: string) => `user:${email(e)}`,
  slot: (slotKey: string, date: string) => `slot:${digest(slotKey, date)}`,
  /** A review has no key of its own: product group + author + moment identifies it. */
  productReview: (productGroupId: string, authorEmail: string, createdAt: string) =>
    `preview:${digest(productGroupId, email(authorEmail), createdAt)}`,
};

export interface BookingMaps {
  /** Source translation group → this site's, or null when the experience is not here. */
  group(sourceGroupId: string): string | null;
  doc(sourceId: number): number | null;
  /** A booking option id that was re-minted (the experience was copied), else null. */
  option(sourceOptionId: string): string | null;
}

/**
 * A calendar key on this site. `exp:<translation group>` follows the
 * experience; `res:<option id>` keeps its id unless the experience was copied
 * (see `global-ids.ts`). Null: the experience is not on this site, so its
 * calendar entry has nothing to belong to.
 */
export function mapSlotKey(slotKey: string, maps: BookingMaps): string | null {
  if (slotKey.startsWith('exp:')) {
    const to = mapBookingGroupId(slotKey.slice(4), maps);
    return to === null ? null : `exp:${to}`;
  }
  if (slotKey.startsWith('res:')) {
    const id = slotKey.slice(4);
    return `res:${maps.option(id) ?? id}`;
  }
  return slotKey;
}

/** A reservation's `booking_group_id`: a translation group, or `doc:<id>` for an ungrouped experience. */
export function mapBookingGroupId(groupId: string, maps: BookingMaps): string | null {
  const m = /^doc:(\d+)$/.exec(groupId);
  if (m) {
    const to = maps.doc(Number(m[1]));
    return to === null ? null : `doc:${to}`;
  }
  return maps.group(groupId);
}

/** Merge: keep every value this site has; fill only what it lacks. */
export function fillMissing(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    if ((out[k] === null || out[k] === undefined || out[k] === '') && v !== undefined) out[k] = v;
  }
  return out;
}

const KNOWN = new Set<string>(ALL_PERMISSIONS);
/** A permission this CMS knows: a key, `*`, or a prefix wildcard covering at least one key. */
function isKnown(p: string): boolean {
  if (p === '*' || KNOWN.has(p)) return true;
  if (p.endsWith('*')) {
    const prefix = p.slice(0, -1);
    return ALL_PERMISSIONS.some((k) => k.startsWith(prefix));
  }
  return false;
}

/**
 * The permissions of an imported role or user, against the importer's own:
 * unknown keys are dropped (another CMS version), and anything the importer
 * does not hold is refused — nobody can grant what they do not have, by import
 * any more than on the Roles screen.
 */
export function checkGrantable(
  permissions: readonly string[],
  granted: readonly string[]
): { kept: string[]; unknown: string[]; refused: string[] } {
  const kept: string[] = [];
  const unknown: string[] = [];
  const refused: string[] = [];
  for (const p of permissions) {
    if (!isKnown(p)) unknown.push(p);
    else if (
      p === '*'
        ? granted.includes('*')
        : hasPerm(granted, p) && (!p.endsWith('*') || granted.some((g) => g === '*' || g === p))
    )
      kept.push(p);
    else refused.push(p);
  }
  return { kept, unknown, refused };
}

export type PeopleDep =
  | { kind: 'doc'; value: number }
  | { kind: 'customer'; value: string }
  | { kind: 'zone'; value: string }
  | { kind: 'role'; value: string };

type Rec = Record<string, unknown>;
const list = (v: unknown): Rec[] =>
  Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object') : [];
const docSid = (v: unknown): PeopleDep[] =>
  typeof v === 'number' && Number.isInteger(v) ? [{ kind: 'doc', value: v }] : [];

/** What a row needs to come along with it. */
export function peopleDeps(family: PeopleFamily, r: Rec): PeopleDep[] {
  switch (family) {
    case 'customers':
      return list(r.wishlist).flatMap((w) => docSid(w.productSid));
    case 'orders': {
      const out: PeopleDep[] = [];
      if (typeof r.customerEmail === 'string' && r.customerEmail)
        out.push({ kind: 'customer', value: email(r.customerEmail) });
      const ref = r.shippingMethodRef as Rec | null | undefined;
      if (ref && typeof ref.zone === 'string') out.push({ kind: 'zone', value: ref.zone });
      out.push(...list(r.items).flatMap((i) => docSid(i.productSid)));
      return out;
    }
    case 'reservations':
      return [...docSid(r.bookingSid), ...docSid(r.resourceSid)];
    case 'bookingSlots':
    case 'productReviews':
      return [...docSid(r.bookingSid), ...docSid(r.productSid)];
    case 'users':
      return (Array.isArray(r.roles) ? r.roles : [])
        .filter((n): n is string => typeof n === 'string')
        .map((n) => ({ kind: 'role' as const, value: n }));
    case 'subscribers':
    case 'suppressions':
    case 'roles':
      return [];
  }
}

const PEOPLE = [
  'customers',
  'subscribers',
  'suppressions',
  'productReviews',
  'orders',
  'reservations',
  'bookingSlots',
  'roles',
  'users',
] as const;
export type PeopleFamily = (typeof PEOPLE)[number];

export function isPeopleFamily(f: string): f is PeopleFamily {
  return (PEOPLE as readonly string[]).includes(f);
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** The key a record must carry — checked at analysis and again when written. */
export function peopleRecordKey(family: PeopleFamily, r: Rec): string {
  switch (family) {
    case 'customers':
      return peopleKey.customer(s(r.email));
    case 'subscribers':
      return peopleKey.subscriber(s(r.email));
    case 'suppressions':
      return peopleKey.suppression(s(r.email));
    case 'orders':
      return peopleKey.order(s(r.reference));
    case 'reservations':
      return peopleKey.reservation(s(r.reference));
    case 'roles':
      return peopleKey.role(s(r.name));
    case 'users':
      return peopleKey.user(s(r.email));
    case 'bookingSlots':
      return peopleKey.slot(s(r.slotKey), s(r.slotDate));
    case 'productReviews':
      return peopleKey.productReview(s(r.productGroupId), s(r.email), s(r.createdAt));
  }
}

export function peopleLabel(family: PeopleFamily, r: Rec): string {
  switch (family) {
    case 'customers':
    case 'users':
      return r.name ? `${s(r.name)} <${s(r.email)}>` : s(r.email);
    case 'subscribers':
    case 'suppressions':
      return s(r.email);
    case 'orders':
      return `${s(r.reference)} · ${s(r.email)}`;
    case 'reservations':
      return `${s(r.reference)} · ${s(r.bookingTitle)} · ${s(r.slotDate)}`;
    case 'roles':
      return s(r.name);
    case 'bookingSlots':
      return `${s(r.slotKey)} · ${s(r.slotDate)}`;
    case 'productReviews':
      return `${s(r.authorName)}: ${s(r.title) || s(r.body).slice(0, 40)}`;
  }
}
