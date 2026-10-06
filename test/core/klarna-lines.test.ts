/**
 * Klarna order lines with VAT.
 *
 * A payment now carries its lines (`PaymentStartContext.lines`): what was
 * bought, with each line's VAT rate. Klarna gets them as order lines with the
 * tax worked out the way Klarna checks it — `total_tax_amount` is the VAT
 * contained in a VAT-inclusive total, `total − total × 10000 / (10000 + rate)`,
 * and the order's tax is the sum of the lines'.
 *
 * The lines must add up to exactly what is charged. If they ever do not — a
 * rounding slip upstream — Klarna would refuse the session outright, so the
 * builder falls back to the single line it always sent rather than lose the
 * sale.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PaymentLine } from '@/cms/core/payments';
import { buildKlarnaPaymentSession, klarnaOrderLines, vatIncluded } from '@/cms/core/payments/klarna';

const base = {
  subject: 'order' as const,
  subjectId: 1,
  reference: 'ORD-1',
  currency: 'EUR',
  email: 'a@b.c',
  locale: 'el',
};

const lines: PaymentLine[] = [
  { type: 'physical', name: 'Olive oil 1L', reference: 'OIL-1', quantity: 2, unitPrice: 1240, totalAmount: 2480, vatRate: 1300 },
  { type: 'physical', name: 'Mug', quantity: 1, unitPrice: 1000, totalAmount: 1000, vatRate: 2400 },
  { type: 'discount', name: 'Discount', quantity: 1, unitPrice: -248, totalAmount: -248, vatRate: 1300 },
  { type: 'shipping_fee', name: 'Shipping', quantity: 1, unitPrice: 350, totalAmount: 350, vatRate: 2400 },
  { type: 'gift_card', name: 'Gift card', quantity: 1, unitPrice: -500, totalAmount: -500, vatRate: 0 },
];
const amount = 2480 + 1000 - 248 + 350 - 500;

describe('vatIncluded', () => {
  test('is the VAT inside a VAT-inclusive amount, rounded to the cent', () => {
    assert.equal(vatIncluded(1240, 2400), 240); // 1240 − 1000
    assert.equal(vatIncluded(2480, 1300), 285); // 2480 − 2194.69…
  });

  test('is negative for a negative line, rounded symmetrically', () => {
    assert.equal(vatIncluded(-248, 1300), -vatIncluded(248, 1300));
  });

  test('is zero at a zero rate', () => {
    assert.equal(vatIncluded(500, 0), 0);
  });
});

describe('klarnaOrderLines', () => {
  const out = klarnaOrderLines(lines);

  test('one Klarna line per payment line, in order, with Klarna’s types', () => {
    assert.deepEqual(
      out.map((l) => l.type),
      ['physical', 'physical', 'discount', 'shipping_fee', 'gift_card'],
    );
  });

  test('carries quantity, unit price, total and rate as given', () => {
    assert.deepEqual(
      { ...out[0] },
      {
        type: 'physical',
        name: 'Olive oil 1L',
        reference: 'OIL-1',
        quantity: 2,
        unit_price: 1240,
        total_amount: 2480,
        tax_rate: 1300,
        total_tax_amount: vatIncluded(2480, 1300),
      },
    );
  });

  test('a line without a reference does not send one', () => {
    assert.equal('reference' in out[1], false);
  });
});

describe('buildKlarnaPaymentSession with lines', () => {
  test('sends the lines, and the order tax is their sum', () => {
    const body = buildKlarnaPaymentSession({ ...base, amount, lines }, { country: 'GR' });
    assert.equal(body.order_amount, amount);
    assert.equal(body.order_lines.length, 5);
    assert.equal(
      body.order_tax_amount,
      body.order_lines.reduce((sum, l) => sum + l.total_tax_amount, 0),
    );
    assert.equal(
      body.order_lines.reduce((sum, l) => sum + l.total_amount, 0),
      body.order_amount,
    );
  });

  test('lines that do not add up to the amount fall back to one line, so Klarna does not refuse the sale', () => {
    const body = buildKlarnaPaymentSession({ ...base, amount: amount + 1, lines }, { country: 'GR' });
    assert.equal(body.order_lines.length, 1);
    assert.equal(body.order_lines[0].total_amount, amount + 1);
    assert.equal(body.order_tax_amount, 0);
  });

  test('no lines is the single line, as before', () => {
    const body = buildKlarnaPaymentSession({ ...base, amount: 1000 }, { country: 'GR' });
    assert.equal(body.order_lines.length, 1);
  });
});
