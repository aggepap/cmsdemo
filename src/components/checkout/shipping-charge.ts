/**
 * What the checkout summary charges for delivery, in minor units.
 *
 * Once the customer has picked a delivery method, that method's own cost and
 * surcharge are the price — the same numbers `createOrder` charges. The legacy
 * estimate is only the answer while no method is chosen (or the shop has none).
 * Tested in `test/commerce/shipping-choice.test.ts`.
 */
export function checkoutShippingCharge(
  quote: { shipping: number; surcharge: number } | null,
  chosen: { cost: number; surcharge: number } | null
): { shipping: number; surcharge: number } {
  if (chosen) return { shipping: chosen.cost, surcharge: chosen.surcharge };
  return { shipping: quote?.shipping ?? 0, surcharge: quote?.surcharge ?? 0 };
}
