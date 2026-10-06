import 'server-only';

import { and, asc, count, desc, eq, lt, lte } from 'drizzle-orm';

import { getDb, schema } from '../../db';
import { getSetting } from '../settings';
import { getMarketingConfig } from '../settings/marketing-read';
import {
  CAPI_GRAPH_VERSION,
  buildCapiEvent,
  capiRequestBody,
  capiTarget,
  queueOutcome,
  readMetaCapi,
  META_CAPI_KEY,
  type CapiUser,
  type RequestAnalyticsContext,
} from './meta-capi';

/**
 * The Meta Conversions API queue — the I/O half (see `meta-capi.ts` for the
 * rules and `schema/analytics.ts` for the table).
 *
 * `queueCapiEvent` stores the event and tries it at once WITHOUT making the
 * caller wait; whatever does not go is retried by the `analytics-capi-flush`
 * job. Nothing here throws to its caller: an order, a lead or an account must
 * never fail because Meta did.
 *
 * Env:
 *   META_CAPI_ACCESS_TOKEN         the Conversions API token (Events Manager →
 *                                  Settings → Conversions API). Server only.
 *   META_CAPI_PHONE_COUNTRY_CODE   prefix for numbers typed without one (30).
 */

const SEND_TIMEOUT_MS = 5000;
const FLUSH_BATCH = 50;
const KEEP_SENT_DAYS = 30;

function token(): string | null {
  const raw = process.env.META_CAPI_ACCESS_TOKEN?.trim();
  return raw ? raw : null;
}

function phoneCountryCode(): string {
  const raw = process.env.META_CAPI_PHONE_COUNTRY_CODE?.trim();
  return raw && /^\d{1,4}$/.test(raw) ? raw : '30';
}

export interface QueueCapiInput {
  /** The Meta event name, as the browser sends it (`Purchase`, `Lead`…). */
  eventName: string;
  /** The same id the browser's Pixel event carried. */
  eventId: string;
  user: Pick<CapiUser, 'email' | 'phone'>;
  customData: Record<string, unknown>;
  /** From the request (or stored with the order): consent, cookies, IP, UA, page. */
  context: Pick<RequestAnalyticsContext, 'marketing' | 'fbp' | 'fbc' | 'ip' | 'userAgent' | 'sourceUrl'>;
  eventTime?: Date;
}

/** Store and try one event. Resolves once it is stored; the send runs on its own. */
export async function queueCapiEvent(input: QueueCapiInput): Promise<void> {
  try {
    const [marketing, stored] = await Promise.all([getMarketingConfig(), getSetting(META_CAPI_KEY)]);
    const settings = readMetaCapi(stored);
    const target = capiTarget(input.eventName, {
      token: token(),
      pixelId: marketing.pixelId,
      consent: input.context.marketing,
      settings,
    });
    if (!target) return;

    const payload = buildCapiEvent({
      eventName: input.eventName,
      eventId: input.eventId,
      eventTime: input.eventTime ?? new Date(),
      sourceUrl: input.context.sourceUrl ?? '',
      user: { ...input.user, fbp: input.context.fbp, fbc: input.context.fbc, ip: input.context.ip, userAgent: input.context.userAgent },
      customData: input.customData,
      phoneCountryCode: phoneCountryCode(),
    });

    const db = getDb();
    // The same (name, id) twice — a purchase at placement and again at capture —
    // is one event: the second insert changes nothing.
    await db
      .insert(schema.analyticsCapiQueue)
      .values({
        eventName: input.eventName,
        eventId: input.eventId.slice(0, 128),
        payload: payload as unknown as Record<string, unknown>,
        nextAttemptAt: new Date(),
      })
      .onDuplicateKeyUpdate({ set: { eventName: input.eventName } });

    const [row] = await db
      .select()
      .from(schema.analyticsCapiQueue)
      .where(and(eq(schema.analyticsCapiQueue.eventName, input.eventName), eq(schema.analyticsCapiQueue.eventId, input.eventId.slice(0, 128))))
      .limit(1);
    if (row && row.status === 'pending' && row.attempts === 0) {
      void attempt(row, fetch, new Date()).catch((err) => console.error('[cms/capi] first attempt failed', err));
    }
  } catch (err) {
    console.error('[cms/capi] could not queue', input.eventName, err);
  }
}

type QueueRow = typeof schema.analyticsCapiQueue.$inferSelect;

