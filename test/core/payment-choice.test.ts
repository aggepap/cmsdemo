/**
 * Several gateways at once, and the customer's pick among them.
 *
 * A site used to configure exactly one provider per module. Now an admin ticks
 * several, and the customer chooses at checkout (or on a booking's pay page).
 * The stored setting did not change shape — a `multiselect` is a comma-separated
 * string — so a site that saved `viva` before this change reads as `[viva]`
 * with no migration.
 *
 * The choice is the customer's, but the LIST is the admin's. The booking pay
 * route once took a `method` from the body and used it as-is, which let a
 * caller pay through any registered provider whatever the site had configured.
 * `choosePaymentProvider` is what keeps that closed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  anyOnlineProviderKey,
  choosePaymentProvider,
  enabledPaymentProviderKeys,
  offersManualPayment,
} from '@/cms/core/payments/choice';
import {
  BOOKING_PAYMENT_PROVIDER_KEY,
  ECOMMERCE_PAYMENT_PROVIDER_KEY,
  MANAGED_SETTINGS,
  PAYMENT_PROVIDER_KEYS,
} from '@/cms/core/settings/schema';

const KNOWN = ['manual', 'stripe', 'paypal', 'viva', 'klarna'] as const;

describe('enabledPaymentProviderKeys', () => {
  test('a value saved before multi-select reads as a list of one', () => {
    assert.deepEqual(enabledPaymentProviderKeys('viva', KNOWN), ['viva']);
  });

  test('several are read in the order stored — the first is the default', () => {
    assert.deepEqual(enabledPaymentProviderKeys('klarna,viva,manual', KNOWN), ['klarna', 'viva', 'manual']);
  });

  test('unknown keys are dropped rather than trusted', () => {
    assert.deepEqual(enabledPaymentProviderKeys('viva,bitcoin', KNOWN), ['viva']);
  });

  test('duplicates and whitespace are ignored', () => {
    assert.deepEqual(enabledPaymentProviderKeys(' viva , viva,paypal ', KNOWN), ['viva', 'paypal']);
  });

  test('nothing enabled means manual, so a fresh site still takes orders', () => {
    assert.deepEqual(enabledPaymentProviderKeys(undefined, KNOWN), ['manual']);
    assert.deepEqual(enabledPaymentProviderKeys('', KNOWN), ['manual']);
    assert.deepEqual(enabledPaymentProviderKeys('bitcoin', KNOWN), ['manual']);
  });
});

describe('choosePaymentProvider', () => {
  test('with a single method the customer need not choose', () => {
    assert.deepEqual(choosePaymentProvider(['viva'], undefined), { ok: true, key: 'viva' });
    assert.deepEqual(choosePaymentProvider(['viva'], null), { ok: true, key: 'viva' });
    assert.deepEqual(choosePaymentProvider(['viva'], ''), { ok: true, key: 'viva' });
  });

  test('with a single method, naming it is fine too', () => {
    assert.deepEqual(choosePaymentProvider(['viva'], 'viva'), { ok: true, key: 'viva' });
  });

  test('with several, the customer must say which — a silent default could add a surcharge they never saw', () => {
    assert.deepEqual(choosePaymentProvider(['viva', 'klarna'], undefined), { ok: false, reason: 'required' });
  });

  test('with several, an enabled one is accepted', () => {
    assert.deepEqual(choosePaymentProvider(['viva', 'klarna'], 'klarna'), { ok: true, key: 'klarna' });
  });

  test('a registered provider the admin did NOT enable is refused', () => {
    // The hole the booking pay route used to have: stripe exists in the
    // registry, but this site never switched it on.
    assert.deepEqual(choosePaymentProvider(['viva', 'klarna'], 'stripe'), { ok: false, reason: 'not_enabled' });
    assert.deepEqual(choosePaymentProvider(['viva'], 'stripe'), { ok: false, reason: 'not_enabled' });
  });

  test('an unknown name is refused, not mapped to manual', () => {
    assert.deepEqual(choosePaymentProvider(['viva', 'manual'], 'nope'), { ok: false, reason: 'not_enabled' });
  });
});

describe('online and manual in a set', () => {
  test('any online gateway makes the set online', () => {
    assert.equal(anyOnlineProviderKey(['manual', 'klarna']), true);
    assert.equal(anyOnlineProviderKey(['viva']), true);
    assert.equal(anyOnlineProviderKey(['manual']), false);
  });

  test('manual is offered only when ticked', () => {
    assert.equal(offersManualPayment(['manual', 'viva']), true);
    assert.equal(offersManualPayment(['viva', 'klarna']), false);
  });
});

describe('the payment method settings', () => {
  test('Klarna is one of the selectable providers', () => {
    assert.ok(PAYMENT_PROVIDER_KEYS.includes('klarna'));
  });

  for (const key of [ECOMMERCE_PAYMENT_PROVIDER_KEY, BOOKING_PAYMENT_PROVIDER_KEY]) {
    test(`${key} lets the admin tick several methods, Klarna among them`, () => {
      const def = MANAGED_SETTINGS.find((d) => d.key === key);
      assert.ok(def, `${key} is not a managed setting`);
      assert.equal(def.type, 'multiselect');
      assert.ok(def.options?.some((o) => o.value === 'klarna'));
    });
  }
});
