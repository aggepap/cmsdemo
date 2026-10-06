/**
 * The payment method chooser, shared by the shop checkout and a booking's pay
 * page.
 *
 * A radio group, because it is one choice among a few, and a radio group is what
 * a keyboard and a screen reader already know how to operate. With a single
 * method there is nothing to choose, so nothing is shown and the page reads as
 * it did before this existed.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PaymentMethodPicker } from '@/components/checkout/PaymentMethodPicker';

const options = [
  { key: 'viva', label: 'Card' },
  { key: 'klarna', label: 'Klarna', hint: '+ €1.20' },
  { key: 'manual', label: 'Bank transfer' },
];

const render = (props: Partial<Parameters<typeof PaymentMethodPicker>[0]> = {}) =>
  renderToStaticMarkup(
    <PaymentMethodPicker legend="Payment method" name="payment" options={options} value="viva" onChange={() => {}} {...props} />,
  );

describe('PaymentMethodPicker', () => {
  test('is a labelled group of radios, one per method', () => {
    const html = render();
    assert.match(html, /<fieldset[^>]*>/);
    assert.match(html, /<legend[^>]*>Payment method<\/legend>/);
    assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
    for (const { key, label } of options) {
      assert.match(html, new RegExp(`value="${key}"`));
      assert.match(html, new RegExp(label));
    }
  });

  test('every radio is labelled, so it can be clicked by its text and read aloud', () => {
    const html = render();
    assert.equal((html.match(/<label/g) ?? []).length, 3);
  });

  test('radios share one name, so arrow keys move between them', () => {
    assert.equal((render().match(/name="payment"/g) ?? []).length, 3);
  });

  test('marks the current choice', () => {
    const html = render({ value: 'klarna' });
    assert.match(html, /value="klarna"[^>]*checked=""|checked=""[^>]*value="klarna"/);
    assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  });

  test('shows a hint, such as the surcharge a method adds', () => {
    assert.match(render(), /\+ €1\.20/);
  });

  test('renders nothing when there is only one method', () => {
    assert.equal(render({ options: [options[0]] }), '');
  });
});
