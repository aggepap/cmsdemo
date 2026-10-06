/**
 * A booking's pay page, with one or several payment methods.
 *
 * With several, the customer picks one; the surcharge and total follow the
 * pick, and the button says what will happen — pay now, or confirm and pay by
 * bank transfer. With bank transfer alone there is nothing to press: the page
 * explains how to pay, exactly as before multiple methods existed.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { BookingPayClient, type BookingPayClientProps } from '@/components/booking/BookingPayClient';

const labels: BookingPayClientProps['labels'] = {
  amountDue: 'Amount due',
  depositDue: 'Deposit due',
  surcharge: 'Payment fee',
  totalCharged: 'Total charged',
  payNow: 'Pay now',
  paying: 'Processing…',
  bankTransfer: 'Please transfer the amount quoting BK-1.',
  genericError: 'Something went wrong.',
  returned: 'Thank you.',
  method: 'Payment method',
  confirmBankTransfer: 'Confirm and pay by bank transfer',
};

const card = { key: 'viva', label: 'Card', online: true, surcharge: 400, chargeable: 10_400 };
const klarna = { key: 'klarna', label: 'Klarna', online: true, surcharge: 0, chargeable: 10_000 };
const bank = { key: 'manual', label: 'Bank transfer', online: false, surcharge: 0, chargeable: 10_000 };

const render = (methods: BookingPayClientProps['methods']) =>
  renderToStaticMarkup(
    <BookingPayClient
      reference="BK-1"
      token="tok"
      locale="en"
      currency="EUR"
      amountDue={10_000}
      isDeposit={false}
      methods={methods}
      publishableKey={null}
      labels={labels}
    />,
  );

describe('BookingPayClient', () => {
  test('with several methods, offers each as a radio', () => {
    const html = render([card, klarna, bank]);
    assert.match(html, /<legend[^>]*>Payment method<\/legend>/);
    assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  });

  test('the first method is chosen to begin with, and its surcharge is shown', () => {
    const html = render([card, klarna]);
    assert.match(html, /Payment fee/);
    assert.match(html, /104\.00/);
    assert.match(html, />Pay now</);
  });

  test('each option says what it adds', () => {
    // The fee is on the option itself, so a customer can compare before choosing.
    const html = render([card, klarna]);
    assert.match(html, /\+\s*€?4\.00|\+\s*4\.00/);
  });

  test('when bank transfer is chosen, the button confirms rather than pays', () => {
    const html = render([bank, card]);
    assert.match(html, /Confirm and pay by bank transfer/);
    assert.doesNotMatch(html, />Pay now</);
  });

  test('bank transfer alone: instructions and no button, as before', () => {
    const html = render([bank]);
    assert.match(html, /Please transfer the amount quoting BK-1\./);
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /type="radio"/);
  });

  test('a single online method: no chooser, just the pay button', () => {
    const html = render([klarna]);
    assert.doesNotMatch(html, /type="radio"/);
    assert.match(html, />Pay now</);
  });
});
