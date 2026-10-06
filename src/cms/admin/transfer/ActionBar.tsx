import type { ReactNode } from 'react';

/**
 * The step's summary and its next action, pinned to the bottom of the screen
 * so a long list of groups never pushes them out of reach.
 */
export function ActionBar({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-neutral-200 bg-white px-4 py-3 shadow-[0_-4px_12px_-6px_rgb(0_0_0/0.12)]">
      <p role="status" className="text-sm text-neutral-700">
        {summary}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
