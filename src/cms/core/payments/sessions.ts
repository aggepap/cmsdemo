/**
 * Closing payment sessions whose order or reservation has closed.
 *
 * A gateway's hosted page can outlive our own timeouts — Klarna's lives about
 * 47 hours, while the shop cancels an unpaid order after a few and a booking's
 * payment hold lapses in minutes. Left open, the customer could still pay into
 * an order that was cancelled or a booking that no longer holds a date, and the
 * money would have to be found and sent back. So when an order or reservation
 * closes, each still-pending session is closed at its gateway.
 *
 * Best effort: the order or reservation has already closed, and that must not
 * be undone because a gateway was unreachable. A capture that still slips
 * through is caught by the late-capture flag (`settleCapturedOrder`).
 *
 * No DB here — each module reads its own payment rows and hands them over.
 */
import { getPaymentProvider, type PaymentStatus } from './index';

export interface PaymentSessionRow {
  provider: string;
  providerRef: string | null;
  status: PaymentStatus;
}

export async function closePaymentSessions(rows: readonly PaymentSessionRow[]): Promise<void> {
  for (const row of rows) {
    if (row.status !== 'pending' || !row.providerRef) continue;
    const provider = getPaymentProvider(row.provider);
    // An unknown key resolves to manual, which has nothing to close.
    if (provider.key !== row.provider || !provider.cancel) continue;
    try {
      await provider.cancel(row.providerRef);
    } catch (err) {
      console.error('[cms/payments] could not close payment session', {
        provider: row.provider,
        providerRef: row.providerRef,
        err,
      });
    }
  }
}
