'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import type { QuotedMethod } from '@/cms/modules/commerce';
import { formatPrice } from '@/lib/money';

import { LockerPicker } from './LockerPicker';
import { shippingMethodsRequest } from './shipping-methods-request';

/**
 * How the parcel arrives.
 *
 * A radio group, because it is a single choice among a few — and because a
 * radio group is what a keyboard and a screen reader already know how to
 * operate. The quote is re-fetched whenever the address changes, since a
 * different country can mean a different zone, different prices, or nothing at
 * all.
 */
export function ShippingMethodPicker({
  country,
  postal,
  items,
  subtotalCents,
  currency,
  locale,
  paymentMethod,
  value,
  locker,
  onChange,
}: {
  country: string;
  postal: string;
  /** The cart lines — the route weighs them, and weight tiers are priced on it. */
  items: { slug: string; variationId?: string; quantity: number }[];
  subtotalCents: number;
  currency: string;
  locale: string;
  /** The customer's payment method — decides whether cash-on-delivery methods are offered. */
  paymentMethod: string;
  value: number | null;
  locker: { id: string; name: string } | null;
  onChange: (next: {
    methodId: number | null;
    locker: { id: string; name: string } | null;
    /** The chosen method as quoted — what the summary charges, as the server will. */
    method: QuotedMethod | null;
  }) => void;
}) {
  const t = useTranslations('checkout');
  const [methods, setMethods] = useState<QuotedMethod[] | null>(null);
  // Read by the fetch without re-running it on every pick.
  const latest = useRef({ value, locker, onChange });
  useEffect(() => {
    latest.current = { value, locker, onChange };
  });
  const itemsKey = JSON.stringify(
    items.map((i) => ({ slug: i.slug, variationId: i.variationId, quantity: i.quantity }))
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // An address with no country cannot be quoted; resolved asynchronously so
      // the effect never sets state during its own run.
      const clear = () => {
        if (latest.current.value !== null) {
          latest.current.onChange({ methodId: null, locker: null, method: null });
        }
      };
      if (!country.trim()) {
        if (!cancelled) {
          setMethods(null);
          clear();
        }
        return;
      }
      try {
        const res = await fetch('/api/cms/commerce/shipping-quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            shippingMethodsRequest({
              country,
              subtotalCents,
              paymentMethod,
              locale,
              items: JSON.parse(itemsKey),
            })
          ),
        });
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { methods?: QuotedMethod[] };
        } | null;
        if (cancelled) return;
        const next = body?.ok ? (body.data?.methods ?? []) : [];
        setMethods(next);
        /*
         * Keep the choice in step with the fresh list: the same method re-priced
         * for the new address or payment, the first one when nothing was chosen
         * yet (an order must name one), or none when it is no longer offered.
         */
        const { value: current, locker: currentLocker, onChange: emit } = latest.current;
        const kept = next.find((method) => method.id === current);
        const picked = kept ?? next[0] ?? null;
        emit({
          methodId: picked?.id ?? null,
          locker: kept ? currentLocker : null,
          method: picked,
        });
      } catch {
        if (!cancelled) {
          setMethods([]);
          clear();
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [country, subtotalCents, paymentMethod, locale, itemsKey]);

  // No methods defined at all: the shop uses its single shipping calculation,
  // and there is nothing for the customer to choose.
  if (methods === null || methods.length === 0) return null;

  const chosen = methods.find((method) => method.id === value);

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="font-display text-midnight-navy mb-1 text-lg font-semibold">
        {t('shippingMethod')}
      </legend>
      {methods.map((method) => (
        <label
          key={method.id}
          className="border-border-soft flex cursor-pointer items-center gap-3 rounded-sm border p-3"
        >
          <input
            type="radio"
            name="shipping-method"
            className="accent-warm-gold-deep h-4 w-4"
            checked={value === method.id}
            onChange={() => onChange({ methodId: method.id, locker: null, method })}
          />
          <span className="flex-1">
            <span className="font-body text-text-primary block text-sm font-medium">
              {method.name}
            </span>
            {method.etaMinDays !== null ? (
              <span className="font-body text-text-muted block text-xs">
                {t('etaDays', {
                  min: method.etaMinDays,
                  max: method.etaMaxDays ?? method.etaMinDays,
                })}
              </span>
            ) : null}
          </span>
          <span className="font-body text-text-primary text-sm">
            {method.cost === 0
              ? t('freeShipping')
              : formatPrice(method.cost / 100, currency, locale)}
          </span>
        </label>
      ))}

      {chosen?.kind === 'locker' ? (
        <LockerPicker
          postal={postal}
          value={locker}
          onChange={(next) => onChange({ methodId: chosen.id, locker: next, method: chosen })}
        />
      ) : null}
    </fieldset>
  );
}
