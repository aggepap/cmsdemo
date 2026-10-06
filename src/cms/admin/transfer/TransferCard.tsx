import { useId, type ReactNode } from 'react';

/**
 * A titled card in the admin's Section style, with a real heading so the
 * wizard's parts can be reached by heading navigation.
 */
export function TransferCard({
  title,
  right,
  headingId,
  children,
  bodyClassName = 'flex flex-col gap-3 p-4',
}: {
  title: ReactNode;
  right?: ReactNode;
  /** Pass one to point elsewhere at the heading; otherwise one is generated. */
  headingId?: string;
  children: ReactNode;
  bodyClassName?: string;
}) {
  const generated = useId();
  const id = headingId ?? generated;
  return (
    <section aria-labelledby={id} className="rounded-sm border border-neutral-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3">
        <h3 id={id} className="font-display text-sm font-semibold text-neutral-900">
          {title}
        </h3>
        {right ? <div className="flex items-center gap-2 text-xs text-neutral-600">{right}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
