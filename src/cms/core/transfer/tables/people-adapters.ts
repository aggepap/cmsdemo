import 'server-only';

import { randomBytes } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb, schema } from '../../../db';
import { hashPassword } from '../../../modules/auth/password';
import { badRequest, invalidInput } from '../../errors';
import {
  checkGrantable,
  fillMissing,
  mapBookingGroupId,
  mapSlotKey,
  peopleKey,
  peopleLabel,
  type PeopleFamily,
} from './people';
import { decodeRow, encodeRow } from './row-codec';
import {
  depsOf,
  type ExportOptions,
  type TableAdapter,
  type TableRow,
  type TableWriteCtx,
} from './shared';

/*
 * Phase C: people and transactions. Whole rows, checked column by column by
 * the row codec against the schema. What never travels, and why:
 * - password hashes, unless explicitly asked for (and `transferUsers` held);
 * - customer and payment-link tokens, sessions, MFA secrets: bearer secrets of
 *   the source site;
 * - `tokenVersion`, `lastLoginAt`: session state;
 * - `version` columns: this site's optimistic-concurrency counters;
 * - Mailchimp ids: they belong to the source site's audience.
 * Gift cards are not a group at all: their codes are hashed with a per-site
 * pepper, so a moved card could never be redeemed.
 */

type Rec = Record<string, unknown>;
const db = () => getDb();
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rows = (v: unknown): Rec[] =>
  Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object') : [];

function decodeOrThrow(
  table: Parameters<typeof decodeRow>[0],
  record: Rec,
  omit: readonly string[],
  what: string
): Rec {
  const r = decodeRow(table, record, omit);
  if (!r.ok)
    throw invalidInput(
      { formErrors: r.errors.map((e) => `${what} ${e}`) },
      `${what}: ${r.errors[0]}`
    );
  return r.values;
}

async function row(
  family: PeopleFamily,
  key: string,
  record: Rec,
  meta?: string | null
): Promise<TableRow> {
  return {
    key,
    label: peopleLabel(family, record),
    meta: meta ?? null,
    sid: key,
    record,
    deps: await depsOf(family, record),
  };
}

/** An account that exists but cannot be signed into until someone sets a password. */
async function unusablePassword(): Promise<string> {
  return hashPassword(randomBytes(32).toString('hex'));
}

// ── Customers ───────────────────────────────────────────────────────────────

const CUSTOMER_OMIT = ['id', 'passwordHash', 'tokenVersion', 'lastLoginAt'] as const;
const ADDRESS_OMIT = ['id', 'customerId'] as const;
const addressIdentity = (a: Rec) =>
  JSON.stringify(
    Object.entries(a)
      .filter(
        ([k]) =>
          ![
            'createdAt',
            'updatedAt',
            'isDefaultShipping',
            'isDefaultBilling',
            'id',
            'customerId',
          ].includes(k)
      )
      .sort(([x], [y]) => x.localeCompare(y))
  );

