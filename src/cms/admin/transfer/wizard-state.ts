/**
 * What the user has ticked in the Export / Import wizards.
 *
 * Plain data and a pure reducer, shared by both directions, so the request
 * body is derived from one state instead of being assembled by each screen.
 */
export type GroupMode = 'none' | 'all' | 'some';

export interface GroupChoice {
  mode: GroupMode;
  keys: string[];
}

export interface SelectionState {
  groups: Record<string, GroupChoice>;
  /** Dependencies the user chose to leave behind. */
  optOut: string[];
}

export type SelectionAction =
  | { type: 'mode'; group: string; mode: GroupMode }
  /** One mode for several groups at once — a whole module. */
  | { type: 'modeMany'; groups: string[]; mode: 'all' | 'none' }
  | { type: 'toggle'; group: string; key: string }
  | { type: 'optOut'; key: string }
  | { type: 'reset' };

export function emptySelection(): SelectionState {
  return { groups: {}, optOut: [] };
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'mode': {
      const current = state.groups[action.group] ?? { mode: 'none', keys: [] };
      const keys = action.mode === 'none' ? [] : current.keys;
      return { ...state, groups: { ...state.groups, [action.group]: { mode: action.mode, keys } } };
    }
    case 'modeMany': {
      const groups = { ...state.groups };
      for (const group of action.groups) groups[group] = { mode: action.mode, keys: [] };
      return { ...state, groups };
    }
    case 'toggle': {
      const current = state.groups[action.group] ?? { mode: 'none', keys: [] };
      const has = current.keys.includes(action.key);
      const keys = has
        ? current.keys.filter((k) => k !== action.key)
        : [...current.keys, action.key];
      return { ...state, groups: { ...state.groups, [action.group]: { mode: 'some', keys } } };
    }
    case 'optOut': {
      const has = state.optOut.includes(action.key);
      return {
        ...state,
        optOut: has ? state.optOut.filter((k) => k !== action.key) : [...state.optOut, action.key],
      };
    }
    case 'reset':
      return emptySelection();
  }
}

/** The `selection` body the transfer API takes. */
export function toSelectionPayload(state: SelectionState): {
  groups: Record<string, 'all' | string[]>;
  optOut: string[];
} {
  const groups: Record<string, 'all' | string[]> = {};
  for (const [group, choice] of Object.entries(state.groups)) {
    if (choice.mode === 'all') groups[group] = 'all';
    else if (choice.mode === 'some' && choice.keys.length > 0) groups[group] = [...choice.keys];
  }
  return { groups, optOut: [...state.optOut] };
}

export function selectionSize(state: SelectionState): { wholeGroups: number; items: number } {
  let wholeGroups = 0;
  let items = 0;
  for (const choice of Object.values(state.groups)) {
    if (choice.mode === 'all') wholeGroups++;
    else if (choice.mode === 'some') items += choice.keys.length;
  }
  return { wholeGroups, items };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The selection in words, for the bar that carries the next step. */
export function describeSelection(size: { wholeGroups: number; items: number }): string {
  const whole = size.wholeGroups > 0 ? `Everything in ${plural(size.wholeGroups, 'group', 'groups')}` : '';
  const items = size.items > 0 ? plural(size.items, 'chosen item', 'chosen items') : '';
  if (whole && items) return `${whole}, plus ${items}`;
  return whole || items || 'Nothing chosen yet';
}

/** How many of these groups will take something — "choose items" with none ticked takes nothing. */
export function sectionChosen(state: SelectionState, groupKeys: readonly string[]): number {
  return groupKeys.filter((key) => {
    const choice = state.groups[key];
    return choice?.mode === 'all' || (choice?.mode === 'some' && choice.keys.length > 0);
  }).length;
}
