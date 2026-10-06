/**
 * Meta Conversions API sends waiting, done or given up (REQ-5 §6).
 *
 * A send is queued first and attempted straight after, so a slow or failing
 * Meta never holds up the order or the form it belongs to; the
 * `analytics-capi-flush` job retries what failed, with backoff, up to
 * `CAPI_MAX_ATTEMPTS`, and clears sent rows after 30 days.
 *
 * `payload` holds the event as Meta receives it: hashed email/phone, the
 * `_fbp`/`_fbc` cookies, IP and user agent — only ever for a visitor who gave
 * Marketing consent. The unique (event_name, event_id) pair is what stops one
 * purchase being sent twice from here (placement and payment capture).
 */
import { datetime, index, int, json, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

export const capiQueueStatusValues = ['pending', 'sent', 'failed'] as const;

export const analyticsCapiQueue = mysqlTable(
  'analytics_capi_queue',
  {
    id: int('id').autoincrement().primaryKey(),
    eventName: varchar('event_name', { length: 64 }).notNull(),
    eventId: varchar('event_id', { length: 128 }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    status: mysqlEnum('status', capiQueueStatusValues).notNull().default('pending'),
    attempts: int('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 500 }),
    nextAttemptAt: datetime('next_attempt_at').notNull(),
    sentAt: datetime('sent_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    eventUnique: uniqueIndex('uq_capi_event').on(t.eventName, t.eventId),
    dueIdx: index('idx_capi_due').on(t.status, t.nextAttemptAt),
  }),
);

export type CapiQueueRow = typeof analyticsCapiQueue.$inferSelect;
