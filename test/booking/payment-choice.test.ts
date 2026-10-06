/**
 * Bookings with several payment methods switched on.
 *
 * The customer picks on the pay page. Every enabled method is offered, bank
 * transfer included: choosing it confirms the booking unpaid and emails the
 * payment instructions, as the manual flow always has. Each method carries its
 * own surcharge, so each option shows what it will actually cost.
 *
 * The provider still comes from the site's settings, never from the request —
 * the `method` a customer sends is only honoured when it names one of the
 * methods the admin enabled (see `choosePaymentProvider`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { BOOKING_PAYMENT_PROVIDER_KEY, BOOKING_SURCHARGE_KLARNA_KEY, MANAGED_SETTINGS } from '@/cms/core/settings/schema';
import { owesPaymentInstructions } from '@/cms/modules/booking/lifecycle';
import { payOptionsFor } from '@/cms/modules/booking/pricing';
import { BOOKING_SETTING_READERS, getBookingPaymentProviders } from '@/cms/modules/booking/settings-read';

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');

function fnBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = text.slice(start + 1).search(/\n(export )?(async )?function /);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe('payOptionsFor', () => {
  const bps: Record<string, number> = { viva: 400, klarna: 350 };
  const options = payOptionsFor(['viva', 'klarna', 'manual'], 10_000, (key) => bps[key] ?? 0);

  test('one option per enabled method, in the admin’s order', () => {
    assert.deepEqual(
      options.map((o) => o.key),
      ['viva', 'klarna', 'manual'],
    );
  });

  test('each carries its own surcharge and what is charged with it', () => {
    assert.deepEqual(options[0], { key: 'viva', online: true, surcharge: 400, chargeable: 10_400 });
    assert.deepEqual(options[1], { key: 'klarna', online: true, surcharge: 350, chargeable: 10_350 });
  });

  test('bank transfer is offline and never surcharged', () => {
    assert.deepEqual(options[2], { key: 'manual', online: false, surcharge: 0, chargeable: 10_000 });
  });
});

describe('the booking settings', () => {
  test('Klarna has its own surcharge setting', () => {
    assert.ok(MANAGED_SETTINGS.some((d) => d.key === BOOKING_SURCHARGE_KLARNA_KEY));
    assert.ok(BOOKING_SETTING_READERS[BOOKING_SURCHARGE_KLARNA_KEY], 'no reader for the Klarna surcharge');
  });

  test('the payment setting is read as a list', () => {
    assert.equal(BOOKING_SETTING_READERS[BOOKING_PAYMENT_PROVIDER_KEY], getBookingPaymentProviders);
  });

  test('a surcharge is looked up for Klarna', () => {
    assert.match(source('src/cms/modules/booking/settings-read.ts'), /klarna:\s*BOOKING_SURCHARGE_KLARNA_KEY/);
  });
});

describe('the pay route', () => {
  const payments = source('src/cms/modules/booking/payments.ts');

  test('accepts the customer’s method in the body', () => {
    assert.match(payments, /method:\s*z\.string\(\)\.trim\(\)\.max\(32\)\.optional\(\)/);
  });

  test('checks it against the enabled methods before anything is charged', () => {
    const fn = fnBody(payments, 'resolvePaymentTerms');
    assert.match(fn, /choosePaymentProvider\(/);
    assert.match(fn, /badRequest\(/);
    const route = fnBody(payments, 'bookingPayStartRoute');
    assert.match(route, /resolvePaymentTerms\(amountDue,\s*input\.method\)/);
  });

  test('choosing bank transfer confirms the booking unpaid, and starts no gateway', () => {
    const route = fnBody(payments, 'bookingPayStartRoute');
    assert.match(route, /isOnlineProvider\(provider\)/);
    assert.match(route, /updateReservationStatus\([\s\S]*?'confirmed'/);
  });
});

describe('what "online" means with several methods', () => {
  test('an instant booking awaits payment when ANY enabled method is online', () => {
    const fn = fnBody(source('src/cms/modules/booking/reservations.ts'), 'createReservation');
    assert.match(fn, /anyOnlineProviderKey\(await getBookingPaymentProviders\(\)\)/);
  });

  test('accepting a request sends a payment link when any method is online', () => {
    const fn = fnBody(source('src/cms/modules/booking/payments.ts'), 'requestPayment');
    assert.match(fn, /anyOnlineProviderKey\(/);
  });

  test('bank instructions are emailed whenever bank transfer is one of the methods', () => {
    const fn = fnBody(source('src/cms/modules/booking/emails.ts'), 'manualPaymentInstructions');
    assert.match(fn, /offersManualPayment\(/);
  });

  test('nothing still reads a single booking provider', () => {
    for (const path of [
      'src/cms/modules/booking/reservations.ts',
      'src/cms/modules/booking/payments.ts',
      'src/cms/modules/booking/emails.ts',
      'src/app/[locale]/booking/pay/[reference]/page.tsx',
    ]) {
      assert.doesNotMatch(source(path), /getBookingPaymentProvider\(/, path);
    }
  });
});

describe('owesPaymentInstructions — which customer emails carry the bank details', () => {
  test('a payment request with no link carries them', () => {
    assert.equal(owesPaymentInstructions({ which: 'payment_link', hasPaymentUrl: false, amountPaid: 0, total: 100 }), true);
  });

  test('a payment request WITH a link does not — the link is how they pay', () => {
    assert.equal(owesPaymentInstructions({ which: 'payment_link', hasPaymentUrl: true, amountPaid: 0, total: 100 }), false);
  });

  test('a confirmation with money still owed carries them — the customer picked bank transfer', () => {
    assert.equal(owesPaymentInstructions({ which: 'confirmed', hasPaymentUrl: false, amountPaid: 0, total: 100 }), true);
  });

  test('a confirmation of a booking paid in full does not', () => {
    assert.equal(owesPaymentInstructions({ which: 'confirmed', hasPaymentUrl: false, amountPaid: 100, total: 100 }), false);
  });

  test('receipts, cancellations and expiries never do', () => {
    for (const which of ['receipt', 'cancelled', 'expired'] as const) {
      assert.equal(owesPaymentInstructions({ which, hasPaymentUrl: false, amountPaid: 0, total: 100 }), false, which);
    }
  });

  test('the status email and the new-booking email both use it', () => {
    const emails = source('src/cms/modules/booking/emails.ts');
    assert.match(fnBody(emails, 'sendStatusEmail'), /owesPaymentInstructions\(/);
    assert.match(fnBody(emails, 'sendReservationEmails'), /owesPaymentInstructions\(/);
  });
});