async function attempt(row: QueueRow, fetchImpl: typeof fetch, now: Date): Promise<'sent' | 'pending' | 'failed'> {
  const [marketing, stored] = await Promise.all([getMarketingConfig(), getSetting(META_CAPI_KEY)]);
  const settings = readMetaCapi(stored);
  const accessToken = token();
  let result: { ok: true } | { ok: false; error: string };
  if (!accessToken || !marketing.pixelId) {
    result = { ok: false, error: 'not configured (META_CAPI_ACCESS_TOKEN or Pixel ID missing)' };
  } else {
    try {
      const res = await fetchImpl(`https://graph.facebook.com/${CAPI_GRAPH_VERSION}/${marketing.pixelId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(capiRequestBody([row.payload], accessToken, settings.testEventCode)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (res.ok) {
        result = { ok: true };
      } else {
        // Meta's error text, never the token (it travels in the body we sent, not in the reply).
        const text = (await res.text().catch(() => '')).slice(0, 300);
        result = { ok: false, error: `HTTP ${res.status} ${text}` };
      }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }
  const outcome = queueOutcome(result, row.attempts, now);
  await getDb()
    .update(schema.analyticsCapiQueue)
    .set({
      status: outcome.status,
      attempts: outcome.attempts,
      lastError: outcome.lastError,
      ...(outcome.sentAt ? { sentAt: outcome.sentAt } : {}),
      ...(outcome.nextAttemptAt ? { nextAttemptAt: outcome.nextAttemptAt } : {}),
    })
    .where(eq(schema.analyticsCapiQueue.id, row.id));
  if (outcome.status === 'failed') console.error(`[cms/capi] gave up on ${row.eventName} ${row.eventId}: ${outcome.lastError}`);
  return outcome.status;
}

/** The `analytics-capi-flush` job: retry what is due, forget what was sent long ago. */
export async function flushCapiQueue(fetchImpl: typeof fetch = fetch): Promise<Record<string, number>> {
  const now = new Date();
  const db = getDb();
  const due = await db
    .select()
    .from(schema.analyticsCapiQueue)
    .where(and(eq(schema.analyticsCapiQueue.status, 'pending'), lte(schema.analyticsCapiQueue.nextAttemptAt, now)))
    .orderBy(asc(schema.analyticsCapiQueue.nextAttemptAt))
    .limit(FLUSH_BATCH);
  const tally = { sent: 0, pending: 0, failed: 0 };
  for (const row of due) tally[await attempt(row, fetchImpl, now)] += 1;

  const cutoff = new Date(now.getTime() - KEEP_SENT_DAYS * 24 * 60 * 60 * 1000);
  await db
    .delete(schema.analyticsCapiQueue)
    .where(and(eq(schema.analyticsCapiQueue.status, 'sent'), lt(schema.analyticsCapiQueue.createdAt, cutoff)));
  return tally;
}

export interface CapiQueueSummary {
  counts: Record<'pending' | 'sent' | 'failed', number>;
  recentFailures: { eventName: string; eventId: string; attempts: number; lastError: string | null; createdAt: Date }[];
}

/** For the admin's status panel. Fails soft: a missing table reads as empty. */
export async function capiQueueSummary(): Promise<CapiQueueSummary> {
  const empty: CapiQueueSummary = { counts: { pending: 0, sent: 0, failed: 0 }, recentFailures: [] };
  try {
    const db = getDb();
    const rows = await db
      .select({ status: schema.analyticsCapiQueue.status, n: count() })
      .from(schema.analyticsCapiQueue)
      .groupBy(schema.analyticsCapiQueue.status);
    const recentFailures = await db
      .select({
        eventName: schema.analyticsCapiQueue.eventName,
        eventId: schema.analyticsCapiQueue.eventId,
        attempts: schema.analyticsCapiQueue.attempts,
        lastError: schema.analyticsCapiQueue.lastError,
        createdAt: schema.analyticsCapiQueue.createdAt,
      })
      .from(schema.analyticsCapiQueue)
      .where(eq(schema.analyticsCapiQueue.status, 'failed'))
      .orderBy(desc(schema.analyticsCapiQueue.createdAt))
      .limit(10);
    const counts = { ...empty.counts };
    for (const r of rows) counts[r.status] = Number(r.n);
    return { counts, recentFailures };
  } catch (err) {
    console.error('[cms/capi] summary unavailable', err);
    return empty;
  }
}

export function capiTokenConfigured(): boolean {
  return token() !== null;
}
