/**
 * Scheduled jobs: `POST /api/cms/cron/<job>` with `x-cron-secret: $CMS_CRON_SECRET`.
 *
 * The one list of what an external scheduler can run. A job belonging to a
 * module that is switched off answers 404, like the module's other endpoints.
 * The older per-job endpoints (abandoned-cart reminders, reservation expiry)
 * keep working with their own secrets; their jobs are here too, so one secret
 * and one scheduler entry per job is enough.
 */
import { resolveModuleFlags } from '@/cms/core';
// Side effect: attaches the gateways, so a job that cancels an unpaid order or
// expires a booking can close its payment session (Klarna's outlives ours).
import '@/cms/core/payments/register';
import { flushCapiQueue } from '@/cms/core/analytics/capi-queue';
import { cronRoute } from '@/cms/core/cron/service';
import { publishDueScheduled, scheduledPublisher } from '@/cms/core/documents/publish-scheduled';
import { purgeExpiredSubmissions } from '@/cms/core/forms/service';
import { cleanupTransfers } from '@/cms/core/transfer/runtime';
import { expireStaleReservations } from '@/cms/modules/booking';
import {
  cancelStaleOrders,
  deliverDueGiftCards,
  expireGiftCards,
  processReminders,
  sendGiftCardEmail,
} from '@/cms/modules/commerce';
import { syncAllReviewLocations } from '@/cms/modules/reviews-external';
import config from '@/site.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = cronRoute({
  jobs: {
    // Scheduled documents whose time has passed are stored as published. The
    // admin also does this whenever its lists are opened; the job keeps the
    // status right for sites where nobody looks for a while.
    'content-publish-scheduled': {
      run: async () => ({ ...(await publishDueScheduled(scheduledPublisher())) }),
    },
    'commerce-stale-orders': { module: 'commerce', run: cancelStaleOrders },
    'google-reviews-sync': { module: 'googleReviews', run: syncAllReviewLocations },
    // Gift cards are sent on the day the buyer chose, not the day they bought.
    'giftcard-deliver': {
      module: 'commerce',
      run: () => deliverDueGiftCards((card) => sendGiftCardEmail(card, config.defaultLocale)),
    },
    'giftcard-expire': { module: 'commerce', run: expireGiftCards },
    'commerce-abandoned-reminders': {
      module: 'commerce',
      run: () => processReminders({ defaultLocale: config.defaultLocale }),
    },
    // Lapses unanswered enquiries and releases abandoned payment holds. Same
    // sweep as the legacy `POST /api/cms/reservations/expire`.
    'booking-expire': {
      module: 'booking',
      run: async () => ({ ...(await expireStaleReservations()) }),
    },
    // Export / import packages are staged on disk and may hold customer data;
    // anything untouched for CMS_TRANSFER_TTL_HOURS (default 24) is removed.
    'transfer-cleanup': { run: cleanupTransfers },
    // Settings → Forms: submissions past their retention period are deleted,
    // with their attached files. Does nothing until a period is set. Daily.
    'forms-retention': { run: purgeExpiredSubmissions },
    // Meta Conversions API sends that failed on the first try: retried with
    // backoff (1 min … 12 h, 6 attempts); sent rows older than 30 days removed.
    // Every 5–15 minutes, when the Conversions API is in use.
    'analytics-capi-flush': { run: () => flushCapiQueue() },
  },
  moduleFlags: () => resolveModuleFlags(config),
});
