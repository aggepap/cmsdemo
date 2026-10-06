/**
 * Several payment methods at once, and the customer's pick among them.
 *
 * Each module's payment setting is a `multiselect`: the admin ticks the methods
 * the site takes, and the customer chooses one at checkout or on a booking's
 * pay page. The LIST is the admin's and the PICK is the customer's — and the
 * pick is only ever honoured when it is on the list. The booking pay route once
 * took a `method` from the body and used it directly, which let a caller pay
 * through any registered provider whatever the site had configured;
 * `choosePaymentProvider` is what keeps that closed.
 *
 * Pure, like the rest of `core/payments/index.ts`: the modules read the setting
 * and resolve the provider; this owns the rules.
 */
import {
  DEFAULT_ECOMMERCE_PAYMENT_PROVIDERS,
  ECOMMERCE_PAYMENT_PROVIDER_ALIASES,
  expandMultiValueAliases,
  parseMultiValue,
} from '../settings/schema';

import { manualProvider, OFFLINE_PROVIDER_KEYS } from './index';

/** How one module's list is read, beyond the stored value itself. */
export interface PaymentProviderListRules {
  /** Retired keys and what they now stand for, expanded in place. */
  aliases?: Readonly<Record<string, readonly string[]>>;
  /** What an empty (or wholly unknown) list means. Manual when not given. */
  fallback?: readonly string[];
}

/**
 * The shop's rules: a stored `manual` — from before bank transfer and cash on
 * delivery were split — stands for both, in its place, and nothing ticked
 * means both, as manual did.
 */
export const SHOP_PAYMENT_PROVIDER_RULES: PaymentProviderListRules = {
  aliases: ECOMMERCE_PAYMENT_PROVIDER_ALIASES,
  fallback: DEFAULT_ECOMMERCE_PAYMENT_PROVIDERS,
};

/**
 * The enabled provider keys, in the stored order — the first is the default.
 *
 * A value saved while the setting was a single `select` (`viva`) reads as a
 * list of one, so no stored value needed migrating. Unknown keys are dropped
 * rather than trusted, and an empty result means the offline fallback: a fresh
 * site, or one whose only gateway was removed, still takes orders offline
 * instead of failing every checkout.
 */
export function enabledPaymentProviderKeys(
  raw: unknown,
  known: readonly string[],
  rules: PaymentProviderListRules = {}
): string[] {
  const keys = expandMultiValueAliases(parseMultiValue(raw), rules.aliases).filter((key) =>
    known.includes(key)
  );
  return keys.length > 0 ? keys : [...(rules.fallback ?? [manualProvider.key])];
}

export type PaymentProviderChoice =
  | { ok: true; key: string }
  | {
      ok: false;
      /**
       * `required` — several methods are on and none was named. Not defaulted:
       * the methods can carry different surcharges, and charging one the
       * customer never saw is worse than asking.
       * `not_enabled` — the named method is not one the admin switched on.
       */
      reason: 'required' | 'not_enabled';
    };

/** Resolve the customer's requested method against the enabled list. */
export function choosePaymentProvider(
  enabled: readonly string[],
  requested: string | null | undefined
): PaymentProviderChoice {
  if (!requested) {
    return enabled.length === 1 ? { ok: true, key: enabled[0] } : { ok: false, reason: 'required' };
  }
  return enabled.includes(requested)
    ? { ok: true, key: requested }
    : { ok: false, reason: 'not_enabled' };
}

/** Does any enabled method take money online? Decides whether a booking waits for payment. */
export function anyOnlineProviderKey(keys: readonly string[]): boolean {
  return keys.some((key) => !OFFLINE_PROVIDER_KEYS.includes(key));
}

/** Is bank transfer / pay-on-delivery one of the enabled methods? */
export function offersManualPayment(keys: readonly string[]): boolean {
  return keys.includes(manualProvider.key);
}