const customers: TableAdapter = {
  family: 'customers',
  async list(opts: ExportOptions = {}) {
    const all = await db().select().from(schema.customers);
    const addresses = await db().select().from(schema.customerAddresses);
    const wishlist = await db().select().from(schema.wishlistItems);
    return Promise.all(
      all.map((c) => {
        const record: Rec = {
          ...encodeRow(schema.customers, c, CUSTOMER_OMIT),
          ...(opts.includePasswordHashes && c.passwordHash ? { passwordHash: c.passwordHash } : {}),
          addresses: addresses
            .filter((a) => a.customerId === c.id)
            .map((a) => encodeRow(schema.customerAddresses, a, ADDRESS_OMIT)),
          wishlist: wishlist
            .filter((w) => w.customerId === c.id)
            .map((w) => ({
              productSid: w.productId,
              variationId: w.variationId,
              createdAt: w.createdAt.toISOString(),
            })),
        };
        return row('customers', peopleKey.customer(c.email), record, c.status);
      })
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.customers.id, email: schema.customers.email })
      .from(schema.customers)
      .where(eq(schema.customers.email, str(r.email).toLowerCase()))
      .limit(1);
    return hit ? { id: hit.id, label: hit.email } : null;
  },
  async write(record, action, ctx) {
    const values = decodeOrThrow(schema.customers, record, CUSTOMER_OMIT, 'Customer');
    values.email = str(values.email).toLowerCase();
    const hash =
      ctx.importPasswordHashes && typeof record.passwordHash === 'string'
        ? record.passwordHash
        : undefined;
    const existing = await this.match(record);
    let id: number;
    let outcome: 'created' | 'updated' | 'merged' = 'created';
    if (existing) {
      id = existing.id;
      const [current] = await db()
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.id, id));
      const next = action === 'merge' ? fillMissing(current as Rec, values) : values;
      delete next.id;
      await db()
        .update(schema.customers)
        .set({
          ...(next as typeof schema.customers.$inferInsert),
          ...(hash ? { passwordHash: hash } : {}),
        })
        .where(eq(schema.customers.id, id));
      outcome = action === 'merge' ? 'merged' : 'updated';
    } else {
      // Without its hash the account has no password: the customer sets one with "forgot password".
      const [res] = await db()
        .insert(schema.customers)
        .values({ ...(values as typeof schema.customers.$inferInsert), passwordHash: hash ?? null })
        .$returningId();
      id = res.id;
    }
    // Addresses: add the ones this account does not have; keep its own.
    const have = new Set(
      (
        await db()
          .select()
          .from(schema.customerAddresses)
          .where(eq(schema.customerAddresses.customerId, id))
      ).map((a) => addressIdentity(encodeRow(schema.customerAddresses, a, ADDRESS_OMIT)))
    );
    for (const a of rows(record.addresses)) {
      if (have.has(addressIdentity(a))) continue;
      const v = decodeOrThrow(schema.customerAddresses, a, ADDRESS_OMIT, 'Address');
      await db()
        .insert(schema.customerAddresses)
        .values({ ...(v as typeof schema.customerAddresses.$inferInsert), customerId: id });
    }
    // Wishlist: only products that exist here.
    let dropped = 0;
    for (const w of rows(record.wishlist)) {
      const productId = typeof w.productSid === 'number' ? ctx.resolver.doc(w.productSid) : null;
      if (productId === null) {
        dropped++;
        continue;
      }
      await db()
        .insert(schema.wishlistItems)
        .values({ customerId: id, productId, variationId: str(w.variationId) })
        .onDuplicateKeyUpdate({ set: { variationId: str(w.variationId) } });
    }
    const message =
      !existing && !hash
        ? 'No password was brought over: the customer sets one with “forgot password”.'
        : undefined;
    return { outcome, ...(message ? { message } : {}), ...(dropped ? { dropped } : {}) };
  },
  revalidate: () => undefined,
};

// ── Newsletter subscribers & suppressions ───────────────────────────────────

const SUBSCRIBER_OMIT = ['id', 'mailchimpId', 'mailchimpStatus', 'lastSyncedAt'] as const;

const subscribers: TableAdapter = {
  family: 'subscribers',
  async list() {
    const all = await db().select().from(schema.newsletterSubscribers);
    return Promise.all(
      all.map((s) =>
        row(
          'subscribers',
          peopleKey.subscriber(s.email),
          encodeRow(schema.newsletterSubscribers, s, SUBSCRIBER_OMIT),
          s.unsubscribedAt ? 'unsubscribed' : 'subscribed'
        )
      )
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.newsletterSubscribers.id, email: schema.newsletterSubscribers.email })
      .from(schema.newsletterSubscribers)
      .where(eq(schema.newsletterSubscribers.email, str(r.email).toLowerCase()))
      .limit(1);
    return hit ? { id: hit.id, label: hit.email } : null;
  },
  async write(record) {
    const values = decodeOrThrow(
      schema.newsletterSubscribers,
      record,
      SUBSCRIBER_OMIT,
      'Subscriber'
    );
    values.email = str(values.email).toLowerCase();
    const existing = await this.match(record);
    if (existing) {
      await db()
        .update(schema.newsletterSubscribers)
        .set(values as typeof schema.newsletterSubscribers.$inferInsert)
        .where(eq(schema.newsletterSubscribers.id, existing.id));
      return { outcome: 'updated' };
    }
    await db()
      .insert(schema.newsletterSubscribers)
      .values(values as typeof schema.newsletterSubscribers.$inferInsert);
    return { outcome: 'created' };
  },
  revalidate: () => undefined,
};

