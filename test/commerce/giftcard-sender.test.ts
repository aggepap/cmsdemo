/**
 * A gift card says who it is from.
 *
 * The purchase recorded only the buyer's email, which is never shown to the
 * recipient — so every card arrived as "Somebody has given you a gift card".
 * The buyer can now sign it with a name: optional, trimmed, the same length
 * limit as the recipient's name, and checked again on the server.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { giftCardEmailContent } from '@/cms/modules/commerce/giftcards/emails';
import type { GiftCardConfig } from '@/cms/modules/commerce/giftcards/policy';
import { giftCardDetailsFromSnapshot, validateGiftCardPurchase } from '@/cms/modules/commerce/giftcards/rules';

const config: GiftCardConfig = {
  enabled: true,
  presets: [2500],
  allowCustom: false,
  minAmount: 1000,
  maxAmount: 20000,
  expiryMonths: 24,
};
const today = new Date('2026-09-23T10:00:00Z');
const purchase = (over: Record<string, unknown> = {}) => ({
  amount: 2500,
  recipientName: 'Maria',
  recipientEmail: 'maria@example.com',
  ...over,
});

describe('validateGiftCardPurchase — sender name', () => {
  test('a sender name is kept, trimmed', () => {
    const res = validateGiftCardPurchase(config, purchase({ senderName: '  Nikos  ' }), today);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.senderName, 'Nikos');
  });

  test('no sender, or only spaces, is recorded as none — older carts keep working', () => {
    for (const senderName of [undefined, '', '   ', 42]) {
      const res = validateGiftCardPurchase(config, purchase({ senderName }), today);
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.value.senderName, null);
    }
  });

  test('a sender name is cut to the same length as a recipient name', () => {
    const res = validateGiftCardPurchase(config, purchase({ senderName: 'x'.repeat(300) }), today);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.senderName?.length, 191);
  });
});

describe('giftCardDetailsFromSnapshot', () => {
  test('carries the sender from the order line onto the card', () => {
    assert.deepEqual(
      giftCardDetailsFromSnapshot({ recipientName: 'Maria', recipientEmail: 'm@example.com', message: 'Hi', senderName: 'Nikos' }),
      { recipientName: 'Maria', recipientEmail: 'm@example.com', message: 'Hi', senderName: 'Nikos' },
    );
  });

  test('a line bought before the sender existed has none', () => {
    assert.deepEqual(giftCardDetailsFromSnapshot({ recipientEmail: 'm@example.com' }), {
      recipientName: null,
      recipientEmail: 'm@example.com',
      message: null,
      senderName: null,
    });
  });
});

describe('giftCardEmailContent', () => {
  const card = { code: 'ABCD-EFGH', recipientEmail: 'm@example.com', message: null, amount: 2500, currency: 'EUR' };

  test('names the sender in English, in the intro and a From line', () => {
    const { html } = giftCardEmailContent({ ...card, senderName: 'Nikos' }, 'en');
    assert.match(html, /Nikos has given you a gift card/);
    assert.match(html, /From:<\/strong> Nikos/);
    assert.doesNotMatch(html, /Somebody/);
  });

  test('names the sender in Greek', () => {
    const { html } = giftCardEmailContent({ ...card, senderName: 'Νίκος' }, 'el');
    assert.match(html, /Από:<\/strong> Νίκος/);
    assert.match(html, /<p>Νίκος σου χάρισε μια δωροκάρτα\.<\/p>/);
  });

  test('the sender name is escaped — it is text the buyer typed', () => {
    const { html } = giftCardEmailContent({ ...card, senderName: '<img src=x onerror=alert(1)>' }, 'en');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('without a sender it still reads "Somebody", with no From line', () => {
    for (const senderName of [null, undefined]) {
      const { html } = giftCardEmailContent({ ...card, senderName }, 'en');
      assert.match(html, /Somebody has given you a gift card/);
      assert.doesNotMatch(html, /From:/);
    }
  });

  test('the subject never shows the amount, nor the sender', () => {
    for (const locale of ['en', 'el']) {
      const { subject } = giftCardEmailContent({ ...card, senderName: 'Nikos', amount: 12345 }, locale);
      assert.doesNotMatch(subject, /123|€|EUR|Nikos/);
    }
  });
});

describe('wiring', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

  test('the card table has a nullable sender_name column', () => {
    assert.match(read('src/cms/db/adapters/mysql/schema/giftcards.ts'), /senderName: varchar\('sender_name', \{ length: 191 \}\),/);
  });

  test('checkout accepts a sender name with the recipient name limit', () => {
    assert.match(read('src/cms/modules/commerce/orders.ts'), /senderName: z\.string\(\)\.trim\(\)\.max\(191\)\.optional\(\)/);
  });

  test('issuing and delivering a card carry the sender', () => {
    const service = read('src/cms/modules/commerce/giftcards/service.ts');
    assert.match(service, /giftCardDetailsFromSnapshot\(gift\)/);
    assert.match(service, /senderName: card\.senderName/);
  });

  test('the admin gift card screen shows who it is from', () => {
    assert.match(read('src/app/admin/(shell)/gift-cards/page.tsx'), /senderName: row\.senderName/);
    assert.match(read('src/cms/admin/GiftCardsTable.tsx'), /row\.senderName/);
  });
});
