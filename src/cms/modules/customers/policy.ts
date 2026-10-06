/**
 * What a customer account is allowed to be, with no database in sight.
 *
 * Everything here is pure so the rules that matter — who may claim which
 * orders, what leaves the server, what survives a deletion — are testable
 * directly rather than through a request.
 */
import { auditSubjectId } from '../../core/audit-subject';

import type {
  CustomerAddressRecord,
  CustomerRecord,
  CustomerStatus,
} from '../../db/adapters/mysql/schema/customers';

export type CustomerRow = CustomerRecord;
export type CustomerAddressRow = CustomerAddressRecord;
export type { CustomerStatus };

/**
 * One person, one account. Lowercased and trimmed, and nothing else: stripping
 * dots or `+tags` would decide that two addresses are the same person, which is
 * a provider-specific rule and merges two real people when it is wrong.
 */
export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Per-address lockout on the storefront sign-in: how many failures, over how
 * long, before an address is refused whoever is asking. The same numbers as the
 * admin login (`core/routes/auth.ts`) — far above what a shopper mistyping their
 * own password produces, far below what guessing one needs.
 */
export const CUSTOMER_LOGIN_LOCKOUT = {
  maxFailures: 10,
  windowMs: 15 * 60 * 1000,
} as const;

/**
 * Whether an address with this many recent failures may try a password at all.
 *
 * Decided on the count alone — never on whether an account exists — so the
 * refusal is the same for a stranger's address as for a customer's. A count
 * that is not a sane number (it arrives from a database driver) locks nobody
 * out: the throttle failing open is a degraded defence, failing closed is an
 * outage of every sign-in.
 */
export function isCustomerLoginLocked(recentFailures: number): boolean {
  if (!Number.isFinite(recentFailures) || recentFailures < 0) return false;
  return recentFailures >= CUSTOMER_LOGIN_LOCKOUT.maxFailures;
}

/**
 * The key the lockout records failures under, and counts by: the normalised
 * address, or a digest of it when it would not fit the audit column.
 *
 * A customer address may be 191 characters and the column holds 64. A row that
 * does not fit is never written (`logAudit` swallows the error), and a failure
 * that is never written is never counted — so without this, a long address
 * could be guessed at without limit. Short addresses stay readable in the audit
 * screen; the digest form has no `@`, so no real address can collide with it.
 */
export function customerLoginSubject(email: string): string {
  return auditSubjectId(normalizeCustomerEmail(email));
}

/** An account that may sign in at all. */
export function isActiveCustomer(customer: Pick<CustomerRow, 'status' | 'deletedAt'>): boolean {
  return customer.status === 'active' && customer.deletedAt === null;
}

/**
 * Whether guest orders placed with this address may be attached to the account.
 *
 * Verification is the whole protection: anyone can type someone else's email at
 * registration, and an unverified claim would hand them that person's order
 * history — addresses, items and totals.
 */
export function canClaimGuestOrders(
  customer: Pick<CustomerRow, 'status' | 'deletedAt' | 'emailVerifiedAt'>
): boolean {
  return isActiveCustomer(customer) && customer.emailVerifiedAt !== null;
}

export interface PublicCustomer {
  id: number;
  email: string;
  name: string | null;
  phone: string | null;
  locale: string;
  emailVerified: boolean;
  marketingOptIn: boolean;
  createdAt: string;
}

/** The only shape of a customer that crosses to the browser. */
export function publicCustomer(customer: CustomerRow): PublicCustomer {
  return {
    id: customer.id,
    email: customer.email,
    name: customer.name,
    phone: customer.phone,
    locale: customer.locale,
    emailVerified: customer.emailVerifiedAt !== null,
    marketingOptIn: customer.marketingOptIn,
    createdAt: customer.createdAt.toISOString(),
  };
}

/**
 * The default flags across a customer's addresses after one of them was saved.
 *
 * Exactly one default of each kind can survive, and the very first address
 * becomes the default for both — otherwise a customer with a single address has
 * no default and checkout has nothing to prefill.
 */
