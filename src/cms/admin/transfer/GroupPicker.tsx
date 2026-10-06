'use client';

import { useId, type Dispatch, type ReactNode } from 'react';

import { Badge, Button } from '../ui';
import { cn } from '../ui/cn';
import { sectionsByModule, type ModuleSection } from './sections';
import { TransferCard } from './TransferCard';
import {
  sectionChosen,
  type GroupMode,
  type SelectionAction,
  type SelectionState,
} from './wizard-state';
import type { GroupOption } from './types';

const MODES: Array<{ mode: GroupMode; label: string }> = [
  { mode: 'none', label: 'None' },
  { mode: 'all', label: 'Everything' },
  { mode: 'some', label: 'Choose items…' },
];

/**
 * One card per module, one row per group — nothing, everything, or chosen
 * items. The item list is supplied by the caller (`renderItems`), because
 * export picks from this site's content and import from the package's.
 * A section whose module is switched off here cannot be picked from.
 */
export function GroupPicker({
  groups,
  state,
  dispatch,
  renderItems,
  note,
  sectionNote,
}: {
  groups: GroupOption[];
  state: SelectionState;
  dispatch: Dispatch<SelectionAction>;
  renderItems: (group: GroupOption) => ReactNode;
  /** Extra line under a group's name — counts, conflicts. */
  note?: (group: GroupOption) => ReactNode;
  /** Extra content at the top of a module's section — why it is off, how to turn it on. */
  sectionNote?: (section: ModuleSection) => ReactNode;
}) {
  // Both wizards stay mounted in their tabs: radios sharing a name are one group
  // across the whole page, so each picker names its own.
  const uid = useId();
  if (groups.length === 0) {
    return (
      <p className="text-sm text-neutral-600">There is nothing here you are allowed to move.</p>
    );
  }

  const row = (group: GroupOption, off: boolean) => {
    const choice = state.groups[group.key] ?? { mode: 'none' as const, keys: [] };
    const extra = note ? note(group) : null;
    return (
      <li key={group.key} className={cn(off && 'opacity-60')}>
        {/* A borderless fieldset: the legend names the radios for assistive
            technology; the visible name sits in the row beside the control. */}
        <fieldset className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <legend className="sr-only">{group.label}</legend>
          <div aria-hidden className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-neutral-900">
              {group.label}
              {group.pii ? <Badge tone="amber">Personal data</Badge> : null}
            </p>
            {extra ? <p className="mt-0.5 text-xs text-neutral-600">{extra}</p> : null}
          </div>
          <div className="flex shrink-0 rounded-sm border border-neutral-200 bg-neutral-100 p-0.5 sm:inline-flex">
            {MODES.map(({ mode, label }) => {
              const checked = choice.mode === mode;
              return (
                <label
                  key={mode}
                  className={cn(
                    'flex min-h-8 flex-1 cursor-pointer items-center justify-center gap-1 rounded-[3px] px-3 text-xs font-medium whitespace-nowrap transition-colors sm:flex-none',
                    'has-[:focus-visible]:ring-warm-gold has-[:focus-visible]:ring-2',
                    checked && mode === 'none' && 'bg-white text-neutral-900 shadow-sm',
                    checked && mode !== 'none' && 'bg-neutral-900 text-white shadow-sm',
                    !checked && 'text-neutral-600 hover:text-neutral-900',
                    off && 'cursor-not-allowed hover:text-neutral-600'
                  )}
                >
                  <input
                    type="radio"
                    name={`${uid}-group-${group.key}`}
                    value={mode}
                    checked={checked}
                    disabled={off}
                    onChange={() => dispatch({ type: 'mode', group: group.key, mode })}
                    className="sr-only"
                  />
                  {label}
                  {mode === 'some' && checked && choice.keys.length > 0 ? (
                    <span className="tabular-nums opacity-80">({choice.keys.length})</span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
        {choice.mode === 'some' && !off ? (
          <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-3">
            {renderItems(group)}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {sectionsByModule(groups).map((section) => {
        const id = `${uid}-module-${section.module ?? 'general'}`;
        const keys = section.groups.map((g) => g.key);
        const chosen = sectionChosen(state, keys);
        const allTaken = keys.every((key) => state.groups[key]?.mode === 'all');
        const anyOpen = keys.some((key) => (state.groups[key]?.mode ?? 'none') !== 'none');
        return (
          <TransferCard
            key={id}
            headingId={id}
            title={section.label}
            bodyClassName=""
            right={
              section.off ? (
                <Badge tone="amber">Off on this site</Badge>
              ) : (
                <>
                  <span className="tabular-nums">
                    {chosen} of {section.groups.length} chosen
                  </span>
                  {/* Always rendered: a button that vanished under the pointer would drop a
                      keyboard user's focus. One that does not apply is marked, not removed. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Clear ${section.label}`}
                    aria-disabled={!anyOpen}
                    className="aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent"
                    onClick={() =>
                      anyOpen && dispatch({ type: 'modeMany', groups: keys, mode: 'none' })
                    }
                  >
                    Clear
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Select all in ${section.label}`}
                    aria-disabled={allTaken}
                    className="aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-white"
                    onClick={() =>
                      !allTaken && dispatch({ type: 'modeMany', groups: keys, mode: 'all' })
                    }
                  >
                    Select all
                  </Button>
                </>
              )
            }
          >
            {sectionNote ? (
              <div className="border-b border-neutral-100 px-4 py-3 empty:hidden">
                {sectionNote(section)}
              </div>
            ) : null}
            <ul className="divide-y divide-neutral-100">
              {section.groups.map((group) => row(group, section.off))}
            </ul>
          </TransferCard>
        );
      })}
    </div>
  );
}
