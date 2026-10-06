/**
 * The bank details on the thank-you page after a bank transfer order, and the
 * other screens that name the two offline methods.
 *
 * The instructions are the shop's own free text (bank, IBAN, beneficiary), so
 * they render as text — React escapes them — with the admin's line breaks kept.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrderPayments } from '@/cms/admin/OrderFulfilment';
import { SettingField } from '@/cms/admin/SettingsForm';
import { ECOMMERCE_PAYMENT_PROVIDER_KEY, MANAGED_SETTINGS } from '@/cms/core/settings/schema';
import { BankTransferInstructions } from '@/components/checkout/BankTransferInstructions';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('BankTransferInstructions', () => {
  test('a headed region with the text, line breaks kept', () => {
    const html = renderToStaticMarkup(
      <BankTransferInstructions
        heading="How to pay by bank transfer"
        text={'Piraeus Bank\nIBAN GR12 3456'}
      />
    );
    assert.match(html, /<section[^>]*aria-labelledby="([^"]+)"/);
    const id = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.match(html, new RegExp(`<h2[^>]*id="${id}"[^>]*>How to pay by bank transfer</h2>`));
    assert.match(html, /whitespace-pre-line/);
    assert.match(html, /Piraeus Bank\nIBAN GR12 3456/);
  });

  test('markup in the text is shown, not run', () => {
    const html = renderToStaticMarkup(
      <BankTransferInstructions heading="H" text={'<img src=x onerror=alert(1)>'} />
    );
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  test('renders nothing without text', () => {
    assert.equal(renderToStaticMarkup(<BankTransferInstructions heading="H" text="" />), '');
    assert.equal(renderToStaticMarkup(<BankTransferInstructions heading="H" text={null} />), '');
    assert.equal(renderToStaticMarkup(<BankTransferInstructions heading="H" text={'  \n'} />), '');
  });
});

describe('the checkout thank-you page', () => {
  const client = read('src/app/[locale]/checkout/CheckoutClient.tsx');

  test('keeps the instructions checkout returned and shows them under the reference', () => {
    assert.match(client, /paymentInstructions/);
    assert.match(client, /<BankTransferInstructions[\s\S]*?heading=\{t\('bankTransferHeading'\)\}/);
  });
});

describe('customer-facing names, in both languages', () => {
  for (const locale of ['el', 'en'] as const) {
    const messages = JSON.parse(read(`messages/${locale}.json`)) as {
      checkout: { paymentMethods: Record<string, string>; bankTransferHeading: string };
    };
    test(`${locale}: bank transfer, cash on delivery, and legacy manual are named`, () => {
      const names = messages.checkout.paymentMethods;
      assert.ok(names.bank_transfer?.trim());
      assert.ok(names.cod?.trim());
      assert.ok(names.manual?.trim(), 'old orders still say how they were paid');
      assert.notEqual(names.bank_transfer, names.cod);
      assert.ok(messages.checkout.bankTransferHeading?.trim());
    });
  }
});

describe('the admin order panel names the method', () => {
  const pay = (provider: string) => ({
    id: 1,
    provider,
    status: 'pending',
    amount: 5000,
    currency: 'EUR',
    method: null,
    providerRef: null,
    refundable: 0,
  });
  const html = (provider: string) =>
    renderToStaticMarkup(
      <OrderPayments
        payments={[pay(provider)]}
        currency="EUR"
        locale="en"
        canWrite={false}
        onRefund={async () => {}}
      />
    );

  test('bank transfer and cash on delivery are told apart', () => {
    assert.match(html('bank_transfer'), /Bank transfer/);
    assert.doesNotMatch(html('bank_transfer'), /delivery/i);
    assert.match(html('cod'), /Cash on delivery/);
  });

  test('an old manual order still reads sensibly', () => {
    assert.match(html('manual'), /Manual/);
  });
});

describe('the settings checkboxes', () => {
  const def = MANAGED_SETTINGS.find((d) => d.key === ECOMMERCE_PAYMENT_PROVIDER_KEY);
  assert.ok(def);

  test('a stored manual shows both offline methods ticked', () => {
    const html = renderToStaticMarkup(
      <SettingField def={def} value="manual,viva" onChange={() => {}} />
    );
    const ticked = [
      ...html.matchAll(/<label[^>]*><input type="checkbox"([^>]*)\/><span>([^<]*)<\/span>/g),
    ]
      .filter(([, attrs]) => /checked/.test(attrs))
      .map(([, , label]) => label);
    assert.equal(ticked.length, 3, `ticked: ${ticked.join(', ')}`);
    assert.ok(ticked.some((l) => /bank transfer/i.test(l)));
    assert.ok(ticked.some((l) => /cash on delivery/i.test(l)));
  });
});
