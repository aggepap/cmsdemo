/**
 * A visible list of questions and answers — the SEO panel's FAQs on the page
 * itself. Search engines only accept FAQ markup for questions a visitor can
 * read, so a page that emits a FAQPage renders this beside it. Plain text only:
 * the answers are the editor's text, never HTML.
 */
export function FaqSection({
  title,
  faqs,
  className = '',
}: {
  title: string;
  faqs: ReadonlyArray<{ question: string; answer: string }>;
  className?: string;
}) {
  if (faqs.length === 0) return null;
  return (
    <section aria-labelledby="faq-heading" className={className}>
      <h2 id="faq-heading" className="font-display text-midnight-navy text-2xl font-semibold">
        {title}
      </h2>
      <dl className="mt-6 flex flex-col gap-6">
        {faqs.map((faq, i) => (
          <div key={i}>
            <dt className="font-body text-text-primary text-base font-semibold">{faq.question}</dt>
            <dd className="font-body text-text-muted mt-2 text-base leading-relaxed">
              {faq.answer}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
