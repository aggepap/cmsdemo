/**
 * The intro under a shop category's heading: the SEO panel's answer summary —
 * the one-paragraph answer written for search and AI engines — when the editor
 * wrote one, else the category's own description. Marked `summary` for the
 * speakable selectors, like every other page's summary.
 */
export function CategoryIntro({
  answerSummary,
  description,
}: {
  answerSummary: string | null;
  description: string;
}) {
  const text = answerSummary || description;
  if (!text) return null;
  return (
    <p
      data-speakable="summary"
      className="font-body text-text-muted mt-4 max-w-3xl text-lg leading-relaxed"
    >
      {text}
    </p>
  );
}
