/**
 * An order as the guest lookup returns it (`POST /api/cms/commerce/order-lookup`).
 *
 * Anyone holding the reference and the email gets this, so it is an
 * ALLOW-LIST, field by field: what the order page shows and nothing else. It
 * used to spread the whole order — `metadata` with the consent record, the
 * phone, `codAmount` and the analytics context, and every line's full product
 * `snapshot` (all fields, cost price, stock). A column or metadata key added
 * later stays private until someone puts it here.
 *
 * Pure: `lookupOrder` reads, this shapes.
 */

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

interface OrderLike {
  reference: string;
  status: string;
  customerName: string | null;
  currency: string;
  subtotal: number;
  total: number;
  locale: string | null;
  notes: string | null;
  createdAt: Date;
  metadata: Rec | null;
  items: {
    id: number;
    name: string;
    sku: string | null;
    variantLabel: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    snapshot: Rec | null;
  }[];
  payments: {
    id: number;
    provider: string;
    status: string;
    amount: number;
    currency: string;
    method: string | null;
    createdAt: Date;
  }[];
}

/** The delivery details without the phone; the method's name and cost, not its id. */
function publicShipping(raw: unknown): Rec {
  const s = rec(raw);
  const out: Rec = {};
  for (const key of ['address1', 'city', 'postal', 'country', 'method', 'virtual'] as const) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  if (s.shippingMethod) {
    const m = rec(s.shippingMethod);
    out.shippingMethod = { name: m.name, courier: m.courier, kind: m.kind, cost: m.cost };
  }
  if (s.locker) out.locker = { name: rec(s.locker).name };
  if (s.pickup) {
    const p = rec(s.pickup);
    out.pickup = { name: p.name, address: p.address ?? null };
  }
  return out;
}

function publicMetadata(raw: Rec | null): Rec {
  const m = rec(raw);
  const out: Rec = { shipping: publicShipping(m.shipping) };
  if (m.costs) out.costs = m.costs;
  if (typeof m.coupon === 'string') out.coupon = m.coupon;
  if (m.gift) {
    const g = rec(m.gift);
    out.gift = { wrap: Boolean(g.wrap), message: str(g.message) };
  }
  return out;
}

/** The product's first photo, as it was when ordered — what the order page shows beside a line. */
function lineImage(snapshot: Rec | null): { uuid: string; alt: string } | null {
  const gallery = rec(snapshot).gallery;
  const first = Array.isArray(gallery) ? rec(gallery[0]) : {};
  const uuid = str(first.image);
  return uuid ? { uuid, alt: str(first.alt) ?? '' } : null;
}

export function publicOrder(order: OrderLike, opts: { paymentInstructions?: string | null }) {
  return {
    reference: order.reference,
    status: order.status,
    customerName: order.customerName,
    currency: order.currency,
    subtotal: order.subtotal,
    total: order.total,
    locale: order.locale,
    notes: order.notes,
    createdAt: order.createdAt,
    metadata: publicMetadata(order.metadata),
    items: order.items.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      variantLabel: i.variantLabel,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
      image: lineImage(i.snapshot),
    })),
    payments: order.payments.map((p) => ({
      id: p.id,
      provider: p.provider,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      createdAt: p.createdAt,
    })),
    /** How to pay, while a bank transfer is still owed; null otherwise. */
    paymentInstructions: opts.paymentInstructions ?? null,
  };
}
