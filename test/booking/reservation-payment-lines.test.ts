/**
 * A booking payment as the lines a gateway is told about, with VAT.
 *
 * A booking is usually paid in part (a deposit) or in instalments, so its
 * payment is not itemised by person or night: it is one line for the booking —
 * named as a deposit when it is one — at the booking VAT rate (Settings →
 * Booking → VAT rate, 24% unless changed), plus the payment surcharge, if any,
 * at the same rate.
 *
 * And a reservation that is cancelled or expires closes any payment session
 * still open for it, so a customer cannot pay into a booking that no longer
 * holds a date.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { BOOKING_VAT_RATE_KEY, MANAGED_SETTINGS } from '@/cms/core/settings/schema';
import { reservationPaymentLines } from '@/cms/modules/booking/pricing';
import { BOOKING_SETTING_READERS } from '@/cms/modules/booking/settings-read';

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

describe('reservationPaymentLines', () => {
  test('one line for the booking at the booking rate', () => {
    assert.deepEqual(
      reservationPaymentLines({ title: 'Sunset cruise', reference: 'BK-1', amountDue: 20_000, surcharge: 0, isDeposit: false, vatBps: 1300, locale: 'en' }),
      [{ type: 'digital', name: 'Sunset cruise', reference: 'BK-1', quantity: 1, unitPrice: 20_000, totalAmount: 20_000, vatRate: 1300 }],
    );
  });

  test('a deposit says so', () => {
    const [line] = reservationPaymentLines({ title: 'Sunset cruise', reference: 'BK-1', amountDue: 6000, surcharge: 0, isDeposit: true, vatBps: 2400, locale: 'en' });
    assert.equal(line.name, 'Sunset cruise — deposit');
    const [el] = reservationPaymentLines({ title: 'Κρουαζιέρα', reference: 'BK-1', amountDue: 6000, surcharge: 0, isDeposit: true, vatBps: 2400, locale: 'el' });
    assert.equal(el.name, 'Κρουαζιέρα — προκαταβολή');
  });

  test('a surcharge is its own line at the same rate, and the lines add up', () => {
    const lines = reservationPaymentLines({ title: 'Villa', reference: 'BK-2', amountDue: 10_000, surcharge: 400, isDeposit: false, vatBps: 2400, locale: 'en' });
    assert.deepEqual(
      lines.map((l) => [l.type, l.totalAmount, l.vatRate]),
      [
        ['digital', 10_000, 2400],
        ['surcharge', 400, 2400],
      ],
    );
  });
});

describe('wiring', () => {
  test('bookings have a VAT rate setting, read by something', () => {
    assert.ok(MANAGED_SETTINGS.some((d) => d.key === BOOKING_VAT_RATE_KEY && d.module === 'booking'));
    assert.ok(BOOKING_SETTING_READERS[BOOKING_VAT_RATE_KEY]);
  });

  test('the pay route sends the lines with the payment', () => {
    const fn = fnBody(source('src/cms/modules/booking/payments.ts'), 'bookingPayStartRoute');
    assert.match(fn, /lines:\s*reservationPaymentLines\(/);
  });

  test('cancelling or expiring a reservation closes its open payment sessions', () => {
    const update = fnBody(source('src/cms/modules/booking/reservations.ts'), 'updateReservationStatus');
    assert.match(update, /closeReservationPaymentSessions\(/);
    const expire = fnBody(source('src/cms/modules/booking/allocation.ts'), 'expireStaleReservations');
    assert.match(expire, /closeReservationPaymentSessions\(/);
  });
});
