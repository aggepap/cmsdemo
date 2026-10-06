/**
 * Shipping cost engine — admin-configurable (Settings → Shipping).
 *
 * Config is stored as a structured JSON blob under `ecommerce.shipping`. The
 * checkout re-computes shipping server-side (never trusts the client), the same
 * way the storefront quote endpoint does. Charges are authored in MAJOR units;
 * this module returns MINOR units (cents) to match the orders tables. VAT is
 * included in prices, so there is no tax line.
 */
import 'server-only';

import { z } from 'zod';

import {
  choosePaymentProvider,
  createRoute,
  ECOMMERCE_SHIPPING_KEY,
  getPaymentProvider,
  getSetting,
  isCashOnDelivery,
  manualProvider,
  ok,
  type PaymentProvider,
} from '../../core';
import { getEnabledPaymentProviderKeys } from './payments';
import { getProduct, getSiteCurrency, resolvePrice } from './read';

export type ShippingMethod = 'flat' | 'weight' | 'zone';

/** How the order reaches the customer: delivered, or collected in store (§8). */
export type DeliveryMethod = 'ship' | 'pickup';

/** Additional charge applied when total cart weight ≥ `minWeight`. */
export interface ShippingWeightTier {
  minWeight: number;
  charge: number;
}
/** Flat charge for a set of destination countries. */
export interface ShippingZone {
  name: string;
  countries: string[];
  charge: number;
}
/** Extra fee for a specific payment provider (e.g. cash-on-delivery). */
export interface PaymentSurcharge {
  provider: string;
  charge: number;
}

/** A store the customer can collect from (§8). `id` is stored on the order. */
export interface PickupLocation {
  id: string;
  name: string;
  address?: string;
  /** Free-text opening hours, shown at checkout. */
  hours?: string;
}

/** Store-pickup option — off by default, so nothing changes for existing sites. */
export interface PickupConfig {
  enabled: boolean;
  /** Handling charge for collecting in store (major units; normally 0). */
  charge: number;
  locations: PickupLocation[];
}

export interface ShippingConfig {
  method: ShippingMethod;
  /** Standard charge (major units). */
  baseCharge: number;
  /** Free shipping when subtotal ≥ this (major units). 0 = disabled. */
  freeThreshold: number;
  weightTiers: ShippingWeightTier[];
  zones: ShippingZone[];
  paymentSurcharges: PaymentSurcharge[];
  pickup: PickupConfig;
}

export const DEFAULT_PICKUP_CONFIG: PickupConfig = { enabled: false, charge: 0, locations: [] };

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  method: 'flat',
  baseCharge: 0,
  freeThreshold: 0,
  weightTiers: [],
  zones: [],
  paymentSurcharges: [],
  pickup: DEFAULT_PICKUP_CONFIG,
};

const toCents = (major: number): number => Math.round((Number(major) || 0) * 100);

/**
 * The payment surcharge for one method, in minor units.
 *
 * Keyed on the method, so a cash-on-delivery fee never lands on a bank
 * transfer. One exception, for shops configured before the two were split: a
 * fee saved against `manual` keeps applying to `cod` until a `cod` row exists.
 * `manual` always counted as cash on delivery to the shipping rules, so its fee
 * was a COD fee; a bank transfer starts free rather than inheriting it.
 */
export function paymentSurchargeCents(
  entries: readonly { provider?: string; charge?: number }[],
  providerKey: string,
): number {
  const own = entries.find((p) => p.provider === providerKey);
  const legacy = isCashOnDelivery(providerKey) ? entries.find((p) => p.provider === manualProvider.key) : undefined;
  return toCents((own ?? legacy)?.charge ?? 0);
}

/**
 * Normalise the stored pickup block. Locations need a name to be selectable;
 * a missing `id` falls back to the index so older/hand-edited settings still
 * resolve to a stable key.
 */
export function normalisePickup(raw: unknown): PickupConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_PICKUP_CONFIG;
  const cfg = raw as Partial<PickupConfig>;
  const locations = (Array.isArray(cfg.locations) ? cfg.locations : [])
    .map((loc, i) => ({
      id: String(loc?.id ?? '').trim() || `loc-${i + 1}`,
      name: String(loc?.name ?? '').trim(),
      address: String(loc?.address ?? '').trim() || undefined,
      hours: String(loc?.hours ?? '').trim() || undefined,
    }))
    .filter((loc) => loc.name.length > 0);
  return { enabled: cfg.enabled === true, charge: Number(cfg.charge) || 0, locations };
}

