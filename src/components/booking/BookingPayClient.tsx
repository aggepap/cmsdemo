'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useCallback, useState } from 'react';

import { PaymentMethodPicker } from '@/components/checkout/PaymentMethodPicker';
import { Button } from '@/components/ui/Button';
import { formatPrice } from '@/lib/money';
import { track } from '@/lib/analytics/runtime';

/**
 * The payment surface behind a booking's pay link.
 *
 * With several methods enabled the customer picks one first; each option
 * states the surcharge it adds, and the amounts below follow the pick. Then
 * three shapes, decided by what the server's `start()` returns rather than by
 * anything this component knows about gateways:
 *   - a `clientSecret`  → mount Stripe's Payment Element in place
 *   - a `redirectUrl`   → send the customer to the provider (PayPal, Viva, Klarna)
 *   - neither           → bank transfer was picked: the booking is confirmed
 *                         unpaid, so show how to transfer
 *
 * Bank transfer as the ONLY method has nothing to press: the page just says
 * how to pay, as it always has.
 *
 * The amount charged can exceed the amount due when a payment surcharge
 * applies; both are shown before the customer commits, because a figure that
 * first appears on a bank statement is one nobody agreed to.
 */

export interface BookingPayLabels {
  amountDue: string;
  depositDue: string;
  surcharge: string;
  totalCharged: string;
  payNow: string;
  paying: string;
  bankTransfer: string;
  genericError: string;
  returned: string;
  /** Legend of the method chooser. */
  method: string;
  /** The button when bank transfer is picked — it confirms, it does not pay. */
  confirmBankTransfer: string;
}

/** One enabled method, priced for this booking (see `bookingPayOptions`). */
export interface BookingPayMethod {
  key: string;
  label: string;
  /** False for bank transfer. */
  online: boolean;
  surcharge: number;
  /** `amountDue + surcharge` — what this method actually charges. */
  chargeable: number;
}

export interface BookingPayClientProps {
  reference: string;
  token: string;
  locale: string;
  currency: string;
  /** Owed on the booking, before any surcharge. */
  amountDue: number;
  isDeposit: boolean;
  /** The enabled methods, in the admin's order; the first is preselected. Never empty. */
  methods: BookingPayMethod[];
  publishableKey: string | null;
  labels: BookingPayLabels;
  /** `purchase` parameters built by the server, sent once the card is taken here. */
  analytics?: Record<string, unknown>;
}

/**
 * Loaded once per publishable key and cached at module scope: `loadStripe`
 * injects a script tag, and calling it per render would add one each time.
 */
const stripeCache = new Map<string, Promise<Stripe | null>>();
function stripeFor(key: string): Promise<Stripe | null> {
  let promise = stripeCache.get(key);
  if (!promise) {
    promise = loadStripe(key);
    stripeCache.set(key, promise);
  }
  return promise;
}

