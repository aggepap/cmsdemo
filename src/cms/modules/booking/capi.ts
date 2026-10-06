import 'server-only';

import { eq } from 'drizzle-orm';

import { getDb, schema } from '../../db';
import { queueCapiEvent } from '../../core/analytics/capi-queue';
import { sendGa4Refund } from '../../core/analytics/ga4-mp';
import { storedAnalyticsContext, type RequestAnalyticsContext } from '../../core/analytics/meta-capi';
import { getMarketingConfig } from '../../core/settings/marketing-read';

/**
 * Server-side measurement for reservations, mirroring `commerce/capi.ts`:
 * a request is a Lead, a confirmed or paid booking a Purchase (Meta Conversions
 * API, event id = the reference, as in the browser), a refund goes to GA4 by
 * Measurement Protocol. Consent comes from the request, or from what was stored
 * with the reservation when payment confirms later. Never throws.
 */

async function loadReservation(reservationId: number) {
  const [row] = await getDb()
    .select({
      reference: schema.reservations.reference,
      email: schema.reservations.email,
      phone: schema.reservations.phone,
      total: schema.reservations.total,
      currency: schema.reservations.currency,
      bookingSlug: schema.reservations.bookingSlug,
      metadata: schema.reservations.metadata,
    })
    .from(schema.reservations)
    .where(eq(schema.reservations.id, reservationId))
    .limit(1);
  return row ?? null;
}

/** Keep the consented context with the reservation, for a payment confirmed later. */
export async function storeReservationAnalyticsContext(reference: string, context: Record<string, unknown> | null): Promise<void> {
  if (!context) return;
  try {
    const db = getDb();
    const [row] = await db
      .select({ id: schema.reservations.id, metadata: schema.reservations.metadata })
      .from(schema.reservations)
      .where(eq(schema.reservations.reference, reference))
      .limit(1);
    if (!row) return;
    await db
      .update(schema.reservations)
      .set({ metadata: { ...(row.metadata ?? {}), analytics: context } })
      .where(eq(schema.reservations.id, row.id));
  } catch (err) {
    console.error('[booking/capi] context not stored', reference, err);
  }
}

export async function queueReservationEvent(
  reservationId: number,
  eventName: 'Lead' | 'Purchase',
  context?: RequestAnalyticsContext | null,
): Promise<void> {
  try {
    const r = await loadReservation(reservationId);
    if (!r) return;
    const ctx = context ?? storedAnalyticsContext((r.metadata ?? {}).analytics);
    if (!ctx?.marketing) return;
    await queueCapiEvent({
      eventName,
      eventId: r.reference,
      user: { email: r.email, phone: r.phone },
      customData:
        eventName === 'Purchase'
          ? {
              value: Math.round(r.total) / 100,
              currency: r.currency,
              order_id: r.reference,
              content_type: 'product',
              content_ids: [r.bookingSlug ?? r.reference],
              contents: [{ id: r.bookingSlug ?? r.reference, quantity: 1 }],
              num_items: 1,
            }
          : { form_id: 'booking_request', form_name: 'Booking request' },
      context: ctx,
    });
  } catch (err) {
    console.error('[booking/capi] event not queued', reservationId, eventName, err);
  }
}

export async function reservationIdByReference(reference: string): Promise<number | null> {
  const [row] = await getDb()
    .select({ id: schema.reservations.id })
    .from(schema.reservations)
    .where(eq(schema.reservations.reference, reference))
    .limit(1);
  return row?.id ?? null;
}

export async function sendReservationRefund(reservationId: number, refundedMinor: number): Promise<void> {
  try {
    const [r, marketing] = await Promise.all([loadReservation(reservationId), getMarketingConfig()]);
    if (!r) return;
    await sendGa4Refund({
      measurementId: marketing.gaId,
      clientId: storedAnalyticsContext((r.metadata ?? {}).analytics)?.gaClientId ?? null,
      fallbackClientId: `cms.${r.reference}`,
      transactionId: r.reference,
      value: refundedMinor,
      currency: r.currency,
    });
  } catch (err) {
    console.error('[booking/capi] refund not sent', reservationId, err);
  }
}
