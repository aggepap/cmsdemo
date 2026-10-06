import { cn } from '../ui/cn';
import { Icon } from '../ui/Icon';

/** Where the user is in a wizard: the steps in order, the current one marked. */
export function WizardSteps({
  steps,
  current,
  label,
}: {
  steps: string[];
  /** Index into `steps`. */
  current: number;
  label: string;
}) {
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map((step, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li key={step} className="flex items-center gap-2">
            {i > 0 ? (
              <span aria-hidden className={cn('h-px w-3 sm:w-5', done || now ? 'bg-neutral-400' : 'bg-neutral-200')} />
            ) : null}
            <span
              aria-current={now ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 font-medium',
                now ? 'text-neutral-900' : done ? 'text-neutral-700' : 'text-neutral-500'
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[11px] tabular-nums',
                  now && 'bg-neutral-900 text-white',
                  done && 'bg-neutral-200 text-neutral-800',
                  !now && !done && 'border border-neutral-300 text-neutral-500'
                )}
              >
                {done ? <Icon name="check" size={12} /> : i + 1}
              </span>
              {/* On a phone only the current step is named; the others keep their number. */}
              <span className={now ? undefined : 'sr-only sm:not-sr-only'}>{step}</span>
              {done ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
