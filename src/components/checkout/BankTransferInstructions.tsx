import { useId } from 'react';

/**
 * How to pay a bank transfer order, on the thank-you page.
 *
 * The text is the shop's own (Settings → Ecommerce → Bank transfer
 * instructions): bank, IBAN, beneficiary. It renders as text — React escapes
 * it — with the admin's line breaks kept, so an IBAN on its own line stays on
 * its own line. Checkout only sends it for a bank transfer; with nothing to
 * say, nothing renders.
 */
export function BankTransferInstructions({
  heading,
  text,
}: {
  heading: string;
  text: string | null | undefined;
}) {
  const id = useId();
  const body = text?.trim();
  if (!body) return null;
  return (
    <section
      aria-labelledby={id}
      className="border-border-soft mt-8 rounded-sm border bg-white p-6 text-left"
    >
      <h2 id={id} className="font-display text-midnight-navy text-lg font-semibold">
        {heading}
      </h2>
      <p className="font-body text-text-primary mt-3 text-sm whitespace-pre-line">{body}</p>
    </section>
  );
}