const suppressions: TableAdapter = {
  family: 'suppressions',
  async list() {
    const all = await db().select().from(schema.emailSuppressions);
    return Promise.all(
      all.map((s) =>
        row(
          'suppressions',
          peopleKey.suppression(s.email),
          encodeRow(schema.emailSuppressions, s, ['id']),
          s.reason
        )
      )
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.emailSuppressions.id, email: schema.emailSuppressions.email })
      .from(schema.emailSuppressions)
      .where(eq(schema.emailSuppressions.email, str(r.email).toLowerCase()))
      .limit(1);
    return hit ? { id: hit.id, label: hit.email } : null;
  },
  async write(record) {
    const values = decodeOrThrow(schema.emailSuppressions, record, ['id'], 'Suppression');
    values.email = str(values.email).toLowerCase();
    const existing = await this.match(record);
    if (existing) {
      await db()
        .update(schema.emailSuppressions)
        .set(values as typeof schema.emailSuppressions.$inferInsert)
        .where(eq(schema.emailSuppressions.id, existing.id));
      return { outcome: 'updated' };
    }
    await db()
      .insert(schema.emailSuppressions)
      .values(values as typeof schema.emailSuppressions.$inferInsert);
    return { outcome: 'created' };
  },
  revalidate: () => undefined,
};

// ── Product reviews ─────────────────────────────────────────────────────────

const REVIEW_OMIT = ['id', 'productId'] as const;

const productReviews: TableAdapter = {
  family: 'productReviews',
  async list() {
    const all = await db().select().from(schema.productReviews);
    return Promise.all(
      all.map((r) => {
        const record = {
          ...encodeRow(schema.productReviews, r, REVIEW_OMIT),
          productSid: r.productId,
        };
        return row(
          'productReviews',
          peopleKey.productReview(r.productGroupId, r.email, r.createdAt.toISOString()),
          record,
          r.status
        );
      })
    );
  },
  async match(r) {
    // Matched after mapping the product group, in `write`; the preview compares on the source group.
    const [hit] = await db()
      .select({ id: schema.productReviews.id, authorName: schema.productReviews.authorName })
      .from(schema.productReviews)
      .where(
        and(
          eq(schema.productReviews.productGroupId, str(r.productGroupId)),
          eq(schema.productReviews.email, str(r.email).toLowerCase()),
          eq(schema.productReviews.createdAt, new Date(str(r.createdAt)))
        )
      )
      .limit(1);
    return hit ? { id: hit.id, label: hit.authorName } : null;
  },
  async write(record, _action, ctx) {
    const values = decodeOrThrow(schema.productReviews, record, REVIEW_OMIT, 'Review');
    const group = ctx.booking.group(str(record.productGroupId));
    if (!group) throw badRequest('Its product is not on this site.');
    values.productGroupId = group;
    values.email = str(values.email).toLowerCase();
    const productId =
      typeof record.productSid === 'number' ? ctx.resolver.doc(record.productSid) : null;
    const existing = await this.match({ ...record, productGroupId: group });
    const set = { ...(values as typeof schema.productReviews.$inferInsert), productId };
    if (existing) {
      await db()
        .update(schema.productReviews)
        .set(set)
        .where(eq(schema.productReviews.id, existing.id));
      return { outcome: 'updated' };
    }
    await db().insert(schema.productReviews).values(set);
    return { outcome: 'created' };
  },
  revalidate: () => undefined,
};

// ── Orders ──────────────────────────────────────────────────────────────────

const ORDER_OMIT = ['id', 'customerId', 'shippingMethodId', 'version'] as const;
const ORDER_ITEM_OMIT = ['id', 'orderId', 'productId'] as const;
const PAYMENT_OMIT = ['id', 'orderId'] as const;
const SHIPMENT_OMIT = ['id', 'orderId', 'createdBy'] as const;