export function BookingPayClient(props: BookingPayClientProps) {
  const { labels, currency, locale, methods } = props;
  const [methodKey, setMethodKey] = useState(methods[0]?.key ?? '');
  const selected = methods.find((m) => m.key === methodKey) ?? methods[0];
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  /** Bank transfer picked and the booking confirmed: all that is left is to say how to pay. */
  const [bankTransferChosen, setBankTransferChosen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Captured on click rather than during render: this component server-renders
   * first, and `window` does not exist there.
   */
  const [returnUrl, setReturnUrl] = useState('');

  const money = useCallback(
    (minor: number) => formatPrice(minor / 100, currency, locale),
    [currency, locale]
  );

  /**
   * Ask the server to begin a payment.
   *
   * The amount is NOT sent — the server recomputes what is owed from the
   * reservation, so a tampered request cannot pay less than the booking costs.
   */
  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    setReturnUrl(
      `${window.location.origin}${window.location.pathname}?t=${encodeURIComponent(props.token)}&return=1`
    );
    try {
      const res = await fetch('/api/cms/booking/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: props.reference, t: props.token, method: selected?.key }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body?.message ?? labels.genericError);
        return;
      }

      const data = body.data as { clientSecret: string | null; redirectUrl: string | null };
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
        return;
      }
      if (data.clientSecret) {
        setClientSecret(data.clientSecret);
        return;
      }
      if (selected && !selected.online) {
        setBankTransferChosen(true);
        return;
      }
      setError(labels.genericError);
    } catch {
      setError(labels.genericError);
    } finally {
      setStarting(false);
    }
  }, [props.reference, props.token, labels.genericError, selected]);

  const stripePromise = props.publishableKey ? stripeFor(props.publishableKey) : null;
  const surcharge = selected?.surcharge ?? 0;
  const chargeable = selected?.chargeable ?? props.amountDue;
  // Bank transfer as the only method: nothing to choose and nothing to press.
  const onlyBankTransfer = methods.length === 1 && !methods[0].online;
  const showBankTransfer = onlyBankTransfer || bankTransferChosen;
  const choosing = !clientSecret && !showBankTransfer;

  return (
    <section className="border-warm-gold/40 bg-warm-gold/10 mt-6 rounded-sm border p-6">
      <p className="text-sm text-neutral-700">
        {props.isDeposit ? labels.depositDue : labels.amountDue}
      </p>
      <p className="font-display mt-1 text-3xl font-semibold">{money(props.amountDue)}</p>

      {choosing && (
        <div className="mt-4">
          <PaymentMethodPicker
            legend={labels.method}
            name="booking-payment-method"
            options={methods.map((m) => ({
              key: m.key,
              label: m.label,
              hint: m.surcharge > 0 ? `+ ${money(m.surcharge)}` : undefined,
            }))}
            value={selected?.key ?? ''}
            onChange={setMethodKey}
          />
        </div>
      )}

      {surcharge > 0 && (
        <dl className="border-warm-gold/30 mt-3 flex flex-col gap-1 border-t pt-3 text-sm text-neutral-700">
          <div className="flex justify-between">
            <dt>{labels.surcharge}</dt>
            <dd>{money(surcharge)}</dd>
          </div>
          <div className="text-midnight-navy flex justify-between font-medium">
            <dt>{labels.totalCharged}</dt>
            <dd>{money(chargeable)}</dd>
          </div>
        </dl>
      )}

      {/* Bank transfer: the date is still held, only the money moves
          differently. */}
      {showBankTransfer && <p className="mt-3 text-sm text-neutral-700">{labels.bankTransfer}</p>}

      {choosing && selected && (
        <div className="mt-4">
          <Button type="button" onClick={start} disabled={starting} size="sm">
            {starting
              ? labels.paying
              : selected.online
                ? labels.payNow
                : labels.confirmBankTransfer}
          </Button>
        </div>
      )}

      {clientSecret && stripePromise && (
        <div className="mt-4">
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <StripeCardForm
              labels={labels}
              amount={money(chargeable)}
              returnUrl={returnUrl}
              onError={setError}
              onPaid={
                props.analytics
                  ? () => {
                      const params = props.analytics ?? {};
                      track('purchase', params, { eventId: props.reference, once: `purchase:${props.reference}` });
                    }
                  : undefined
              }
            />
          </Elements>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The Element itself, plus confirmation.
 *
 * Separate because `useStripe`/`useElements` only work inside `<Elements>`.
 * `redirect: 'if_required'` keeps a plain card payment on this page and only
 * navigates when the bank demands 3-D Secure.
 */
function StripeCardForm({
  labels,
  amount,
  returnUrl,
  onError,
  onPaid,
}: {
  labels: BookingPayLabels;
  amount: string;
  returnUrl: string;
  onError: (message: string) => void;
  onPaid?: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const confirm = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!stripe || !elements) return;
      setBusy(true);
      onError('');

      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      });

      if (error) {
        // Stripe's own messages are customer-facing and localised; a generic
        // fallback covers the ones that are not (network, integration).
        onError(error.message ?? labels.genericError);
        setBusy(false);
        return;
      }
      // Succeeded without leaving the page. The reservation is NOT updated from
      // here — the webhook is what moves it, so this only reassures the
      // customer while that lands.
      if (paymentIntent && ['succeeded', 'processing'].includes(paymentIntent.status)) {
        onPaid?.();
        setDone(true);
      }
      setBusy(false);
    },
    [stripe, elements, returnUrl, labels.genericError, onError, onPaid]
  );

  if (done) {
    return <p className="text-sm text-neutral-700">{labels.returned}</p>;
  }

  return (
    <form onSubmit={confirm} className="flex flex-col gap-4">
      <PaymentElement />
      <Button type="submit" disabled={!stripe || busy} size="sm">
        {busy ? labels.paying : `${labels.payNow} — ${amount}`}
      </Button>
    </form>
  );
}