/** Read + normalise the stored shipping config (falls back to defaults). */
export async function getShippingConfig(): Promise<ShippingConfig> {
  const raw = await getSetting<Partial<ShippingConfig>>(ECOMMERCE_SHIPPING_KEY);
  if (!raw || typeof raw !== 'object') return DEFAULT_SHIPPING_CONFIG;
  return {
    method: raw.method === 'weight' || raw.method === 'zone' ? raw.method : 'flat',
    baseCharge: Number(raw.baseCharge) || 0,
    freeThreshold: Number(raw.freeThreshold) || 0,
    weightTiers: Array.isArray(raw.weightTiers) ? raw.weightTiers : [],
    zones: Array.isArray(raw.zones) ? raw.zones : [],
    paymentSurcharges: Array.isArray(raw.paymentSurcharges) ? raw.paymentSurcharges : [],
    pickup: normalisePickup(raw.pickup),
  };
}

/**
 * Whether this cart may be collected in store: the option is on, and there's
 * something physical to collect (a digital-only cart has nothing to hand over).
 */
export function pickupAvailable(config: ShippingConfig): boolean {
  return config.pickup.enabled;
}

/**
 * The chosen pickup location. With locations configured an unknown/absent id
 * resolves to nothing (the caller rejects it); with none configured there is a
 * single implicit "the store", so `undefined` is a valid answer.
 */
export function findPickupLocation(
  config: ShippingConfig,
  id: string | undefined,
): PickupLocation | undefined {
  const list = config.pickup.locations;
  if (list.length === 0) return undefined;
  const wanted = (id ?? '').trim();
  return list.find((loc) => loc.id === wanted);
}

export interface ShippingContext {
  subtotalCents: number;
  /** Total cart weight in the product weight unit (assumed kg). */
  totalWeight: number;
  country: string;
  providerKey: string;
  /** `pickup` charges the store-pickup fee instead of shipping. Default `ship`. */
  delivery?: DeliveryMethod;
}

/** Compute shipping + payment surcharge, both in minor units (cents). */
export function computeShipping(
  config: ShippingConfig,
  ctx: ShippingContext,
): { shipping: number; surcharge: number } {
  // Store pickup replaces the shipping calculation with its own (usually zero)
  // handling fee — no zones, no weight tiers, no free-shipping threshold. An
  // unavailable pickup falls back to shipping (the write path rejects it too).
  if (ctx.delivery === 'pickup' && pickupAvailable(config)) {
    return {
      shipping: toCents(config.pickup.charge),
      surcharge: paymentSurchargeCents(config.paymentSurcharges, ctx.providerKey),
    };
  }

  let shipping = 0;
  const free = config.freeThreshold > 0 && ctx.subtotalCents >= toCents(config.freeThreshold);
  if (!free) {
    if (config.method === 'flat') {
      shipping = toCents(config.baseCharge);
    } else if (config.method === 'weight') {
      shipping = toCents(config.baseCharge);
      const tier = [...config.weightTiers]
        .filter((t) => typeof t.minWeight === 'number')
        .sort((a, b) => b.minWeight - a.minWeight)
        .find((t) => ctx.totalWeight >= t.minWeight);
      if (tier) shipping += toCents(tier.charge);
    } else {
      const country = ctx.country.trim().toLowerCase();
      const zone = config.zones.find((z) =>
        (z.countries ?? []).some((c) => c.trim().toLowerCase() === country),
      );
      shipping = toCents(zone ? zone.charge : config.baseCharge);
    }
  }
  const surcharge = paymentSurchargeCents(config.paymentSurcharges, ctx.providerKey);
  return { shipping, surcharge };
}

/** Weight of one line's product (variation weight overrides product weight). */
export function lineWeight(data: Record<string, unknown>, variationId?: string): number {
  const variations = (Array.isArray(data.variations) ? data.variations : []) as {
    id?: string;
    weight?: number;
  }[];
  const v = variationId ? variations.find((x) => x.id === variationId) : undefined;
  if (typeof v?.weight === 'number') return v.weight;
  return typeof data.weight === 'number' ? data.weight : 0;
}