const orders: TableAdapter = {
  family: 'orders',
  async list() {
    const all = await db().select().from(schema.orders);
    if (!all.length) return [];
    const ids = all.map((o) => o.id);
    const [items, pays, ships, custs, methods, zones] = await Promise.all([
      db().select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, ids)),
      db().select().from(schema.payments).where(inArray(schema.payments.orderId, ids)),
      db().select().from(schema.shipments).where(inArray(schema.shipments.orderId, ids)),
      db()
        .select({ id: schema.customers.id, email: schema.customers.email })
        .from(schema.customers),
      db().select().from(schema.shippingMethods),
      db().select().from(schema.shippingZones),
    ]);
    return Promise.all(
      all.map((o) => {
        const method = methods.find((m) => m.id === o.shippingMethodId);
        const zone = method && zones.find((z) => z.id === method.zoneId);
        const record: Rec = {
          ...encodeRow(schema.orders, o, ORDER_OMIT),
          customerEmail: custs.find((c) => c.id === o.customerId)?.email ?? null,
          shippingMethodRef: method && zone ? { zone: zone.name, name: method.name } : null,
          items: items
            .filter((i) => i.orderId === o.id)
            .map((i) => ({
              ...encodeRow(schema.orderItems, i, ORDER_ITEM_OMIT),
              productSid: i.productId,
            })),
          payments: pays
            .filter((p) => p.orderId === o.id)
            .map((p) => encodeRow(schema.payments, p, PAYMENT_OMIT)),
          shipments: ships
            .filter((s) => s.orderId === o.id)
            .map((s) => encodeRow(schema.shipments, s, SHIPMENT_OMIT)),
        };
        return row(
          'orders',
          peopleKey.order(o.reference),
          record,
          `${o.status} · ${(o.total / 100).toFixed(2)} ${o.currency}`
        );
      })
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.orders.id, status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.reference, str(r.reference)))
      .limit(1);
    return hit ? { id: hit.id, label: hit.status } : null;
  },
  async write(record, _action, ctx) {
    const values = decodeOrThrow(schema.orders, record, ORDER_OMIT, 'Order');
    const items = rows(record.items).map((i) => ({
      values: decodeOrThrow(schema.orderItems, i, ORDER_ITEM_OMIT, 'Order line'),
      productSid: typeof i.productSid === 'number' ? i.productSid : null,
    }));
    const pays = rows(record.payments).map((p) =>
      decodeOrThrow(schema.payments, p, PAYMENT_OMIT, 'Payment')
    );
    const ships = rows(record.shipments).map((s) =>
      decodeOrThrow(schema.shipments, s, SHIPMENT_OMIT, 'Shipment')
    );

    const [customer] = record.customerEmail
      ? await db()
          .select({ id: schema.customers.id })
          .from(schema.customers)
          .where(eq(schema.customers.email, str(record.customerEmail).toLowerCase()))
          .limit(1)
      : [];
    const ref = record.shippingMethodRef as Rec | null;
    const [method] = ref
      ? await db()
          .select({ id: schema.shippingMethods.id })
          .from(schema.shippingMethods)
          .innerJoin(
            schema.shippingZones,
            eq(schema.shippingZones.id, schema.shippingMethods.zoneId)
          )
          .where(
            and(
              eq(schema.shippingZones.name, str(ref.zone)),
              eq(schema.shippingMethods.name, str(ref.name))
            )
          )
          .limit(1)
      : [];
    // Payment and courier references still point at the SOURCE site's gateway and courier accounts.
    const metadata = {
      ...((values.metadata as Rec | null) ?? {}),
      importedFrom: ctx.origin,
      importedAt: new Date().toISOString(),
    };
    const order = {
      ...(values as typeof schema.orders.$inferInsert),
      metadata,
      customerId: customer?.id ?? null,
      shippingMethodId: method?.id ?? null,
    };

    const existing = await this.match(record);
    let dropped = 0;
    await db().transaction(async (tx) => {
      let id: number;
      if (existing) {
        id = existing.id;
        await tx.update(schema.orders).set(order).where(eq(schema.orders.id, id));
        await tx.delete(schema.orderItems).where(eq(schema.orderItems.orderId, id));
        await tx.delete(schema.payments).where(eq(schema.payments.orderId, id));
        await tx.delete(schema.shipments).where(eq(schema.shipments.orderId, id));
      } else {
        const [res] = await tx.insert(schema.orders).values(order).$returningId();
        id = res.id;
      }
      for (const it of items) {
        const productId = it.productSid === null ? null : ctx.resolver.doc(it.productSid);
        if (it.productSid !== null && productId === null) dropped++; // the line keeps its snapshot
        await tx.insert(schema.orderItems).values({
          ...(it.values as typeof schema.orderItems.$inferInsert),
          orderId: id,
          productId,
        });
      }
      // (provider, providerRef) and (courier, voucher) are unique: a clash with another order fails this one whole.
      for (const p of pays)
        await tx
          .insert(schema.payments)
          .values({ ...(p as typeof schema.payments.$inferInsert), orderId: id });
      for (const s of ships)
        await tx
          .insert(schema.shipments)
          .values({ ...(s as typeof schema.shipments.$inferInsert), orderId: id });
    });
    const notes = [
      record.customerEmail && !customer
        ? 'Its customer account is not on this site; kept as a guest order.'
        : '',
      ref && !method ? 'Its shipping method is not on this site.' : '',
    ].filter(Boolean);
    return {
      outcome: existing ? 'updated' : 'created',
      ...(notes.length ? { message: notes.join(' ') } : {}),
      ...(dropped ? { dropped } : {}),
    };
  },
  revalidate: () => undefined,
};

