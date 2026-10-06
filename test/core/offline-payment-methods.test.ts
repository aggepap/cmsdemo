/**
 * Bank transfer and cash on delivery, as two methods instead of one.
 *
 * The shop had a single offline provider, `manual`, labelled "Pay on delivery
 * or bank transfer" — and every rule keyed on "offline" treated it as cash on
 * delivery. So a customer who meant to pay by bank transfer was still offered
 * only COD-capable couriers, charged the COD surcharge, and booked on a COD
 * voucher. The two are different promises: a bank transfer is paid before the
 * parcel leaves, cash on delivery when it arrives.
 *
 * A stored `manual` is migrated on read (and on save) to BOTH new methods, so a
 * shop that took "manual" yesterday offers the same two ways to pay today,
 * now told apart.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  getPaymentProvider,
  isCashOnDelivery,
  isOnlineProvider,
  OFFLINE_PROVIDER_KEYS,
  paymentProviderKeys,
} from '@/cms/core/payments';
import {
  anyOnlineProviderKey,
  enabledPaymentProviderKeys,
  SHOP_PAYMENT_PROVIDER_RULES,
} from '@/cms/core/payments/choice';
import {
  BANK_TRANSFER_INSTRUCTIONS_KEYS,
  BOOKING_PAYMENT_PROVIDER_KEY,
  ECOMMERCE_PAYMENT_PROVIDER_KEY,
  ECOMMERCE_PAYMENT_PROVIDER_KEYS,
  MANAGED_SETTINGS,
  expandMultiValueAliases,
} from '@/cms/core/settings/schema';
import { validateSettingValue } from '@/cms/core/settings/validate';

const enabledShopPaymentProviderKeys = (raw: unknown) =>
  enabledPaymentProviderKeys(raw, ECOMMERCE_PAYMENT_PROVIDER_KEYS, SHOP_PAYMENT_PROVIDER_RULES);

const def = (key: string) => {
  const found = MANAGED_SETTINGS.find((d) => d.key === key);
  assert.ok(found, `${key} is not a managed setting`);
  return found;
};

describe('the two offline providers', () => {
  test('bank_transfer and cod are registered without any gateway being loaded', () => {
    const keys = paymentProviderKeys();
    assert.ok(keys.includes('bank_transfer'));
    assert.ok(keys.includes('cod'));
    assert.equal(getPaymentProvider('bank_transfer').key, 'bank_transfer');
    assert.equal(getPaymentProvider('cod').key, 'cod');
  });

  test('neither takes money online, and both start as a pending payment with no redirect', async () => {
    for (const key of ['bank_transfer', 'cod']) {
      const provider = getPaymentProvider(key);
      assert.equal(isOnlineProvider(provider), false, `${key} counted as online`);
      const started = await provider.start({
        subject: 'order',
        subjectId: 1,
        reference: 'ORD-1',
        amount: 1000,
        currency: 'EUR',
        email: 'a@example.com',
      });
      assert.deepEqual(started, { status: 'pending', redirectUrl: null });
    }
  });

  test('legacy manual is still offline, so its old orders keep behaving as before', () => {
    assert.equal(isOnlineProvider(getPaymentProvider('manual')), false);
    assert.deepEqual([...OFFLINE_PROVIDER_KEYS].sort(), ['bank_transfer', 'cod', 'manual']);
  });

  test('only cod is cash on delivery — a bank transfer is paid before the parcel leaves', () => {
    assert.equal(isCashOnDelivery('cod'), true);
    assert.equal(isCashOnDelivery('bank_transfer'), false);
    assert.equal(isCashOnDelivery('stripe'), false);
    assert.equal(isCashOnDelivery('manual'), false);
  });

  test('a set of only offline methods is not online', () => {
    assert.equal(anyOnlineProviderKey(['bank_transfer', 'cod']), false);
    assert.equal(anyOnlineProviderKey(['cod', 'viva']), true);
  });
});

describe('Settings → Ecommerce → Payment methods', () => {
  test('offers bank transfer and cash on delivery separately, and no longer offers manual', () => {
    const values = (def(ECOMMERCE_PAYMENT_PROVIDER_KEY).options ?? []).map((o) => o.value);
    assert.ok(values.includes('bank_transfer'));
    assert.ok(values.includes('cod'));
    assert.ok(!values.includes('manual'));
    const labels = Object.fromEntries(
      (def(ECOMMERCE_PAYMENT_PROVIDER_KEY).options ?? []).map((o) => [o.value, o.label])
    );
    assert.match(labels.bank_transfer ?? '', /bank transfer/i);
    assert.match(labels.cod ?? '', /cash on delivery/i);
  });

  test('bookings keep their own manual method — they have no courier to collect cash', () => {
    const values = (def(BOOKING_PAYMENT_PROVIDER_KEY).options ?? []).map((o) => o.value);
    assert.ok(values.includes('manual'));
    assert.ok(!values.includes('cod'));
  });

  test('each can be ticked on its own', () => {
    assert.deepEqual(enabledShopPaymentProviderKeys('cod'), ['cod']);
    assert.deepEqual(enabledShopPaymentProviderKeys('bank_transfer,viva'), [
      'bank_transfer',
      'viva',
    ]);
  });

  test('a stored manual reads as both offline methods, in its place', () => {
    assert.deepEqual(enabledShopPaymentProviderKeys('manual'), ['bank_transfer', 'cod']);
    assert.deepEqual(enabledShopPaymentProviderKeys('viva,manual'), [
      'viva',
      'bank_transfer',
      'cod',
    ]);
    assert.deepEqual(enabledShopPaymentProviderKeys('cod,manual'), ['cod', 'bank_transfer']);
  });

  test('nothing ticked still takes orders offline, as manual did', () => {
    assert.deepEqual(enabledShopPaymentProviderKeys(''), ['bank_transfer', 'cod']);
    assert.deepEqual(enabledShopPaymentProviderKeys(undefined), ['bank_transfer', 'cod']);
    assert.deepEqual(enabledShopPaymentProviderKeys('bitcoin'), ['bank_transfer', 'cod']);
  });

  test('saving a form that still holds manual migrates it rather than refusing the whole save', () => {
    const res = validateSettingValue(
      ECOMMERCE_PAYMENT_PROVIDER_KEY,
      def(ECOMMERCE_PAYMENT_PROVIDER_KEY),
      'manual,viva'
    );
    assert.deepEqual(res, { ok: true, value: 'bank_transfer,cod,viva' });
  });

  test('an unknown method is still refused', () => {
    const res = validateSettingValue(
      ECOMMERCE_PAYMENT_PROVIDER_KEY,
      def(ECOMMERCE_PAYMENT_PROVIDER_KEY),
      'cod,bitcoin'
    );
    assert.equal(res.ok, false);
  });

  test('aliases expand in place and dedupe', () => {
    assert.deepEqual(expandMultiValueAliases(['a', 'x', 'b'], { x: ['b', 'c'] }), ['a', 'b', 'c']);
    assert.deepEqual(expandMultiValueAliases(['a'], undefined), ['a']);
  });
});

describe('Settings → Ecommerce → Bank transfer instructions', () => {
  test('one free-text box per language, on the Ecommerce tab', () => {
    assert.deepEqual(Object.keys(BANK_TRANSFER_INSTRUCTIONS_KEYS).sort(), ['el', 'en']);
    for (const key of Object.values(BANK_TRANSFER_INSTRUCTIONS_KEYS)) {
      const field = def(key);
      assert.equal(field.type, 'textarea');
      assert.equal(field.group, 'Ecommerce');
      assert.equal(field.module, 'commerce');
      assert.match(field.description ?? '', /IBAN/);
    }
  });
});
