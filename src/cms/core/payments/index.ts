/**
 * The provider-agnostic payment seam.
 *
 * Promoted out of the commerce module when booking needed the same interface:
 * both modules must work with the other switched off, so neither can own the
 * contract. Core owns the interface and the registry; each module keeps its own
 * payment ROWS (`payments` for orders, `reservation_payments` for bookings),
 * because those genuinely differ.
 *
 * Registered providers live in sibling files (`stripe.ts`, `paypal.ts`,
 * `viva.ts`, `klarna.ts`) and are
 * attached by `register.ts`, which every route that resolves a provider imports
 * for its side effect. To add another:
 *   1. implement `PaymentProvider.start()` — create an intent, return a redirect
 *      URL, a client secret, and/or a provider ref,
 *   2. register it in `register.ts`,
 *   3. add its key to the relevant module's provider setting options,
 *   4. teach the webhook route its events.
 *
 * Pure data and functions — no DB, no `server-only`, no provider SDK — so a
 * module can import it without dragging in a database connection, and so the
 * admin settings form can reach it from the client. The provider files are
 * where secrets and network calls live; this file must stay importable
 * anywhere.
 */

export const PAYMENT_STATUSES = ['pending', 'authorized', 'captured', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Which module a payment belongs to.
 *
 * Carried through the provider (Stripe metadata, PayPal `custom_id`) and back
 * on the webhook, because one endpoint per provider serves both modules — the
 * gateway dashboard should not need a separate URL per feature.
 */
export const PAYMENT_SUBJECTS = ['order', 'reservation'] as const;
export type PaymentSubject = (typeof PAYMENT_SUBJECTS)[number];

/**
 * One line of what a payment is for, VAT included.
 *
 * For gateways that itemise (Klarna). The lines of a payment add up to its
 * `amount`; a negative line is a reduction (discount) or a credit (gift card).
 * `vatRate` is the rate CONTAINED in `totalAmount`, in basis points (2400 =
 * 24%) — prices in this codebase are VAT-inclusive throughout.
 */
export interface PaymentLine {
  type: 'physical' | 'digital' | 'shipping_fee' | 'discount' | 'surcharge' | 'gift_card';
  name: string;
  /** SKU or booking reference, when there is one. */
  reference?: string;
  quantity: number;
  /** Minor units, VAT included. */
  unitPrice: number;
  /** Minor units, VAT included: `unitPrice × quantity`. */
  totalAmount: number;
  /** Basis points. */
  vatRate: number;
}

export interface PaymentStartContext {
  /** Which module owns `subjectId` — an order, or a reservation. */
  subject: PaymentSubject;
  /** What is being paid for — an order id or a reservation id. */
  subjectId: number;
  /** The customer-facing reference, for the provider's own records. */
  reference: string;
  /** Amount in minor units (cents). */
  amount: number;
  currency: string;
  email: string;
  /** Where to send the customer afterwards, when the provider is hosted. */
  returnUrl?: string;
  /** The customer's page language (`el`, `en`), for hosted pages that localise. */
  locale?: string;
  /** What is being paid for, itemised with VAT. Optional — gateways that do not itemise ignore it. */
  lines?: PaymentLine[];
}

export interface PaymentStartResult {
  status: PaymentStatus;
  /** External payment/charge id, when the provider issues one. */
  providerRef?: string;
  /** URL to send the customer to; null for offline/manual settlement. */
  redirectUrl?: string | null;
  /**
   * Confirmation token for an in-page form (Stripe's Payment Element). Set
   * instead of `redirectUrl` by providers that collect details on our own page.
   * The two are alternatives: the caller mounts a form, or it navigates.
   */
  clientSecret?: string;
  method?: string;
  error?: string;
  /**
   * Stored on the payment row as it is written. For what a later step needs
   * and only `start()` knows — Klarna keeps the return URL here, because its
   * return route must not take a redirect target from the query string.
   */
  metadata?: Record<string, unknown>;
}

export interface PaymentRefundContext {
  /** The `providerRef` recorded when the money was taken. */
  providerRef: string;
  /** Minor units. Omit for a full refund. */
  amount?: number;
  currency: string;
  reason?: string;
}

export interface PaymentRefundResult {
  status: 'refunded' | 'failed';
  /** The refund's own id, distinct from the payment's. */
  providerRef?: string;
  error?: string;
}

export interface PaymentProvider {
  key: string;
  label: string;
  /**
   * Begin a payment. Manual/offline records a pending payment and returns no
   * redirect; a hosted provider creates an intent and returns one.
   */
  start(ctx: PaymentStartContext): Promise<PaymentStartResult>;
  /**
   * Send the money back. Optional: `manual` has nothing to call, and a provider
   * without it is refunded out of band, so callers must check before offering
   * the action rather than assume.
   */
  refund?(ctx: PaymentRefundContext): Promise<PaymentRefundResult>;
  /**
   * Close a payment session that was started but never paid, so the customer
   * can no longer pay into an order or booking that has closed. Optional: only
   * providers whose sessions outlive our own timeouts need it (Klarna's hosted
   * page lives ~47 hours). Throws when the gateway refuses; callers treat it as
   * best effort (see `closePaymentSessions`).
   */
  cancel?(providerRef: string): Promise<void>;
}

/**
 * The default: settle out of band — bank transfer, cash on arrival.
 *
 * This is what makes "pay later" and "instant booking" both work with no
 * gateway configured. The date is genuinely taken either way; only the money
 * moves differently.
 *
 * Bookings still use it. The shop used to as well, which is why order rows can
 * carry `manual`; it now offers `bank_transfer` and `cod` instead (below), and a
 * stored shop setting of `manual` reads as both (`SHOP_PAYMENT_PROVIDER_RULES`).
 */
export const manualProvider: PaymentProvider = {
  key: 'manual',
  label: 'Manual / bank transfer',
  async start() {
    return { status: 'pending', redirectUrl: null };
  },
};

/**
 * The shop's two offline methods, told apart because they are different
 * promises: a bank transfer is paid BEFORE the parcel leaves (the order waits
 * until an admin marks it paid), cash on delivery is collected by the courier
 * when it arrives. Only the second narrows the couriers to COD-capable ones,
 * carries the COD surcharge and puts an amount on the voucher.
 */
export const bankTransferProvider: PaymentProvider = {
  key: 'bank_transfer',
  label: 'Bank transfer',
  async start() {
    return { status: 'pending', redirectUrl: null };
  },
};

export const cashOnDeliveryProvider: PaymentProvider = {
  key: 'cod',
  label: 'Cash on delivery',
  async start() {
    return { status: 'pending', redirectUrl: null };
  },
};

/** Every provider that takes no money online. Legacy `manual` stays for its old rows. */
export const OFFLINE_PROVIDER_KEYS: readonly string[] = [
  manualProvider.key,
  bankTransferProvider.key,
  cashOnDeliveryProvider.key,
];

const PROVIDERS: Record<string, PaymentProvider> = {
  [manualProvider.key]: manualProvider,
  [bankTransferProvider.key]: bankTransferProvider,
  [cashOnDeliveryProvider.key]: cashOnDeliveryProvider,
};

/** Add a provider to the registry. Idempotent by key — last registration wins. */
export function registerPaymentProvider(provider: PaymentProvider): void {
  PROVIDERS[provider.key] = provider;
}

export function paymentProviderKeys(): string[] {
  return Object.keys(PROVIDERS);
}

/** Resolve a provider by key, falling back to manual rather than throwing. */
export function getPaymentProvider(key?: string | null): PaymentProvider {
  return (key && PROVIDERS[key]) || manualProvider;
}

/** Does this provider actually take money online? */
export function isOnlineProvider(provider: PaymentProvider): boolean {
  return !OFFLINE_PROVIDER_KEYS.includes(provider.key);
}

/**
 * Is this method paid to the courier on delivery?
 *
 * Only `cod`. Legacy `manual` deliberately is not: a shop checkout no longer
 * resolves it (the setting migrates it), and bookings — its remaining user —
 * have no courier. A `manual` order placed before the split already carries
 * the `codAmount` it was given then.
 */
export function isCashOnDelivery(key: string): boolean {
  return key === cashOnDeliveryProvider.key;
}

/** Can this provider send money back without someone visiting a bank? */
export function canRefundOnline(provider: PaymentProvider): boolean {
  return typeof provider.refund === 'function';
}

/**
 * Encode the subject for providers that give us one opaque string to round-trip
 * (PayPal's `custom_id`). Stripe gets structured metadata instead and does not
 * need this.
 */
export function encodePaymentSubject(subject: PaymentSubject, subjectId: number): string {
  return `${subject}:${subjectId}`;
}

/** Inverse of `encodePaymentSubject`. Returns null for anything unrecognised. */
export function decodePaymentSubject(
  value: string | null | undefined,
): { subject: PaymentSubject; subjectId: number } | null {
  if (!value) return null;
  const [subject, rawId] = value.split(':');
  if (!PAYMENT_SUBJECTS.includes(subject as PaymentSubject)) return null;
  const subjectId = Number(rawId);
  // A non-numeric or non-positive id is a malformed reference, not a lookup
  // that happens to miss — treat it the same as an unknown subject.
  if (!Number.isInteger(subjectId) || subjectId <= 0) return null;
  return { subject: subject as PaymentSubject, subjectId };
}