// ── Reservations & availability ─────────────────────────────────────────────

const RESERVATION_OMIT = [
  'id',
  'bookingId',
  'resourceId',
  'paymentTokenHash',
  'paymentTokenExpiresAt',
  'version',
] as const;
const RES_ITEM_OMIT = ['id', 'reservationId'] as const;
const RES_EVENT_OMIT = ['id', 'reservationId', 'actorUserId'] as const;

const reservations: TableAdapter = {
  family: 'reservations',
  async list() {
    const all = await db().select().from(schema.reservations);
    if (!all.length) return [];
    const ids = all.map((r) => r.id);
    const [items, pays, events, holds] = await Promise.all([
      db()
        .select()
        .from(schema.reservationItems)
        .where(inArray(schema.reservationItems.reservationId, ids)),
      db()
        .select()
        .from(schema.reservationPayments)
        .where(inArray(schema.reservationPayments.reservationId, ids)),
      db()
        .select()
        .from(schema.reservationEvents)
        .where(inArray(schema.reservationEvents.reservationId, ids)),
      // Capacity is counted from CONFIRMED holds: without them an imported
      // booking would not take its seats, and the date could be sold twice.
      db()
        .select()
        .from(schema.reservationHolds)
        .where(
          and(
            inArray(schema.reservationHolds.reservationId, ids),
            eq(schema.reservationHolds.state, 'confirmed')
          )
        ),
    ]);
    const mine = <T extends { reservationId: number }>(list: T[], id: number) =>
      list.filter((x) => x.reservationId === id);
    return Promise.all(
      all.map((r) => {
        const record: Rec = {
          ...encodeRow(schema.reservations, r, RESERVATION_OMIT),
          bookingSid: r.bookingId,
          resourceSid: r.resourceId,
          items: mine(items, r.id).map((x) => encodeRow(schema.reservationItems, x, RES_ITEM_OMIT)),
          payments: mine(pays, r.id).map((x) =>
            encodeRow(schema.reservationPayments, x, RES_ITEM_OMIT)
          ),
          events: mine(events, r.id).map((x) =>
            encodeRow(schema.reservationEvents, x, RES_EVENT_OMIT)
          ),
          holds: mine(holds, r.id).map((x) => encodeRow(schema.reservationHolds, x, RES_ITEM_OMIT)),
        };
        return row('reservations', peopleKey.reservation(r.reference), record, r.status);
      })
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.reservations.id, status: schema.reservations.status })
      .from(schema.reservations)
      .where(eq(schema.reservations.reference, str(r.reference)))
      .limit(1);
    return hit ? { id: hit.id, label: hit.status } : null;
  },
  async write(record, _action, ctx) {
    const values = decodeOrThrow(schema.reservations, record, RESERVATION_OMIT, 'Reservation');
    const group = mapBookingGroupId(str(values.bookingGroupId), ctx.booking);
    if (group === null) throw badRequest('Its experience is not on this site.');
    const resource = str(values.resourceGroupId);
    const reservation = {
      ...(values as typeof schema.reservations.$inferInsert),
      bookingGroupId: group,
      resourceGroupId: resource ? (ctx.booking.option(resource) ?? resource) : resource,
      bookingId: typeof record.bookingSid === 'number' ? ctx.resolver.doc(record.bookingSid) : null,
      resourceId:
        typeof record.resourceSid === 'number' ? ctx.resolver.doc(record.resourceSid) : null,
      metadata: {
        ...((values.metadata as Rec | null) ?? {}),
        importedFrom: ctx.origin,
        importedAt: new Date().toISOString(),
      },
    };
    const items = rows(record.items).map((x) =>
      decodeOrThrow(schema.reservationItems, x, RES_ITEM_OMIT, 'Reservation line')
    );
    const pays = rows(record.payments).map((x) =>
      decodeOrThrow(schema.reservationPayments, x, RES_ITEM_OMIT, 'Payment')
    );
    const events = rows(record.events).map((x) =>
      decodeOrThrow(schema.reservationEvents, x, RES_EVENT_OMIT, 'Event')
    );
    const holds = rows(record.holds).map((x) =>
      decodeOrThrow(schema.reservationHolds, x, RES_ITEM_OMIT, 'Hold')
    );
    let dropped = 0;
    const existing = await this.match(record);
    await db().transaction(async (tx) => {
      let id: number;
      if (existing) {
        id = existing.id;
        await tx.update(schema.reservations).set(reservation).where(eq(schema.reservations.id, id));
        for (const t of [
          schema.reservationItems,
          schema.reservationPayments,
          schema.reservationEvents,
          schema.reservationHolds,
        ]) {
          await tx.delete(t).where(eq(t.reservationId, id));
        }
      } else {
        const [res] = await tx.insert(schema.reservations).values(reservation).$returningId();
        id = res.id;
      }
      for (const v of items)
        await tx
          .insert(schema.reservationItems)
          .values({ ...(v as typeof schema.reservationItems.$inferInsert), reservationId: id });
      for (const v of pays)
        await tx
          .insert(schema.reservationPayments)
          .values({ ...(v as typeof schema.reservationPayments.$inferInsert), reservationId: id });
      for (const v of events)
        await tx
          .insert(schema.reservationEvents)
          .values({ ...(v as typeof schema.reservationEvents.$inferInsert), reservationId: id });
      for (const v of holds) {
        const slotKey = mapSlotKey(str(v.slotKey), ctx.booking);
        if (slotKey === null) {
          dropped++;
          continue;
        }
        await tx.insert(schema.reservationHolds).values({
          ...(v as typeof schema.reservationHolds.$inferInsert),
          slotKey,
          reservationId: id,
        });
      }
    });
    return { outcome: existing ? 'updated' : 'created', ...(dropped ? { dropped } : {}) };
  },
  revalidate: () => undefined,
};

