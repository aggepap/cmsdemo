/**
 * The GA4 `purchase` parameters for an order, built on the server from what the
 * order charged (REQ-5 §3). The browser sends the event; it does not do the sums.
 *
 * Amounts arrive in minor units and leave in major units, rounded to cents.
 * Prices include VAT (the shop's prices always do), so `value` is the order
 * total and `tax` is the VAT inside it: each line at its own rate, a discount
 * lowering the goods' VAT in proportion, shipping and the payment surcharge at
 * the shop's default rate. A gift card is an item; it is named by the product,
 * because its line label carries the recipient's name or email.
 *
 * Pure — no `server-only`, no database.
 */

export interface PurchaseLine {
  /** SKU when there is one, otherwise the product id. */
  itemId: string;
  name: string;
  variant?: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  vatBps: number;
  giftCard: boolean;
}

export interface PurchaseAnalyticsInput {
  reference: string;
  currency: string;
  total: number;
  lines: PurchaseLine[];
  shipping: number;
  surcharge: number;
  discount: number;
  coupon: string | null;
  defaultVatBps: number;
}

export interface PurchaseItem {
  item_id: string;
  item_name: string;
  item_variant?: string;
  item_category?: string;
  price: number;
  quantity: number;
}

export interface PurchaseAnalytics {
  transaction_id: string;
  value: number;
  tax: number;
  shipping: number;
  currency: string;
  coupon?: string;
  items: PurchaseItem[];
}

const major = (minor: number) => Math.round(minor) / 100;
const vatInside = (gross: number, bps: number) => (bps > 0 ? (gross * bps) / (10_000 + bps) : 0);

export function purchaseAnalytics(input: PurchaseAnalyticsInput): PurchaseAnalytics {
  const goods = input.lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const goodsVat = input.lines.reduce((sum, l) => sum + vatInside(l.lineTotal, l.vatBps), 0);
  const discountShare = goods > 0 ? Math.max(0, goods - input.discount) / goods : 0;
  const shipping = input.shipping + input.surcharge;
  const tax = goodsVat * discountShare + vatInside(shipping, input.defaultVatBps);

  return {
    transaction_id: input.reference,
    value: major(input.total),
    tax: major(tax),
    shipping: major(shipping),
    currency: input.currency,
    ...(input.coupon ? { coupon: input.coupon } : {}),
    items: input.lines.map((l) => ({
      item_id: l.itemId,
      item_name: l.name,
      ...(l.giftCard ? { item_category: 'gift_card' } : l.variant ? { item_variant: l.variant } : {}),
      price: major(l.unitPrice),
      quantity: l.quantity,
    })),
  };
}

/** The Conversions API `custom_data` of a Purchase, from the order's own lines. */
export function orderPurchaseCustomData(input: {
  reference: string;
  total: number;
  currency: string;
  lines: { sku: string | null; productId: number | null; quantity: number }[];
}) {
  const contents = input.lines.map((l) => ({ id: l.sku || String(l.productId ?? ''), quantity: l.quantity }));
  return {
    value: major(input.total),
    currency: input.currency,
    order_id: input.reference,
    content_type: 'product',
    content_ids: contents.map((c) => c.id),
    contents,
    num_items: contents.reduce((n, c) => n + c.quantity, 0),
  };
}