export function applyDefaultAddressFlags<T extends CustomerAddressRow>(
  addresses: T[],
  savedId: number,
  wanted: { shipping?: boolean; billing?: boolean }
): T[] {
  const onlyOne = addresses.length === 1 && addresses[0].id === savedId;
  const shipping = wanted.shipping || onlyOne;
  const billing = wanted.billing || onlyOne;
  return addresses.map((address) => ({
    ...address,
    isDefaultShipping: shipping ? address.id === savedId : address.isDefaultShipping,
    isDefaultBilling: billing ? address.id === savedId : address.isDefaultBilling,
  }));
}

/**
 * How many addresses one account may keep. A cap rather than no cap because
 * "add address" is an authenticated endpoint that writes a row every time it is
 * called, and nobody has forty delivery addresses.
 */
export const MAX_CUSTOMER_ADDRESSES = 20;

export function canAddAddress(currentCount: number): boolean {
  return currentCount < MAX_CUSTOMER_ADDRESSES;
}

export interface CustomerExportOrderItem {
  name: string;
  sku: string | null;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CustomerExportOrder {
  reference: string;
  createdAt: Date;
  total: number;
  currency: string;
  status: string;
  email?: string;
  customerName?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  items?: CustomerExportOrderItem[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * The personal part of an order: who it went to and where. Read field by field
 * from the snapshot, for the same reason as the export as a whole — a key added
 * to order metadata later is not published by accident.
 */
function orderDelivery(o: CustomerExportOrder) {
  const shipping = (o.metadata?.shipping ?? {}) as Record<string, unknown>;
  const method = (shipping.shippingMethod ?? null) as { name?: unknown } | null;
  return {
    name: o.customerName ?? null,
    email: o.email ?? null,
    phone: text(shipping.phone),
    address1: text(shipping.address1),
    city: text(shipping.city),
    postal: text(shipping.postal),
    country: text(shipping.country),
    method: text(method?.name),
  };
}

/**
 * Everything the shop holds about one person, as the GDPR right of access
 * requires — and nothing about anybody else. Built from rows rather than
 * serialising them, so a column added later is not published by accident.
 */
export function buildCustomerExport(
  customer: CustomerRow,
  addresses: CustomerAddressRow[],
  orders: CustomerExportOrder[],
  at: Date
) {
  return {
    exportedAt: at.toISOString(),
    account: publicCustomer(customer),
    addresses: addresses.map((a) => ({
      label: a.label,
      name: a.name,
      phone: a.phone,
      address1: a.address1,
      address2: a.address2,
      city: a.city,
      postal: a.postal,
      country: a.country,
      isDefaultShipping: a.isDefaultShipping,
      isDefaultBilling: a.isDefaultBilling,
    })),
    orders: orders.map((o) => ({
      reference: o.reference,
      placedAt: o.createdAt.toISOString(),
      total: o.total,
      currency: o.currency,
      status: o.status,
      items: (o.items ?? []).map((i) => ({
        name: i.name,
        sku: i.sku,
        variant: i.variantLabel,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      })),
      delivery: orderDelivery(o),
      notes: o.notes ?? null,
      giftMessage: text((o.metadata?.gift as { message?: unknown } | undefined)?.message),
    })),
  };
}

/**
 * What a deleted account becomes.
 *
 * The row stays, because the orders reference it and an order is a business
 * record with its own retention period. What goes is the person: name, phone,
 * password, and an email replaced by one nobody can sign in as — unique, so a
 * second deletion cannot collide on the unique index. The token version moves
 * on, which kills every session the account still had open.
 */
export function anonymisedCustomer(customer: CustomerRow, at: Date) {
  return {
    email: `deleted+${customer.id}-${at.getTime()}@invalid.local`,
    name: null,
    phone: null,
    passwordHash: null,
    marketingOptIn: false,
    status: 'disabled' as CustomerStatus,
    tokenVersion: customer.tokenVersion + 1,
    deletedAt: at,
  };
}