/** The experience a calendar key belongs to, for its dependency: `exp:<group>` or `res:<option id>`. */
async function slotBookingSid(slotKey: string): Promise<number | null> {
  if (slotKey.startsWith('exp:')) {
    const g = slotKey.slice(4);
    const m = /^doc:(\d+)$/.exec(g);
    if (m) return Number(m[1]);
    const [doc] = await db()
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(eq(schema.documents.translationGroupId, g))
      .limit(1);
    return doc?.id ?? null;
  }
  if (slotKey.startsWith('res:')) {
    const [doc] = await db()
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(
        sql`JSON_CONTAINS(JSON_EXTRACT(${schema.documents.data}, '$.options[*].id'), JSON_QUOTE(${slotKey.slice(4)}))`
      )
      .limit(1);
    return doc?.id ?? null;
  }
  return null;
}

const bookingSlots: TableAdapter = {
  family: 'bookingSlots',
  async list() {
    const all = await db().select().from(schema.bookingSlots);
    return Promise.all(
      all.map(async (s) => {
        const record = {
          ...encodeRow(schema.bookingSlots, s, ['id', 'version']),
          bookingSid: await slotBookingSid(s.slotKey),
        };
        return row(
          'bookingSlots',
          peopleKey.slot(s.slotKey, s.slotDate),
          record,
          s.closed ? 'closed' : `capacity ${s.capacity ?? '—'}`
        );
      })
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.bookingSlots.id })
      .from(schema.bookingSlots)
      .where(
        and(
          eq(schema.bookingSlots.slotKey, str(r.slotKey)),
          eq(schema.bookingSlots.slotDate, str(r.slotDate))
        )
      )
      .limit(1);
    return hit ? { id: hit.id, label: `${str(r.slotKey)} ${str(r.slotDate)}` } : null;
  },
  async write(record, _action, ctx) {
    const values = decodeOrThrow(schema.bookingSlots, record, ['id', 'version'], 'Availability');
    const slotKey = mapSlotKey(str(values.slotKey), ctx.booking);
    if (slotKey === null) throw badRequest('Its experience is not on this site.');
    const v = { ...(values as typeof schema.bookingSlots.$inferInsert), slotKey };
    const existing = await this.match({ slotKey, slotDate: values.slotDate });
    if (existing) {
      await db().update(schema.bookingSlots).set(v).where(eq(schema.bookingSlots.id, existing.id));
      return { outcome: 'updated' };
    }
    await db().insert(schema.bookingSlots).values(v);
    return { outcome: 'created' };
  },
  revalidate: () => undefined,
};

