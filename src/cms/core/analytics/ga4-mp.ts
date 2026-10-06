/**
 * GA4 Measurement Protocol — events only the server knows about (REQ-5 §3:
 * `refund`, recorded in the admin). Pure builders here; `sendGa4Refund` does
 * the request.
 *
 * Env: GA4_MP_API_SECRET (GA4 → Admin → Data streams → the stream → Measurement
 * Protocol API secrets). Server only. Unset = nothing is sent.
 */

export interface Ga4MpEvent {
  name: string;
  params: Record<string, unknown>;
}

export function ga4RefundEvent(input: { transactionId: string; value: number; currency: string }): Ga4MpEvent {
  return {
    name: 'refund',
    params: { transaction_id: input.transactionId, value: Math.round(input.value) / 100, currency: input.currency },
  };
}

export function ga4MeasurementProtocolRequest(input: {
  measurementId: string;
  apiSecret: string;
  clientId: string;
  events: Ga4MpEvent[];
}): { url: string; body: string } {
  const url = new URL('https://www.google-analytics.com/mp/collect');
  url.searchParams.set('measurement_id', input.measurementId);
  url.searchParams.set('api_secret', input.apiSecret);
  return { url: url.toString(), body: JSON.stringify({ client_id: input.clientId, events: input.events }) };
}

const SEND_TIMEOUT_MS = 5000;

/**
 * Send a refund to GA4. Never throws: a refund recorded in the shop must not
 * fail because Google did. The client id is the shopper's own `_ga` id when they
 * allowed Analytics at checkout; otherwise a stable stand-in for the order — a
 * refund is matched to its purchase by `transaction_id`, not by visitor.
 */
export async function sendGa4Refund(
  input: { measurementId: string | null; clientId: string | null; fallbackClientId: string; transactionId: string; value: number; currency: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const apiSecret = process.env.GA4_MP_API_SECRET?.trim();
  if (!apiSecret || !input.measurementId) return;
  const req = ga4MeasurementProtocolRequest({
    measurementId: input.measurementId,
    apiSecret,
    clientId: input.clientId ?? input.fallbackClientId,
    events: [ga4RefundEvent(input)],
  });
  try {
    const res = await fetchImpl(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: req.body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) console.error(`[cms/ga4-mp] refund ${input.transactionId}: HTTP ${res.status}`);
  } catch (err) {
    console.error(`[cms/ga4-mp] refund ${input.transactionId} failed`, err);
  }
}
