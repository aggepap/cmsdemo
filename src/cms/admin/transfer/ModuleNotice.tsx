'use client';

import { moduleLabel } from '../../core/settings/schema';
import { Button } from '../ui';

/**
 * A package holds items for a module that is switched off here. Say so, and let
 * someone who may change Settings turn it on without leaving the import.
 */
export function ModuleNotice({
  module,
  count,
  canActivate,
  busy,
  onActivate,
}: {
  module: string;
  /** Items in the package that need it. */
  count: number;
  canActivate: boolean;
  busy: boolean;
  onActivate: () => void;
}) {
  const label = moduleLabel(module);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="min-w-60 flex-1">
        The {label} module is off on this site, so the {count} item{count === 1 ? '' : 's'} below
        cannot be imported.{' '}
        {canActivate
          ? 'Turn it on to import them — the package is then checked again.'
          : 'Ask someone who can change Settings to turn it on, then check the package again.'}
      </p>
      {canActivate ? (
        <Button size="sm" disabled={busy} onClick={onActivate}>
          Turn on {label}
        </Button>
      ) : null}
    </div>
  );
}
