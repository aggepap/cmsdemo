import { TransferCard } from './TransferCard';
import type { DryRun } from './types';

/** What the import will do, before it does it. */
export function DryRunSummary({ dryRun }: { dryRun: DryRun }) {
  const s = dryRun.summary;
  const rows: Array<[string, number]> = [
    ['Will be created', s.create],
    ['Will be overwritten', s.overwrite],
    ['Will be copied', s.copy],
    ['Will be merged', s.merge],
    ['Will be skipped', s.skip],
    ['Already here', s.reuse],
  ];
  return (
    <div className="flex flex-col gap-4">
      <TransferCard
        title="What the import will do"
        right={
          <span className="tabular-nums">
            {dryRun.total} {dryRun.total === 1 ? 'item' : 'items'} in all
          </span>
        }
      >
        <dl className="grid max-w-xl grid-cols-[1fr_auto] gap-x-6 text-sm">
          {rows.map(([label, n]) => (
            <div
              key={label}
              className="col-span-2 grid grid-cols-subgrid border-b border-neutral-100 py-1.5 last:border-0"
            >
              <dt className={n ? 'text-neutral-800' : 'text-neutral-500'}>{label}</dt>
              <dd
                className={`text-right tabular-nums ${n ? 'font-semibold text-neutral-900' : 'text-neutral-500'}`}
              >
                {n}
              </dd>
            </div>
          ))}
        </dl>
      </TransferCard>

      {dryRun.warnings.length > 0 ? (
        <section
          aria-labelledby="dry-warnings"
          className="rounded-sm border border-amber-300 bg-amber-50 p-3"
        >
          <h3 id="dry-warnings" className="text-sm font-medium text-amber-900">
            Check before importing
          </h3>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-900">
            {dryRun.warnings.map((w) => (
              <li key={w.key}>
                <span className="font-medium">{w.key.replace(/^setting:/, '')}</span>: {w.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {dryRun.required.length > 0 ? (
        <section aria-labelledby="dry-required">
          <h3 id="dry-required" className="text-sm font-medium text-neutral-900">
            Brought along because something you chose needs it ({dryRun.required.length})
          </h3>
          <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-5 text-sm text-neutral-700">
            {dryRun.required.map((r) => (
              <li key={r.key}>{r.label}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {dryRun.external.length > 0 ? (
        <section aria-labelledby="dry-external">
          <h3 id="dry-external" className="text-sm font-medium text-neutral-900">
            Referenced but not imported ({dryRun.external.length})
          </h3>
          <p className="text-xs text-neutral-600">
            Linked to the matching item on this site when there is one; otherwise the link will be
            dropped.
          </p>
          <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-5 text-sm text-neutral-700">
            {dryRun.external.map((r) => (
              <li key={r.key}>{r.label}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {dryRun.invalid.length > 0 ? (
        <section aria-labelledby="dry-invalid">
          <h3 id="dry-invalid" className="text-sm font-medium text-red-800">
            Cannot be imported ({dryRun.invalid.length})
          </h3>
          <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-5 text-sm text-red-800">
            {dryRun.invalid.map((r) => (
              <li key={r.key}>
                {r.key}: {r.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