export interface QuoteLine {
  slug: string;
  variationId?: string;
  quantity: number;
  locale: string;
}

/**
 * The provider a quote is priced for: the customer's pick when it is enabled,
 * otherwise the default (first enabled) method. Lenient on purpose — a quote is
 * only a display, and `createOrder` refuses a bad pick with a proper error.
 */
async function quoteProvider(requested: string | undefined): Promise<PaymentProvider> {
  const enabled = await getEnabledPaymentProviderKeys();
  const choice = choosePaymentProvider(enabled, requested);
  return getPaymentProvider(choice.ok ? choice.key : enabled[0]);
}

/** Storefront shipping estimate for a cart + destination country (or pickup). */
export async function quoteShipping(
  lines: QuoteLine[],
  country: string,
  delivery: DeliveryMethod = 'ship',
  /** The payment method picked at checkout — its surcharge is part of the quote. */
  paymentMethod?: string,
): Promise<{
  shipping: number;
  surcharge: number;
  currency: string;
  /** What the lines weigh, worked out here — the method list is priced on it too. */
  totalWeight: number;
}> {
  const [config, currency, provider] = await Promise.all([
    getShippingConfig(),
    getSiteCurrency(),
    quoteProvider(paymentMethod),
  ]);
  let subtotalCents = 0;
  let totalWeight = 0;
  for (const line of lines) {
    const qty = Math.max(1, Math.floor(line.quantity));
    const doc = await getProduct(line.slug, line.locale);
    if (!doc) continue;
    const data = doc.data as Record<string, unknown>;
    subtotalCents += Math.round(resolvePrice(data, line.variationId) * 100) * qty;
    totalWeight += lineWeight(data, line.variationId) * qty;
  }
  const { shipping, surcharge } = computeShipping(config, {
    subtotalCents,
    totalWeight,
    country,
    providerKey: provider.key,
    delivery,
  });
  return { shipping, surcharge, currency, totalWeight };
}

/**
 * The quote route's body. Exported so the checkout's request builder is tested
 * against it (`test/commerce/shipping-methods-request.test.ts`).
 */
export const shippingQuoteBody = z.object({
  country: z.string().trim().max(64).optional(),
  /** Used by the method list's free-shipping thresholds. */
  subtotalCents: z.coerce.number().int().min(0).optional(),
  delivery: z.enum(['ship', 'pickup']).optional(),
  /** The payment method picked at checkout; decides the surcharge and cash-on-delivery methods. */
  paymentMethod: z.string().trim().max(32).optional(),
  locale: z.string().trim().max(8),
  items: z
    .array(
      z.object({
        slug: z.string().trim().max(191),
        variationId: z.string().trim().max(64).optional(),
        quantity: z.coerce.number().int().positive().max(999),
      }),
    )
    .max(100),
});

/** Public POST — live shipping estimate for the checkout. Module-gated by the binder. */
export function createShippingQuoteRoute() {
  return createRoute({
    rateLimit: { scope: 'commerce-shipping-quote', max: 60, windowMs: 60_000 },
    input: shippingQuoteBody,
    handler: async ({ input }) => {
      const { totalWeight, ...quote } = await quoteShipping(
        input.items.map((it) => ({ ...it, locale: input.locale })),
        input.country ?? '',
        input.delivery ?? 'ship',
        input.paymentMethod,
      );
      /*
       * The single estimate AND the list of methods, in one response. A shop
       * with no methods defined gets an empty list and the checkout shows no
       * chooser — which is exactly how it behaved before methods existed.
       */
      const { resolveShippingChoices } = await import('./shipping-service');
      const provider = await quoteProvider(input.paymentMethod);
      /*
       * Weight comes from the cart lines, as at checkout: quoting at 0 kg showed
       * a method with weight tiers cheaper than the order then charged. The
       * subtotal stays the browser's: it is the basket total the customer sees
       * (gift card amounts included), and checkout re-prices it anyway.
       */
      const methods = await resolveShippingChoices({
        country: input.country ?? '',
        subtotalCents: input.subtotalCents ?? 0,
        totalWeight,
        paymentProvider: provider.key,
        // Same rule as checkout: only cash on delivery narrows the methods to
        // those that allow it. A bank transfer is paid before the parcel leaves.
        codSelected: isCashOnDelivery(provider.key),
      });
      return ok({ ...quote, methods });
    },
  });
}
