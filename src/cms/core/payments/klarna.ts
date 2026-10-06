/**
 * Klarna provider — Klarna Payments through the Hosted Payment Page (HPP).
 *
 * Integrated on Klarna's own API and never through Stripe: Greek sites cannot
 * rely on Stripe (it has no IRIS), so Klarna must work next to whatever else a
 * site takes — Viva, PayPal, bank transfer.
 *
 * `start()` opens a Klarna Payments session, wraps it in an HPP session with
 * `place_order_mode: CAPTURE_ORDER`, and returns the HPP link. The customer
 * pays on Klarna's pages; Klarna places AND captures the order itself, so there
 * is no create-order or capture call on our side. The money is only ours once
 * we have re-read the session and the Klarna order and they agree with what we
 * charged, so `start()` reports `pending`.
 *
 * Two things shape the rest, and both mirror the Viva integration:
 *
 *  1. **The status callback is unsigned.** Klarna's only advice is HTTPS and to
 *     re-read the session over the authenticated API. So the callback body is
 *     treated as a hint naming a session, and `klarnaOutcome` decides from what
 *     `readKlarnaSession` and `readKlarnaOrder` return — never from the body.
 *  2. **Callbacks can be lost** (Klarna retries three times, then gives up).
 *     The success redirect therefore goes through our own return route, which
 *     runs the same reconciliation before sending the customer on. That route
 *     takes no redirect target from the URL: the return URL is stored on the
 *     payment row at start (`metadata.returnUrl`) and checked by
 *     `klarnaReturnTarget`.
 *
 * Refunds go through Order Management against the Klarna ORDER id, which the
 * reconciliation records as `metadata.klarnaOrderId`; the row itself is keyed
 * by the HPP session id (see `refundTargetRef`).
 *
 * The session is itemised from `ctx.lines` — products, shipping, discounts,
 * gift cards — each with the VAT it contains (see `buildKlarnaPaymentSession`).
 * Lines that do not add up fall back to one line for the total.
 *
 * Immediate capture (`CAPTURE_ORDER`) is restricted by Klarna's merchant
 * agreement to digital goods, services and fulfilment within 24 hours unless
 * Klarna approves it otherwise — check the contract before going live.
 *
 * Required env (server-only — never `NEXT_PUBLIC_`):
 *   KLARNA_USERNAME / KLARNA_PASSWORD — the API credentials from the Klarna
 *                                        Merchant Portal (HTTP Basic)
 *   KLARNA_ENV                         — `playground` (default) or `live`
 *   KLARNA_PURCHASE_COUNTRY            — ISO alpha-2, default `GR`
 */
import 'server-only';

import { siteOrigin } from '../paths';

import {
  type PaymentLine,
  type PaymentProvider,
  type PaymentRefundContext,
  type PaymentRefundResult,
  type PaymentStartContext,
  type PaymentStartResult,
} from './index';

export const KLARNA_PROVIDER_KEY = 'klarna';

/** Where the HPP status callback is posted, relative to the site origin. */
const CALLBACK_PATH = '/api/cms/payments/webhooks/klarna';
/** Where Klarna sends the customer after paying, relative to the site origin. */
const RETURN_PATH = '/api/cms/payments/webhooks/klarna/return';

/**
 * EU API host. Anything other than an explicit `live` stays on the playground —
 * defaulting the other way would let a missing variable quietly move real money.
 */
export function klarnaApiBase(): string {
  return process.env.KLARNA_ENV === 'live'
    ? 'https://api.klarna.com'
    : 'https://api.playground.klarna.com';
}

function readCredentials(): { username: string; password: string } {
  const username = process.env.KLARNA_USERNAME;
  const password = process.env.KLARNA_PASSWORD;
  const missing = [
    ['KLARNA_USERNAME', username],
    ['KLARNA_PASSWORD', password],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) throw new Error(`Missing Klarna env vars: ${missing.join(', ')}`);
  return { username: username!, password: password! };
}

function purchaseCountry(): string {
  const raw = process.env.KLARNA_PURCHASE_COUNTRY?.trim().toUpperCase();
  return raw && /^[A-Z]{2}$/.test(raw) ? raw : 'GR';
}

/**
 * Klarna's locale for a page language. Klarna refuses a locale that does not
 * match the purchase country, so the country half always follows it. Greek
 * pages get Greek; anything else gets English, which Klarna offers everywhere.
 */
