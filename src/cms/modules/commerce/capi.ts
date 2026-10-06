import 'server-only';

import { eq } from 'drizzle-orm';

import { getDb, schema } from '../../db';
import { queueCapiEvent } from '../../core/analytics/capi-queue';
import { sendGa4Refund } from '../../core/analytics/ga4-mp';
import { getMarketingConfig } from '../../core/settings/marketing-read';
import { storedAnalyticsContext } from '../../core/analytics/meta-capi';
import { orderPurchaseCustomData } from './analytics';

/**
 * Queue the server-side Purchase for an order (Meta Conversions API), with the
 * consent the shopper gave at checkout — nothing at all without Marketing
 * consent. The event id is the order reference, which is also the browser's,
 * so Meta counts one; the queue's unique key makes a second call (placement,
 * then capture) a no-op. Never throws.
 */
export async function queueOrderPurchase(orderId: number): Promise<void> {
  try {
    const db = getDb();
    const [order] = await db
      .select({
        reference: schema.orders.reference,
        email: schema.orders.email,
        total: schema.orders.total,
        currency: schema.orders.currency,
        metadata: schema.orders.metadata,
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!order) return;
    const meta = (order.metadata ?? {}) as Record<string, unknown>;
    const context = storedAnalyticsContext(meta.analytics);
    if (!context?.marketing) return;
    const lines = await db
      .select({ sku: schema.orderItems.sku, productId: schema.orderItems.productId, quantity: schema.orderItems.quantity })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, orderId));
    const shipping = (meta.shipping ?? {}) as Record<string, unknown>;
    await queueCapiEvent({
      eventName: 'Purchase',
      eventId: order.reference,
      user: { email: order.email, phone: typeof shipping.phone === 'string' ? shipping.phone : null },
      customData: orderPurchaseCustomData({ reference: order.reference, total: order.total, currency: order.currency, lines }),
      context,
    });
  } catch (err) {
    console.error('[commerce/capi] purchase not queued', orderId, err);
  }
}

/** The admin refund, to GA4 by Measurement Protocol (when GA4_MP_API_SECRET is set). Never throws. */
export async function sendOrderRefund(orderId: number, refundedMinor: number): Promise<void> {
  try {
    const [[order], marketing] = await Promise.all([
      getDb()
        .select({ reference: schema.orders.reference, currency: schema.orders.currency, metadata: schema.orders.metadata })
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1),
      getMarketingConfig(),
    ]);
    if (!order) return;
    await sendGa4Refund({
      measurementId: marketing.gaId,
      clientId: storedAnalyticsContext(((order.metadata ?? {}) as Record<string, unknown>).analytics)?.gaClientId ?? null,
      fallbackClientId: `cms.${order.reference}`,
      transactionId: order.reference,
      value: refundedMinor,
      currency: order.currency,
    });
  } catch (err) {
    console.error('[commerce/capi] refund not sent', orderId, err);
  }
}
