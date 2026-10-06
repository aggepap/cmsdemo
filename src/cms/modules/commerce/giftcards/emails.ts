import 'server-only';

import { emailColor, escapeHtml, formatMoney, sendGraphMail } from '../../../core/email';

/**
 * The email that carries a gift card.
 *
 * It contains the code, which is money — so it goes only to the recipient the
 * buyer named, and the subject never says what it is worth, because a subject
 * line is visible on a lock screen — nor who it is from. The buyer may sign
 * the card with a name; when they did, the body names them in the intro instead
 * of "Somebody" and adds a "From: …" line. Their email is never shown.
 */

const LABELS = {
  el: {
    subject: 'Έχεις μια δωροκάρτα!',
    intro: 'Κάποιος σου χάρισε μια δωροκάρτα.',
    introFrom: (name: string) => `${name} σου χάρισε μια δωροκάρτα.`,
    from: 'Από',
    code: 'Ο κωδικός σου',
    howTo: 'Πληκτρολόγησέ τον στο ταμείο, στο πεδίο «Κωδικός δωροκάρτας».',
    value: 'Αξία',
  },
  en: {
    subject: 'You have a gift card!',
    intro: 'Somebody has given you a gift card.',
    introFrom: (name: string) => `${name} has given you a gift card.`,
    from: 'From',
    code: 'Your code',
    howTo: 'Type it at checkout, in the “Gift card code” field.',
    value: 'Value',
  },
};

export interface GiftCardEmailCard {
  code: string;
  recipientEmail: string | null;
  message: string | null;
  /** How the buyer signed it; absent on cards issued by hand or bought unsigned. */
  senderName?: string | null;
  amount: number;
  currency: string;
}

/** The subject and body of a gift card email — everything but the sending. */
export function giftCardEmailContent(
  card: GiftCardEmailCard,
  locale: string
): { subject: string; html: string } {
  const L = locale === 'en' ? LABELS.en : LABELS.el;
  const sender = card.senderName?.trim() || null;
  return {
    subject: L.subject,
    html:
      `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:${emailColor('midnight-navy')};">` +
      `<p>${escapeHtml(sender ? L.introFrom(sender) : L.intro)}</p>` +
      (sender ? `<p><strong>${escapeHtml(L.from)}:</strong> ${escapeHtml(sender)}</p>` : '') +
      (card.message ? `<blockquote>${escapeHtml(card.message)}</blockquote>` : '') +
      `<p><strong>${escapeHtml(L.code)}:</strong> ` +
      `<code style="font-size:18px;letter-spacing:2px;">${escapeHtml(card.code)}</code></p>` +
      `<p>${escapeHtml(L.value)}: ${escapeHtml(formatMoney(card.amount, card.currency, locale))}</p>` +
      `<p style="font-size:13px;color:#6b7280;">${escapeHtml(L.howTo)}</p>` +
      `</div>`,
  };
}

export async function sendGiftCardEmail(card: GiftCardEmailCard, locale: string): Promise<void> {
  if (!card.recipientEmail || !card.code) return;
  await sendGraphMail({ to: card.recipientEmail, ...giftCardEmailContent(card, locale) });
}
