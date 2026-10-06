/**
 * What happens when an imported item already exists on the target.
 *
 * The user picks a default per group and may override it per item; this module
 * decides which choices are even possible. It is enforced on the server — the
 * UI disabling an option is a convenience, not the rule.
 */
import { SLUG_MAX_LENGTH } from '../slug';

export type TransferAction = 'skip' | 'overwrite' | 'copy' | 'merge';
/** What an item will actually do: `create` is for items with no match. */
export type ResolvedAction = TransferAction | 'create';

/**
 * - `new`: nothing on the target under this key.
 * - `conflict`: exists, as one identifiable item.
 * - `ambiguous`: the source rows match rows from SEVERAL target items (the
 *   Greek row matches one product, the English row another). Overwriting would
 *   have to pick one, so only skip or copy are offered.
 * - `pathTaken`: the URL belongs to a document of another collection; a unique
 *   column the (type, slug, locale) key does not see.
 */
export type MatchState = 'new' | 'conflict' | 'ambiguous' | 'pathTaken';

export interface TargetMatch {
  locale: string;
  slug: string;
  id: number;
  groupId: string | null;
}

export function classifyDocumentGroup(
  matches: readonly TargetMatch[],
  pathTaken: boolean
): MatchState {
  if (pathTaken) return 'pathTaken';
  if (matches.length === 0) return 'new';
  // An ungrouped row is its own group.
  const groups = new Set(matches.map((m) => m.groupId ?? `id:${m.id}`));
  return groups.size > 1 ? 'ambiguous' : 'conflict';
}

const ONLY_SKIP_OR_COPY: readonly TransferAction[] = ['skip', 'copy'];

/** The actions an item in `state` may take, given what its group allows. */
export function actionsFor(
  state: MatchState,
  allowed: readonly TransferAction[]
): TransferAction[] {
  if (state === 'new') return [];
  if (state === 'ambiguous' || state === 'pathTaken')
    return allowed.filter((a) => ONLY_SKIP_OR_COPY.includes(a));
  return [...allowed];
}

/**
 * The action to take. An override the item cannot take is refused (`null`) —
 * the caller answers 422 rather than quietly doing something else. A group
 * default the item cannot take falls back to skip, the only action that is
 * always safe.
 */
export function resolveAction(
  state: MatchState,
  allowed: readonly TransferAction[],
  groupDefault: TransferAction,
  override?: TransferAction
): ResolvedAction | null {
  if (state === 'new') return 'create';
  const possible = actionsFor(state, allowed);
  if (override !== undefined) return possible.includes(override) ? override : null;
  return possible.includes(groupDefault) ? groupDefault : 'skip';
}

/** `base-2`, `base-3`, … — the first not in `taken`, never longer than `max`. */
export function nextFreeSlug(
  base: string,
  taken: ReadonlySet<string>,
  max: number = SLUG_MAX_LENGTH
): string {
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `Name (2)`, `Name (3)`, … for items keyed by a display name. */
export function nextFreeName(base: string, taken: ReadonlySet<string>, max = 191): string {
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
