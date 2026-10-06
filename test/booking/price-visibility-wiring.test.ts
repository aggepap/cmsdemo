/**
 * Where the hidden-prices and requests-only rules are applied (G1, G2).
 *
 * The rules are unit-tested in `price-visibility.test.ts`; these checks pin
 * that every surface that can carry money or a payment step actually asks
 * them. A new surface that forgets is the bug this guards against — the reason
 * G1 was reopened was a 201 and a lookup that still carried the amount.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  BOOKING_HIDE_PRICES_KEY,
  BOOKING_REQUEST_ONLY_KEY,
  MANAGED_SETTINGS,
} from '@/cms/core/settings/schema';
import { bookingSummaryHtml } from '@/cms/modules/booking/emails';

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');

function fnBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = text.indexOf('\nexport ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

const reservations = source('src/cms/modules/booking/reservations.ts');
const payments = source('src/cms/modules/booking/payments.ts');

describe('settings', () => {
  for (const key of [BOOKING_HIDE_PRICES_KEY, BOOKING_REQUEST_ONLY_KEY]) {
    test(`${key} is an off-by-default switch in Booking`, () => {
      const field = MANAGED_SETTINGS.find((f) => f.key === key);
      assert.equal(field?.type, 'boolean');
      assert.equal(field?.group, 'Booking');
      assert.equal(field?.module, 'booking');
      assert.equal(field?.defaultValue, 'off');
    });
  }
});

describe('taking a request', () => {
  const body = fnBody(reservations, 'createReservation');

  test('the mode goes through entryMode, so either switch makes it a request', () => {
    assert.match(body, /entryMode\(/);
  });

  test('an unpriced experience is taken as a request when the policy allows it', () => {
    assert.match(body, /takesUnpricedRequests\(/);
  });

  test('the 201 goes through publicRequestResult', () => {
    assert.match(fnBody(reservations, 'bookingRequestRoute'), /publicRequestResult\(/);
  });
});

describe('the payment step', () => {
  test('a status move into awaiting payment is refused when the policy says so', () => {
    assert.match(fnBody(reservations, 'updateReservationStatus'), /paymentStepRefusal\(/);
  });

  test('every payment link is refused the same way — accept, resend and instant all issue through here', () => {
    assert.match(fnBody(payments, 'issuePaymentLink'), /paymentStepRefusal\(/);
  });

  test('the pay page answers 404 on a requests-only site', () => {
    for (const name of ['bookingPayGetRoute', 'bookingPayStartRoute']) {
      assert.match(fnBody(payments, name), /requestOnly/, name);
    }
  });

  test('the emails never offer payment instructions on a requests-only site', () => {
    const emails = source('src/cms/modules/booking/emails.ts');
    assert.match(fnBody(emails, 'manualPaymentInstructions'), /requestOnly/);
  });
});

describe('money reaching a customer', () => {
  test('the quote, the lookup and the customer emails ask the policy', () => {
    assert.match(
      fnBody(source('src/cms/modules/booking/quote.ts'), 'bookingQuoteRoute'),
      /withoutQuotePrices\(/
    );
    assert.match(fnBody(reservations, 'bookingLookupRoute'), /publicLookup\(/);
    const emails = source('src/cms/modules/booking/emails.ts');
    assert.match(fnBody(emails, 'sendCustomerEmail'), /hidePrices/);
    assert.match(fnBody(emails, 'sendReservationEmails'), /hidePrices/);
  });

  test('the listing drops "from" prices and price sorting', () => {
    const page = source('src/app/[locale]/booking/page.tsx');
    assert.match(page, /withoutListingPrices\(/);
    assert.match(page, /visibleSort\(/);
  });

  test('the experience page drops the Offer, the view_item price and the extras prices', () => {
    const page = source('src/app/[locale]/booking/[slug]/page.tsx');
    assert.match(page, /policy\.hidePrices \? null : structuredOfferPrice\(/);
    assert.match(page, /hidePrices=\{policy\.hidePrices\}/);
  });

  test('the form shows no breakdown and no extra prices when told to hide them', () => {
    const form = source('src/components/booking/BookingForm.tsx');
    assert.match(form, /hidePrices \? null :/);
    const fields = source('src/components/booking/booking-form-fields.tsx');
    assert.match(fields, /extra\.price == null/);
  });
});

describe('the summary block in the emails', () => {
  const reservation = {
    reference: 'BKG-2026-ABC',
    slotDate: '2026-07-01',
    endDate: null,
    nights: 0,
    persons: 3,
    resourceLabel: null,
    currency: 'EUR',
    total: 45000,
    locale: 'en',
  };
  const items = [{ label: 'Champagne', quantity: 2, unitAmount: 4500, amount: 9000 }];

  test('with money: the breakdown and the total', () => {
    const html = bookingSummaryHtml(reservation, items, { money: true });
    assert.match(html, /Champagne/);
    assert.match(html, /450/);
  });

  test('without money: what was booked, and not one amount', () => {
    const html = bookingSummaryHtml(reservation, items, { money: false });
    assert.match(html, /BKG-2026-ABC/);
    assert.match(html, /Champagne/);
    assert.doesNotMatch(html, /€|EUR|450|45\.00|90\.00/);
  });

  test('an unpriced booking says the price is still to be agreed, not €0.00', () => {
    const html = bookingSummaryHtml({ ...reservation, total: 0 }, [], { money: true });
    assert.doesNotMatch(html, /0[.,]00/);
    assert.match(html, /to be agreed/i);
  });
});

describe('the admin', () => {
  test('"Accept" follows the same rule as the server', () => {
    const table = source('src/cms/admin/ReservationsTable.tsx');
    assert.match(table, /acceptTarget\(/);
    assert.match(table, /'Accept & confirm'/);
  });

  test('the drawer is told whether the site takes requests only', () => {
    assert.match(fnBody(reservations, 'reservationGetRoute'), /requestOnly: policy\.requestOnly/);
  });
});