export function klarnaLocale(locale: string | undefined, country: string): string {
  return `${locale?.toLowerCase().startsWith('el') ? 'el' : 'en'}-${country}`;
}

export interface KlarnaOrderLine {
  type?: PaymentLine['type'];
  name: string;
  reference?: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  tax_rate: number;
  total_tax_amount: number;
}

export interface KlarnaPaymentSessionBody {
  purchase_country: string;
  purchase_currency: string;
  locale: string;
  intent: 'buy';
  order_amount: number;
  order_tax_amount: number;
  order_lines: KlarnaOrderLine[];
  merchant_reference1: string;
  merchant_reference2: string;
}

/**
 * The VAT contained in a VAT-inclusive amount, in minor units — Klarna's own
 * check: `total − total × 10000 / (10000 + rate)`, to within a cent. Rounded
 * symmetrically, so a discount's VAT is exactly the negative of the same
 * positive amount's.
 */
export function vatIncluded(totalMinor: number, rateBps: number): number {
  if (rateBps <= 0) return 0;
  const abs = Math.abs(totalMinor);
  const vat = Math.round(abs - (abs * 10_000) / (10_000 + rateBps));
  return totalMinor < 0 ? -vat : vat;
}

/** Payment lines as Klarna order lines, tax worked out per line. */
export function klarnaOrderLines(lines: readonly PaymentLine[]): KlarnaOrderLine[] {
  return lines.map((line) => ({
    type: line.type,
    name: line.name,
    ...(line.reference ? { reference: line.reference } : {}),
    quantity: line.quantity,
    unit_price: line.unitPrice,
    total_amount: line.totalAmount,
    tax_rate: line.vatRate,
    total_tax_amount: vatIncluded(line.totalAmount, line.vatRate),
  }));
}

/**
 * The Klarna Payments session for one payment.
 *
 * Itemised with VAT when the caller sent lines (`ctx.lines`) that add up to the
 * amount. Lines that do not would be refused by Klarna outright, losing the
 * sale over a rounding slip, so they fall back — with a log line — to the
 * single untaxed line for the total that is always valid.
 */
export function buildKlarnaPaymentSession(
  ctx: PaymentStartContext,
  opts: { country: string }
): KlarnaPaymentSessionBody {
  const lines = ctx.lines?.length ? klarnaOrderLines(ctx.lines) : null;
  const itemised =
    lines && lines.reduce((sum, l) => sum + l.total_amount, 0) === ctx.amount ? lines : null;
  if (lines && !itemised) {
    console.error(
      `[cms/payments] klarna lines for ${ctx.reference} do not add up to ${ctx.amount}; sending one line`
    );
  }
  const orderLines: KlarnaOrderLine[] = itemised ?? [
    {
      name: ctx.reference,
      quantity: 1,
      unit_price: ctx.amount,
      total_amount: ctx.amount,
      tax_rate: 0,
      total_tax_amount: 0,
    },
  ];
  return {
    purchase_country: opts.country,
    purchase_currency: ctx.currency.toUpperCase(),
    locale: klarnaLocale(ctx.locale, opts.country),
    intent: 'buy',
    order_amount: ctx.amount,
    order_tax_amount: orderLines.reduce((sum, l) => sum + l.total_tax_amount, 0),
    order_lines: orderLines,
    // Reference 1 is what the Klarna portal and the customer's app show;
    // reference 2 is for a human tracing a payment back to its module.
    merchant_reference1: ctx.reference,
    merchant_reference2: `${ctx.subject}:${ctx.subjectId}`,
  };
}

export interface KlarnaHppSessionBody {
  payment_session_url: string;
  merchant_urls: {
    success: string;
    cancel: string;
    back: string;
    failure: string;
    error: string;
    status_update: string;
  };
  options: { place_order_mode: 'CAPTURE_ORDER' };
}

/**
 * The hosted page around a payment session.
 *
 * `{{session_id}}` is left for Klarna to fill in — it is the HPP session id,
 * which is what `start()` records as the payment's `provider_ref`. Every way
 * out that is not a success lands the customer back where they started.
 */
