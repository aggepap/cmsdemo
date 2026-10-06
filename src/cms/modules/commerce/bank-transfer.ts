/**
 * Telling a bank transfer customer how to pay.
 *
 * A bank transfer order is placed `pending` and stays so until an admin sees
 * the money and marks it paid — so the customer has to be told where to send
 * it. The shop writes that once per language in Settings → Ecommerce (bank,
 * IBAN, beneficiary, "use the order reference"), and it is shown in the order
 * confirmation email and on the thank-you page. Never for another method: bank
 * details beside a card payment or a cash-on-delivery order would be a second
 * way to pay that nobody is watching for.
 *
 * Pure — no settings read, no `server-only` — so it is tested without a
 * database; `getBankTransferInstructions` in `payments.ts` does the reading.
 */
import { escapeHtml } from '../../core/email/format';
import { bankTransferProvider } from '../../core/payments';

/** Languages with their own box, in fallback order. */
const FALLBACK_ORDER = ['el', 'en'] as const;

/**
 * The text for this customer's language; the other language's when theirs is
 * empty (a shop that only filled in Greek still tells an English customer
 * something they can copy an IBAN from); '' when neither is set.
 */
export function pickBankTransferInstructions(
  values: Partial<Record<string, unknown>>,
  locale: string
): string {
  const text = (key: string) => {
    const value = values[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  for (const key of [locale, ...FALLBACK_ORDER]) {
    const found = text(key);
    if (found) return found;
  }
  return '';
}

/**
 * The instructions an order placed just now should show, or null.
 *
 * Only a bank transfer, and only while there is something to transfer — an
 * order a gift card paid in full owes nothing.
 */
export function orderPaymentInstructions(args: {
  provider: string;
  amountDue: number;
  text: string;
}): string | null {
  if (args.provider !== bankTransferProvider.key || args.amountDue <= 0) return null;
  return args.text.trim() || null;
}

/** Does this order still wait on a bank transfer? Read from its payment rows. */
export function owesBankTransfer(
  payments: readonly { provider: string; status: string }[]
): boolean {
  return payments.some((p) => p.provider === bankTransferProvider.key && p.status === 'pending');
}

const HEADINGS: Record<'el' | 'en', string> = {
  el: 'Πώς να πληρώσετε με τραπεζική κατάθεση',
  en: 'How to pay by bank transfer',
};

/**
 * The email block: a heading and the shop's text, escaped, one `<br>` per line
 * break. The text is the admin's free input and goes into HTML mail, so it is
 * escaped whole — an IBAN needs no markup, and a stray `<` must not become one.
 */
export function bankTransferInstructionsHtml(text: string, locale: string): string {
  const body = text.trim();
  if (!body) return '';
  const heading = HEADINGS[locale === 'el' ? 'el' : 'en'];
  const lines = escapeHtml(body.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
  return (
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;margin-top:16px;"><strong>${heading}</strong></p>` +
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;">${lines}</p>`
  );
}
