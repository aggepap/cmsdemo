/**
 * Storefront lines as GA4 `items`, for the events the browser builds itself
 * (add_to_cart, view_cart, begin_checkout…). `purchase` is built on the server
 * instead (`purchaseAnalytics`), from what the order charged.
 *
 * A gift card's options label carries its recipient, so a gift card line is
 * reported as the product alone, categorised `gift_card`.
 */
export interface AnalyticsItem {
  item_id: string;
  item_name: string;
  item_variant?: string;
  item_category?: string;
  price: number;
  quantity: number;
}

export interface ItemSource {
  slug: string;
  sku?: string | null;
  title: string;
  optionsLabel?: string | null;
  /** Major units. */
  unitPrice: number;
  quantity: number;
  giftCard?: unknown;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function toAnalyticsItem(line: ItemSource): AnalyticsItem {
  return {
    item_id: line.sku || line.slug,
    item_name: line.title,
    ...(line.giftCard ? { item_category: 'gift_card' } : line.optionsLabel ? { item_variant: line.optionsLabel } : {}),
    price: cents(line.unitPrice),
    quantity: line.quantity,
  };
}

/** `items`, `value` and `currency` for a set of lines. */
export function cartItemsPayload(lines: readonly ItemSource[], currency: string) {
  return {
    items: lines.map(toAnalyticsItem),
    value: cents(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)),
    currency,
  };
}

/** `view_item_list`: the products a list shows, in order. */
export function productListPayload(
  listId: string,
  products: readonly { slug: string; title: string; price: number }[],
) {
  return {
    item_list_id: listId,
    items: products.map((p, index) => ({ item_id: p.slug, item_name: p.title, price: cents(p.price), index })),
  };
}

/** The `data-cms-item-*` attributes that make a product link a `select_item` click. */
export function productLinkAttributes(listId: string, product: { slug: string; title: string; price: number }) {
  return {
    'data-cms-item-id': product.slug,
    'data-cms-item-name': product.title,
    'data-cms-item-price': String(cents(product.price)),
    'data-cms-item-list': listId,
  };
}

/**
 * `purchase` for a reservation, from what the SERVER answered (`total` in minor
 * units): the booking is one item, the reference is the transaction id.
 */
export function bookingPurchasePayload(input: {
  reference: string;
  total: number;
  currency: string;
  itemId: string;
  itemName: string;
}) {
  const value = Math.round(input.total) / 100;
  return {
    transaction_id: input.reference,
    value,
    currency: input.currency,
    items: [{ item_id: input.itemId, item_name: input.itemName, item_category: 'booking', price: value, quantity: 1 }],
  };
}
