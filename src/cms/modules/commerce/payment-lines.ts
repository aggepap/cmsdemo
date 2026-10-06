/**
 * An order as the lines a gateway is told about, with VAT.
 *
 * Prices in this shop are VAT-inclusive and stay that way; these lines only say
 * WHICH rate is inside each amount, for gateways that itemise (Klarna). The
 * rules:
 *
 *  - a product line carries its product's rate (`vatRate`, a percentage on the
 *    product), or the shop default (Settings → Ecommerce → VAT rate);
 *  - a gift card product is 0%: a multi-purpose voucher is taxed when spent,
 *    not when sold;
 *  - a coupon discount reduces each rate's taxable amount in proportion, so it
 *    becomes one discount line per rate, summing exactly to the discount;
 *  - shipping, gift wrap and the payment surcharge follow the main supply, at
 *    the default rate;
 *  - gift cards spent on the order are a 0% credit: a way of paying, not a
 *    price reduction.
 *
 * The lines add up to `subtotal − discount + shipping + surcharge + giftWrap −
 * giftCards`, which is exactly the amount the gateway is asked for.
 *
 * Pure — the checkout reads the settings and products and hands them over.
 */
import { vatPercentToBps, type PaymentLine } from '../../core';

/** A product's VAT rate in basis points: its own, or the shop default. Gift cards are 0%. */
export function productVatBps(data: Record<string, unknown>, defaultBps: number): number {
  if (data.productType === 'giftcard') return 0;
  return vatPercentToBps(data.vatRate, defaultBps);
}

export interface OrderLineLabels {
  shipping: string;
  discount: string;
  giftWrap: string;
  surcharge: string;
  giftCard: string;
}

const LABELS: Record<'el' | 'en', OrderLineLabels> = {
  el: {
    shipping: 'Μεταφορικά',
    discount: 'Έκπτωση',
    giftWrap: 'Συσκευασία δώρου',
    surcharge: 'Χρέωση τρόπου πληρωμής',
    giftCard: 'Δωροκάρτα',
  },
  en: {
    shipping: 'Shipping',
    discount: 'Discount',
    giftWrap: 'Gift wrap',
    surcharge: 'Payment fee',
    giftCard: 'Gift card',
  },
};

/** Line names in the order's language — they appear on the customer's statement. */
export function orderLineLabels(locale: string): OrderLineLabels {
  return locale.toLowerCase().startsWith('el') ? LABELS.el : LABELS.en;
}

export interface OrderLineItem {
  name: string;
  sku: string | null;
  type: 'physical' | 'digital';
  /** Minor units, VAT included. */
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  /** Basis points — see `productVatBps`. */
  vatRate: number;
}

/**
 * Split `discount` across the VAT rates in proportion to each rate's share of
 * the goods. Floors each share and gives the remainder to the largest group,
 * so the parts always sum to the discount exactly.
 */
function splitDiscount(
  items: readonly OrderLineItem[],
  discount: number,
  defaultBps: number
): [number, number][] {
  const groups = new Map<number, number>();
  for (const item of items)
    groups.set(item.vatRate, (groups.get(item.vatRate) ?? 0) + item.lineTotal);
  const base = [...groups.values()].reduce((a, b) => a + b, 0);
  if (base <= 0) return [[defaultBps, discount]];

  const parts = [...groups.entries()].map(
    ([rate, total]) => [rate, Math.floor((discount * total) / base)] as [number, number]
  );
  const remainder = discount - parts.reduce((sum, [, amount]) => sum + amount, 0);
  if (remainder !== 0) {
    let largest = 0;
    for (let i = 1; i < parts.length; i++) {
      if ((groups.get(parts[i][0]) ?? 0) > (groups.get(parts[largest][0]) ?? 0)) largest = i;
    }
    parts[largest][1] += remainder;
  }
  return parts.filter(([, amount]) => amount !== 0);
}

export function orderPaymentLines(args: {
  items: readonly OrderLineItem[];
  /** All minor units, positive. */
  discount: number;
  shipping: number;
  surcharge: number;
  giftWrap: number;
  /** Gift card balance spent on this order. */
  giftCards: number;
  defaultVatBps: number;
  labels: OrderLineLabels;
}): PaymentLine[] {
  const { labels, defaultVatBps } = args;
  const lines: PaymentLine[] = args.items.map((item) => ({
    type: item.type,
    name: item.name,
    ...(item.sku ? { reference: item.sku } : {}),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalAmount: item.lineTotal,
    vatRate: item.vatRate,
  }));

  if (args.discount > 0) {
    const parts = splitDiscount(args.items, args.discount, defaultVatBps);
    for (const [rate, amount] of parts) {
      lines.push({
        type: 'discount',
        // Several discount lines are told apart by their rate.
        name: parts.length > 1 ? `${labels.discount} (${rate / 100}%)` : labels.discount,
        quantity: 1,
        unitPrice: -amount,
        totalAmount: -amount,
        vatRate: rate,
      });
    }
  }

  const charge = (type: PaymentLine['type'], name: string, amount: number) => {
    if (amount > 0)
      lines.push({
        type,
        name,
        quantity: 1,
        unitPrice: amount,
        totalAmount: amount,
        vatRate: defaultVatBps,
      });
  };
  charge('shipping_fee', labels.shipping, args.shipping);
  charge('physical', labels.giftWrap, args.giftWrap);
  charge('surcharge', labels.surcharge, args.surcharge);

  if (args.giftCards > 0) {
    lines.push({
      type: 'gift_card',
      name: labels.giftCard,
      quantity: 1,
      unitPrice: -args.giftCards,
      totalAmount: -args.giftCards,
      vatRate: 0,
    });
  }
  return lines;
}