// ── Admin roles & users ─────────────────────────────────────────────────────

function refuseAboveAuthority(refused: string[], what: string): void {
  if (refused.length) {
    throw badRequest(
      `${what} grants what you do not hold yourself (${refused.slice(0, 5).join(', ')}).`
    );
  }
}

const roles: TableAdapter = {
  family: 'roles',
  async list() {
    const all = await db().select().from(schema.adminRoles);
    return Promise.all(
      all.map((r) =>
        row(
          'roles',
          peopleKey.role(r.name),
          { name: r.name, permissions: r.permissions },
          `${r.permissions.length} permission(s)`
        )
      )
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.adminRoles.id, name: schema.adminRoles.name })
      .from(schema.adminRoles)
      .where(eq(schema.adminRoles.name, str(r.name)))
      .limit(1);
    return hit ? { id: hit.id, label: hit.name } : null;
  },
  async write(record, _action, ctx) {
    const name = str(record.name).trim();
    if (!name || name.length > 64)
      throw badRequest('A role needs a name of at most 64 characters.');
    const perms = Array.isArray(record.permissions)
      ? record.permissions.filter((p): p is string => typeof p === 'string')
      : [];
    const { kept, unknown, refused } = checkGrantable(perms, ctx.perms);
    refuseAboveAuthority(refused, 'This role');
    const existing = await this.match({ name });
    if (existing)
      await db()
        .update(schema.adminRoles)
        .set({ permissions: kept })
        .where(eq(schema.adminRoles.id, existing.id));
    else await db().insert(schema.adminRoles).values({ name, permissions: kept });
    return {
      outcome: existing ? 'updated' : 'created',
      ...(unknown.length
        ? { message: `Left out permissions this site does not have: ${unknown.join(', ')}.` }
        : {}),
    };
  },
  revalidate: () => undefined,
};

const USER_FIELDS = ['email', 'name', 'locale', 'disabledAt', 'createdAt'] as const;

