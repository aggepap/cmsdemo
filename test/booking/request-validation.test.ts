/**
 * The public booking request refuses what it used to quietly change (F-004).
 *
 * - `persons: 7` on an item for at most 6 was clamped to 6: the reservation was
 *   stored and priced for a party the customer never asked for.
 * - A name carrying CR/LF was stored as-is, and names travel into emails.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { partySizeRefusal } from '@/cms/modules/booking/pricing';
import { reservationRequestSchema } from '@/cms/modules/booking/reservations';

const base = {
  slug: 'sunset-flight',
  date: '2026-10-20',
  persons: 2,
  customer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+30 210 000 0000' },
  acceptTerms: true,
};

describe('reservationRequestSchema', () => {
  test('an ordinary request passes', () => {
    assert.equal(reservationRequestSchema.safeParse(base).success, true);
  });

  test('a name with a line break or other control character is refused', () => {
    for (const name of ['Ann\r\nBcc: x@y.z', 'Ann\nLee', 'Ann\u0000', 'Ann\tLee']) {
      const r = reservationRequestSchema.safeParse({ ...base, customer: { ...base.customer, name } });
      assert.equal(r.success, false, JSON.stringify(name));
    }
  });

  test('a phone with a control character is refused', () => {
    const r = reservationRequestSchema.safeParse({ ...base, customer: { ...base.customer, phone: '210\r\n000' } });
    assert.equal(r.success, false);
  });

  test('accents, apostrophes and non-Latin names are fine', () => {
    for (const name of ['Ζωή Παπαδοπούλου', "Seán O'Brien", 'José-María', '李小龍']) {
      const r = reservationRequestSchema.safeParse({ ...base, customer: { ...base.customer, name } });
      assert.equal(r.success, true, name);
    }
  });
});

describe('partySizeRefusal', () => {
  const cfg = { hasPersons: true, minPersons: 2, maxPersons: 6 };

  test('a party inside the range is accepted, edges included', () => {
    assert.equal(partySizeRefusal(cfg, 2), null);
    assert.equal(partySizeRefusal(cfg, 6), null);
  });

  test('a party above the maximum is refused with the limit, not shrunk', () => {
    assert.match(partySizeRefusal(cfg, 7) ?? '', /6/);
  });

  test('a party below the minimum is refused with the limit', () => {
    assert.match(partySizeRefusal(cfg, 1) ?? '', /2/);
  });

  test('an item priced without persons accepts any count, as before', () => {
    assert.equal(partySizeRefusal({ hasPersons: false, minPersons: 1, maxPersons: 1 }, 9), null);
  });
});

describe('wiring', () => {
  const src = readFileSync(new URL('../../src/cms/modules/booking/reservations.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function createReservation'));

  test('createReservation refuses an out-of-range party before pricing', () => {
    const refusal = body.indexOf('partySizeRefusal(');
    assert.ok(refusal > 0, 'partySizeRefusal is called');
    assert.ok(refusal < body.indexOf('priceSelection('), 'and before the price is computed');
  });
});

describe('public availability', () => {
  test('does not publish the remaining seat count per day', () => {
    const src = readFileSync(new URL('../../src/cms/modules/booking/quote.ts', import.meta.url), 'utf8');
    const route = src.slice(src.indexOf('export function bookingAvailabilityRoute'));
    assert.doesNotMatch(route, /remaining:/);
    const types = readFileSync(new URL('../../src/components/booking/booking-form-types.ts', import.meta.url), 'utf8');
    const day = types.slice(types.indexOf('export interface AvailabilityDay'), types.indexOf('export interface AvailabilityRules'));
    assert.doesNotMatch(day, /remaining/);
  });
});
