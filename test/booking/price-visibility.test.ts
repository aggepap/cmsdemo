/**
 * Hidden prices (G1) and requests without a payment step (G2), as rules.
 *
 * Two switches in Settings → Booking, both off until exactly `on`:
 *
 * - **Hide prices** — no amount reaches a visitor or a customer: not the quote,
 *   not the request's answer, not the lookup, not the emails, not a listing
 *   card, not the structured data. The team still sees every price.
 * - **Requests only** — accepting a request confirms it; there is no payment
 *   link, no pay page and no payment instructions.
 *
 * Either one makes every booking a request (an instant booking would charge an
 * amount nobody was shown, or ask for a payment the site does not take), and
 * lets an experience with no price at all be requested — the reason sites kept
 * a fake `basePrice = 1`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  acceptTarget,
  entryMode,
  paymentStepRefusal,
  publicLookup,
  withoutQuotePrices,
  publicRequestResult,
  readBookingPolicy,
  takesUnpricedRequests,
  visibleSort,
  withoutListingPrices,
  type BookingPolicy,
} from '@/cms/modules/booking/visibility';

const OFF: BookingPolicy = { hidePrices: false, requestOnly: false };
const HIDE: BookingPolicy = { hidePrices: true, requestOnly: false };
const REQ: BookingPolicy = { hidePrices: false, requestOnly: true };
const BOTH: BookingPolicy = { hidePrices: true, requestOnly: true };

describe('readBookingPolicy', () => {
  test('only exactly on switches either one on', () => {
    assert.deepEqual(readBookingPolicy(null, undefined), OFF);
    assert.deepEqual(readBookingPolicy('off', 'yes'), OFF);
    assert.deepEqual(readBookingPolicy('on', 'off'), HIDE);
    assert.deepEqual(readBookingPolicy('off', 'on'), REQ);
    assert.deepEqual(readBookingPolicy('on', 'on'), BOTH);
  });
});

describe('entryMode', () => {
  test('with both off, the experience and then the site decide, as before', () => {
    assert.equal(entryMode('instant', 'request', OFF), 'instant');
    assert.equal(entryMode('inherit', 'instant', OFF), 'instant');
    assert.equal(entryMode('inherit', 'request', OFF), 'request');
  });

  test('either switch makes every booking a request', () => {
    for (const policy of [HIDE, REQ, BOTH]) {
      assert.equal(entryMode('instant', 'instant', policy), 'request');
      assert.equal(entryMode('inherit', 'instant', policy), 'request');
    }
  });
});

describe('takesUnpricedRequests', () => {
  test('an experience with no price can be requested once either switch is on', () => {
    assert.equal(takesUnpricedRequests('price_on_request', OFF), false);
    assert.equal(takesUnpricedRequests('price_on_request', HIDE), true);
    assert.equal(takesUnpricedRequests('price_on_request', REQ), true);
  });

  test('every other refusal still refuses', () => {
    assert.equal(takesUnpricedRequests('min_nights', BOTH), false);
    assert.equal(takesUnpricedRequests('invalid_config', BOTH), false);
  });
});

describe('accepting a request', () => {
  test('asks for payment when the site takes payment and there is a price', () => {
    assert.equal(acceptTarget(OFF, 45000), 'awaiting_payment');
    assert.equal(acceptTarget(HIDE, 45000), 'awaiting_payment');
  });

  test('confirms straight away on a requests-only site', () => {
    assert.equal(acceptTarget(REQ, 45000), 'confirmed');
    assert.equal(acceptTarget(BOTH, 45000), 'confirmed');
  });

  test('confirms a booking with no price, which nobody could pay', () => {
    assert.equal(acceptTarget(OFF, 0), 'confirmed');
  });
});

describe('paymentStepRefusal', () => {
  test('none while the site takes payment and the booking has a price', () => {
    assert.equal(paymentStepRefusal(OFF, 45000), null);
    assert.equal(paymentStepRefusal(HIDE, 45000), null);
  });

  test('a requests-only site never asks for payment', () => {
    assert.match(paymentStepRefusal(REQ, 45000) ?? '', /requests only/i);
  });

  test('a booking with no price cannot be paid for', () => {
    assert.match(paymentStepRefusal(OFF, 0) ?? '', /no price/i);
  });
});

describe('what a customer is sent', () => {
  const quote = {
    quote: {
      ok: true as const,
      persons: 4,
      unitAmount: 45000,
      lines: [
        {
          kind: 'base',
          code: 'base',
          label: 'Base price',
          quantity: 1,
          unitAmount: 45000,
          amount: 45000,
        },
      ],
      subtotal: 45000,
      total: 45000,
      applied: {},
    },
    currency: 'EUR',
    kind: 'transport' as const,
    nights: 0,
    resources: [{ id: 'r1', title: 'Bell 407' }],
  };

  test('the quote keeps everything but the money', () => {
    const out = withoutQuotePrices(quote, true) as unknown as Record<string, unknown>;
    assert.deepEqual(out.quote, { ok: true, persons: 4 });
    assert.equal('currency' in out, false);
    assert.deepEqual(out.resources, quote.resources);
    assert.equal(out.kind, 'transport');
  });

  test('a refused quote keeps its reason, so the form can still say why', () => {
    const refused = { ...quote, quote: { ok: false as const, reason: 'min_nights', minNights: 3 } };
    assert.deepEqual(
      (withoutQuotePrices(refused, true) as unknown as Record<string, unknown>).quote,
      refused.quote
    );
  });

  test('with prices shown, the quote is unchanged', () => {
    assert.deepEqual(withoutQuotePrices(quote, false), quote);
  });

  test('the request answer drops total and currency', () => {
    const result = {
      reference: 'BKG-2026-X',
      status: 'pending',
      total: 45000,
      currency: 'EUR',
      redirectUrl: null,
      expiresAt: null,
    };
    assert.deepEqual(publicRequestResult(result, true), {
      reference: 'BKG-2026-X',
      status: 'pending',
      redirectUrl: null,
      expiresAt: null,
    });
    assert.deepEqual(publicRequestResult(result, false), result);
  });

  test('the lookup keeps what was booked, without amounts', () => {
    const found = {
      reference: 'BKG-2026-X',
      status: 'confirmed',
      bookingTitle: 'Island hop',
      persons: 2,
      currency: 'EUR',
      total: 45000,
      amountPaid: 0,
      items: [{ label: 'Champagne', quantity: 1, unitAmount: 9000, amount: 9000 }],
    };
    const out = publicLookup(found, true) as Record<string, unknown>;
    for (const key of ['currency', 'total', 'amountPaid']) assert.equal(key in out, false, key);
    assert.deepEqual(out.items, [{ label: 'Champagne', quantity: 1 }]);
    assert.equal(out.bookingTitle, 'Island hop');
    assert.deepEqual(publicLookup(found, false), found);
  });
});

describe('the listing', () => {
  test('cards lose their "from" price', () => {
    const items = [
      { slug: 'a', fromPrice: 450 },
      { slug: 'b', fromPrice: null },
    ];
    assert.deepEqual(withoutListingPrices(items, true), [
      { slug: 'a', fromPrice: null },
      { slug: 'b', fromPrice: null },
    ]);
    assert.deepEqual(withoutListingPrices(items, false), items);
  });

  test('sorting by price is not offered, and a price sort in the URL falls back to the title', () => {
    assert.equal(visibleSort('price-asc', true), 'title-asc');
    assert.equal(visibleSort('price-desc', true), 'title-asc');
    assert.equal(visibleSort('title-desc', true), 'title-desc');
    assert.equal(visibleSort('price-asc', false), 'price-asc');
  });
});