const users: TableAdapter = {
  family: 'users',
  async list(opts: ExportOptions = {}) {
    const all = await db().select().from(schema.adminUsers);
    const links = await db()
      .select({ userId: schema.adminUserRoles.userId, name: schema.adminRoles.name })
      .from(schema.adminUserRoles)
      .innerJoin(schema.adminRoles, eq(schema.adminRoles.id, schema.adminUserRoles.roleId));
    return Promise.all(
      all.map((u) => {
        const record: Rec = {
          // Never: MFA method, TOTP seed, recovery codes, sessions, last sign-in.
          ...encodeRow(
            schema.adminUsers,
            u,
            Object.keys(u).filter((k) => !(USER_FIELDS as readonly string[]).includes(k))
          ),
          roles: links.filter((l) => l.userId === u.id).map((l) => l.name),
          ...(opts.includePasswordHashes ? { passwordHash: u.passwordHash } : {}),
        };
        return row('users', peopleKey.user(u.email), record, u.disabledAt ? 'disabled' : 'active');
      })
    );
  },
  async match(r) {
    const [hit] = await db()
      .select({ id: schema.adminUsers.id, email: schema.adminUsers.email })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, str(r.email).toLowerCase()))
      .limit(1);
    return hit ? { id: hit.id, label: hit.email } : null;
  },
  async write(record, _action, ctx) {
    const omit = [
      'id',
      'passwordHash',
      'lastLoginAt',
      'mfaMethod',
      'totpSecretEncrypted',
      'mfaEnrolledAt',
      'totpLastStep',
      'updatedAt',
    ];
    const values = decodeOrThrow(
      schema.adminUsers,
      { ...record, passwordHash: undefined },
      omit,
      'User'
    );
    values.email = str(values.email).toLowerCase();
    const existing = await this.match(record);
    if (existing?.id === ctx.userId)
      throw badRequest('This is your own account; it is not changed by an import.');

    // Roles by name, on this site; the user may hold nothing the importer could not grant.
    const names = Array.isArray(record.roles)
      ? record.roles.filter((n): n is string => typeof n === 'string')
      : [];
    const found = names.length
      ? await db().select().from(schema.adminRoles).where(inArray(schema.adminRoles.name, names))
      : [];
    const missing = names.filter((n) => !found.some((f) => f.name === n));
    refuseAboveAuthority(
      checkGrantable(
        found.flatMap((r) => r.permissions),
        ctx.perms
      ).refused,
      'This account'
    );

    const hash =
      ctx.importPasswordHashes && typeof record.passwordHash === 'string'
        ? record.passwordHash
        : null;
    let id: number;
    if (existing) {
      id = existing.id;
      await db()
        .update(schema.adminUsers)
        .set({
          ...(values as Partial<typeof schema.adminUsers.$inferInsert>),
          ...(hash ? { passwordHash: hash } : {}),
        })
        .where(eq(schema.adminUsers.id, id));
      await db().delete(schema.adminUserRoles).where(eq(schema.adminUserRoles.userId, id));
    } else {
      const [res] = await db()
        .insert(schema.adminUsers)
        .values({
          ...(values as typeof schema.adminUsers.$inferInsert),
          passwordHash: hash ?? (await unusablePassword()),
        })
        .$returningId();
      id = res.id;
    }
    for (const r of found)
      await db().insert(schema.adminUserRoles).values({ userId: id, roleId: r.id });
    const notes = [
      !existing && !hash
        ? 'No password was brought over: set one on the Users screen before this person can sign in.'
        : '',
      'Two-factor sign-in is never transferred; they set it up again.',
      missing.length ? `Roles not on this site, left out: ${missing.join(', ')}.` : '',
    ].filter(Boolean);
    return { outcome: existing ? 'updated' : 'created', message: notes.join(' ') };
  },
  revalidate: () => undefined,
};

export const PEOPLE_ADAPTERS: Readonly<Record<PeopleFamily, TableAdapter>> = {
  customers,
  subscribers,
  suppressions,
  productReviews,
  orders,
  reservations,
  bookingSlots,
  roles,
  users,
};

export type { TableWriteCtx };
