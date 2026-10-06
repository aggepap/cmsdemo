/**
 * The body `ShippingMethodPicker` posts to `/api/cms/commerce/shipping-quote`.
 *
 * Only the method list is wanted. It is priced on the subtotal, the
 * destination, the payment method (cash-on-delivery methods follow it) and the
 * basket's weight — which the route works out from the cart lines, so they are
 * sent too. Leaving `items` or `locale` out made every request fail validation,
 * which the picker read as "this shop has no delivery methods".
 * Checked against the route's schema in
 * `test/commerce/shipping-methods-request.test.ts`.
 */
export function shippingMethodsRequest(args: {
  country: string;
  subtotalCents: number;
  paymentMethod: string;
  locale: string;
  items?: { slug: string; variationId?: string; quantity: number }[];
}) {
  return {
    country: args.country,
    subtotalCents: args.subtotalCents,
    paymentMethod: args.paymentMethod,
    locale: args.locale,
    items: args.items ?? [],
  };
}
