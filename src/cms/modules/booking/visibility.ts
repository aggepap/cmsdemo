/**
 * Hidden prices (G1) and requests without a payment step (G2) — the rules, pure.
 *
 * Two switches in Settings → Booking, read by `getBookingPolicy()`:
 *
 * - `booking.hidePrices` — no amount reaches a visitor or a customer. The team
 *   (admin, team emails) still sees every price.
 * - `booking.requestOnly` — accepting a request confirms it. No payment link,
 *   no pay page, no payment instructions.
 *
 * No imports, so the admin drawer and the public form can share these with the
 * server: which button "Accept" is, and what the customer may see, are each
 * decided in one place.
 */

export interface BookingPolicy {
  hidePrices: boolean;
  requestOnly: boolean;
}

/** Only exactly `on` switches either on — an unsaved setting never does. */
export function readBookingPolicy(rawHidePrices: unknown, rawRequestOnly: unknown): BookingPolicy {
  return { hidePrices: rawHidePrices === 'on', requestOnly: rawRequestOnly === 'on' };
}

/**
 * The flow a new booking follows. Either switch makes it a request: an instant
 * booking would charge an amount the customer was never shown, or ask for a
 * payment the site does not take.
 */
export function entryMode(
  itemMode: unknown,
  siteMode: 'request' | 'instant',
  policy: BookingPolicy
): 'request' | 'instant' {
  if (policy.hidePrices || policy.requestOnly) return 'request';
  return itemMode === 'request' || itemMode === 'instant' ? itemMode : siteMode;
}

/**
 * Whether a pricing refusal is really "this is quoted by hand" — an experience
 * with no price, on a site that says so. Stored as a request with a total of 0.
 */
export function takesUnpricedRequests(reason: string, policy: BookingPolicy): boolean {
  return reason === 'price_on_request' && (policy.hidePrices || policy.requestOnly);
}

/**
 * Why this booking cannot be asked to pay, or null when it can. A requests-only
 * site never asks; a booking with no price has nothing to ask for.
 */
export function paymentStepRefusal(policy: BookingPolicy, total: number): string | null {
  if (policy.requestOnly) {
    return 'This site takes requests only (Settings → Booking): bookings are confirmed without a payment step.';
  }
  if (!(total > 0))
    return 'This booking has no price, so there is nothing to pay — confirm it instead.';
  return null;
}

/** Where "Accept" takes a pending request. */
export function acceptTarget(
  policy: BookingPolicy,
  total: number
): 'awaiting_payment' | 'confirmed' {
  return paymentStepRefusal(policy, total) ? 'confirmed' : 'awaiting_payment';
}

/* ── What a customer is sent ─────────────────────────────────────────────── */

/**
 * The public quote without money: the selection still validates (and a refusal
 * keeps its reason, so the form can say "minimum 3 nights"), but no total, no
 * line and no currency leaves the server.
 */
export function withoutQuotePrices<T extends { quote: { ok: boolean }; currency?: string }>(
  body: T,
  hide: boolean
): T {
  if (!hide) return body;
  const { currency: _currency, ...rest } = body;
  void _currency;
  if (!body.quote.ok) return rest as T;
  const quote = body.quote as { ok: true; persons?: number };
  return { ...rest, quote: { ok: true, persons: quote.persons } } as unknown as T;
}

/** The answer to a booking request, without `total` and `currency`. */
export function publicRequestResult<T extends { total?: number; currency?: string }>(
  result: T,
  hide: boolean
): T | Omit<T, 'total' | 'currency'> {
  if (!hide) return result;
  const { total: _total, currency: _currency, ...rest } = result;
  void _total;
  void _currency;
  return rest;
}

/** The guest lookup: what was booked, without amounts. Line labels stay — "Champagne × 2" is not a price. */
export function publicLookup<
  T extends {
    currency?: string;
    total?: number;
    amountPaid?: number;
    items?: { label: string; quantity: number }[];
  },
>(found: T, hide: boolean): T | Record<string, unknown> {
  if (!hide) return found;
  const { currency: _c, total: _t, amountPaid: _p, items, ...rest } = found;
  void _c;
  void _t;
  void _p;
  return { ...rest, items: (items ?? []).map((i) => ({ label: i.label, quantity: i.quantity })) };
}

/** Listing cards without their "from" price — the card then reads "on request". */
export function withoutListingPrices<T extends { fromPrice: number | null }>(
  items: T[],
  hide: boolean
): T[] {
  return hide ? items.map((i) => ({ ...i, fromPrice: null })) : items;
}

/** A price sort orders by the hidden prices, which would reveal them; it falls back to the title. */
export function visibleSort<S extends string | undefined>(sort: S, hide: boolean): S | 'title-asc' {
  return hide && sort?.startsWith('price-') ? 'title-asc' : sort;
}