export function buildKlarnaHppSession(args: {
  paymentSessionId: string;
  returnUrl: string;
  origin: string;
}): KlarnaHppSessionBody {
  return {
    payment_session_url: `${klarnaApiBase()}/payments/v1/sessions/${args.paymentSessionId}`,
    merchant_urls: {
      success: `${args.origin}${RETURN_PATH}?sid={{session_id}}`,
      cancel: args.returnUrl,
      back: args.returnUrl,
      failure: args.returnUrl,
      error: args.returnUrl,
      status_update: `${args.origin}${CALLBACK_PATH}?sid={{session_id}}`,
    },
    options: { place_order_mode: 'CAPTURE_ORDER' },
  };
}

/** How long any one Klarna call may take. */
const KLARNA_TIMEOUT_MS = 10_000;

/** An authenticated call to Klarna. Throws only on a network failure or missing credentials. */
async function klarnaFetch(
  path: string,
  init: { method: string; body?: unknown; idempotencyKey?: string }
): Promise<Response> {
  const { username, password } = readCredentials();
  return fetch(`${klarnaApiBase()}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(init.idempotencyKey ? { 'Klarna-Idempotency-Key': init.idempotencyKey } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    // A hung Klarna must not hold a checkout, a cancellation or the stale-order
    // job; the callers already treat a thrown call as "could not reach Klarna".
    signal: AbortSignal.timeout(KLARNA_TIMEOUT_MS),
  });
}

/** A Klarna JSON response, or throw with the status — for reads, where there is no "failed" to report. */
async function klarnaRead<T>(path: string): Promise<T> {
  const res = await klarnaFetch(path, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) throw new Error(`Klarna GET ${path} failed (${res.status}): ${text}`);
  return JSON.parse(text) as T;
}

export interface KlarnaSessionState {
  status?: string;
  /** Set once Klarna has placed the order (`PLACE_ORDER` / `CAPTURE_ORDER`). */
  order_id?: string;
}

export interface KlarnaOrderState {
  status?: string;
  captured_amount?: number;
  refunded_amount?: number;
  purchase_currency?: string;
}

/** The HPP session as Klarna holds it — the only authority on how it ended. */
export function readKlarnaSession(sessionId: string): Promise<KlarnaSessionState> {
  return klarnaRead<KlarnaSessionState>(`/hpp/v1/sessions/${encodeURIComponent(sessionId)}`);
}

/** The Klarna order as Order Management holds it — what was actually captured. */
export function readKlarnaOrder(orderId: string): Promise<KlarnaOrderState> {
  return klarnaRead<KlarnaOrderState>(`/ordermanagement/v1/orders/${encodeURIComponent(orderId)}`);
}

/** HPP statuses the customer cannot come back from. FAILED, BACK and ERROR can still be retried. */
const FINAL_FAILURES = new Set(['CANCELLED', 'DISABLED']);

/**
 * What a re-read session and order mean for our payment row, or null to change
 * nothing.
 *
 * A capture is believed only when the session completed, Klarna names the
 * order, and that order is CAPTURED for exactly the amount and currency this
 * site charged. Anything short of that is left alone — a session the customer
 * can still retry must not fail the payment under them.
 */
export function klarnaOutcome(args: {
  session: KlarnaSessionState;
  order?: KlarnaOrderState;
  expected: { amount: number; currency: string };
}): { status: 'captured'; orderId: string } | { status: 'failed' } | null {
  const { session, order, expected } = args;
  if (session.status && FINAL_FAILURES.has(session.status)) return { status: 'failed' };
  if (session.status !== 'COMPLETED' || !session.order_id || !order) return null;
  if (order.status !== 'CAPTURED') return null;
  if (order.captured_amount !== expected.amount) return null;
  if (order.purchase_currency?.toUpperCase() !== expected.currency.toUpperCase()) return null;
  return { status: 'captured', orderId: session.order_id };
}

/** Klarna session ids are UUIDs; anything else is not worth a lookup. */
const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

/**
 * The session a status callback names, or null.
 *
 * Klarna posts `{ event_id, session: { session_id, ... } }`, and our callback
 * URL carries the same id as `sid`. When both are present they must agree —
 * a body naming a different session than the URL Klarna was given is not a
 * callback Klarna sent.
 */
export function parseKlarnaCallback(rawBody: string, sidParam: string | null): string | null {
  let fromBody: string | null = null;
  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody) as { session?: { session_id?: unknown } };
      const id = parsed?.session?.session_id;
      fromBody = typeof id === 'string' ? id : null;
    } catch {
      return null;
    }
  }
  if (fromBody && sidParam && fromBody !== sidParam) return null;
  const id = fromBody ?? sidParam;
  return id && SESSION_ID.test(id) ? id : null;
}

/**
 * Where the return route sends the customer: the return URL stored when the
 * payment started, if it is on this site; otherwise the home page. Never a
 * target taken from the request, so the route cannot be an open redirect.
 */
export function klarnaReturnTarget(metadata: unknown, origin: string): string {
  const home = `${origin}/`;
  const stored = (metadata as { returnUrl?: unknown } | null)?.returnUrl;
  if (typeof stored !== 'string') return home;
  try {
    const url = new URL(stored);
    return url.origin === origin ? url.toString() : home;
  } catch {
    return home;
  }
}

/** Klarna's error code, for the log — the body can name the customer, so it is not kept whole. */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error_code?: string } | null;
  return body?.error_code ?? 'unknown';
}

export const klarnaProvider: PaymentProvider = {
  key: KLARNA_PROVIDER_KEY,
  label: 'Klarna',

  async start(ctx: PaymentStartContext): Promise<PaymentStartResult> {
    // Checked before any call, so a misconfigured site fails loudly here
    // rather than half-way through opening sessions.
    readCredentials();
    const origin = siteOrigin();
    const returnUrl = ctx.returnUrl ?? `${origin}/`;

    const kpRes = await klarnaFetch('/payments/v1/sessions', {
      method: 'POST',
      body: buildKlarnaPaymentSession(ctx, { country: purchaseCountry() }),
    });
    if (!kpRes.ok) {
      console.error(
        `[cms/payments] klarna payment session refused (${kpRes.status}): ${await errorCode(kpRes)}`
      );
      return { status: 'failed', error: 'Klarna could not start this payment.' };
    }
    const kp = (await kpRes.json()) as { session_id?: string };
    if (!kp.session_id) return { status: 'failed', error: 'Klarna returned no payment session.' };

    const hppRes = await klarnaFetch('/hpp/v1/sessions', {
      method: 'POST',
      body: buildKlarnaHppSession({ paymentSessionId: kp.session_id, returnUrl, origin }),
    });
    if (!hppRes.ok) {
      console.error(
        `[cms/payments] klarna hosted page refused (${hppRes.status}): ${await errorCode(hppRes)}`
      );
      return { status: 'failed', error: 'Klarna could not start this payment.' };
    }
    const hpp = (await hppRes.json()) as { session_id?: string; redirect_url?: string };
    if (!hpp.session_id || !hpp.redirect_url) {
      return { status: 'failed', error: 'Klarna returned no payment page.' };
    }

    return {
      status: 'pending',
      // The HPP session: both the callback and the return route name it.
      providerRef: hpp.session_id,
      // Used as given — Klarna asks that its URLs are never rebuilt.
      redirectUrl: hpp.redirect_url,
      method: 'klarna',
      metadata: { returnUrl },
    };
  },

  /**
   * Disable the hosted page, so an order or booking that has closed cannot be
   * paid into. A 404 means Klarna no longer has the session — already closed.
   */
  async cancel(providerRef: string): Promise<void> {
    const res = await klarnaFetch(`/hpp/v1/sessions/${encodeURIComponent(providerRef)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Klarna refused to close session ${providerRef} (${res.status})`);
    }
  },

  async refund(ctx: PaymentRefundContext): Promise<PaymentRefundResult> {
    try {
      const path = `/ordermanagement/v1/orders/${encodeURIComponent(ctx.providerRef)}`;
      // Order Management needs a figure; "all of it" is what is left of the capture.
      let amount = ctx.amount;
      if (amount == null) {
        const order = await klarnaRead<KlarnaOrderState>(path);
        amount = Math.max(0, (order.captured_amount ?? 0) - (order.refunded_amount ?? 0));
      }

      const res = await klarnaFetch(`${path}/refunds`, {
        method: 'POST',
        body: { refunded_amount: amount },
        // A retried request with the same key gets the same answer, never a
        // second refund. The admin's refund claim is what stops two requests.
        idempotencyKey: crypto.randomUUID(),
      });
      if (!res.ok) {
        return {
          status: 'failed',
          error: `Klarna refused the refund (${res.status}): ${await errorCode(res)}`,
        };
      }
      return { status: 'refunded', providerRef: res.headers.get('Refund-Id') ?? undefined };
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Klarna refund failed.',
      };
    }
  },
};
