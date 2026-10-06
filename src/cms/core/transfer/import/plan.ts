/**
 * The import plan — the dry run.
 *
 * Built from the analysed package (`index.json`) and the user's decisions, it
 * fixes everything the run will do: which items, in which order, with which
 * action, and — for anything created — the translation group id it will get.
 * Minting that id here rather than during the run is what makes the run
 * resumable: after an interrupted step, "was this written?" is answered by
 * looking for rows with the planned id.
 *
 * Pure: permissions arrive as data, so the rules are testable without a server.
 */
import { closure, writeOrder } from '../closure';
import {
  resolveAction,
  type MatchState,
  type ResolvedAction,
  type TransferAction,
} from '../conflicts';
import { canImportGroup, groupDef, groupOfItem, itemRank, type GroupKey } from '../groups';
import type { RefResolver } from '../refs';

export interface ImportIndexItem {
  key: string;
  /** What the user sees: a title, a file name, a setting key. */
  label: string;
  state: MatchState;
  /** Item keys this item references. */
  deps: string[];
  /** Why the record cannot be imported at all (failed validation). */
  invalid?: string;
  /** What deserves a second look before importing this (see `settingWarning`). */
  warning?: string | null;
  /** The matching item on this site, for the conflict table. */
  match?: { id: number | string; label: string } | null;
}

export interface ImportDecisions {
  selection: {
    /** Per group: every item, or the chosen item keys. */
    groups: Record<string, 'all' | string[]>;
    /** Dependencies to leave out. */
    optOut: string[];
  };
  /** Default action for conflicts, per group. */
  defaults: Record<string, TransferAction>;
  /** Per-item override. */
  overrides: Record<string, TransferAction>;
}

export interface PlannedItem {
  action: ResolvedAction;
  /**
   * For a document: the translation group id a created or copied item gets, and
   * the one an overwritten item gets if it has none on this site yet.
   */
  targetGroupId?: string;
}

export interface ImportPlan {
  order: string[];
  /** Items written before something they reference; revisited at the end. */
  patch: string[];
  items: Record<string, PlannedItem>;
  required: Record<string, string[]>;
  external: Record<string, string[]>;
  invalid: Record<string, string>;
  /** `reuse`: media identical to a file this site already has — nothing is stored. */
  summary: Record<TransferAction | 'create' | 'reuse', number>;
}

export type PlanResult = { ok: true; plan: ImportPlan } | { ok: false; errors: string[] };

export function buildPlan(
  index: readonly ImportIndexItem[],
  decisions: ImportDecisions,
  ctx: { perms: readonly string[]; newGroupId: () => string }
): PlanResult {
  const errors: string[] = [];
  const byKey = new Map(index.map((i) => [i.key, i]));
  const importable = (key: string): boolean => {
    const group = groupOfItem(key);
    return group !== null && canImportGroup(ctx.perms, group);
  };

  const selected: string[] = [];
  for (const [group, choice] of Object.entries(decisions.selection.groups)) {
    const keys =
      choice === 'all'
        ? index.filter((i) => groupOfItem(i.key) === group).map((i) => i.key)
        : choice.filter((k) => groupOfItem(k) === group && byKey.has(k));
    if (keys.length === 0) continue;
    if (!canImportGroup(ctx.perms, group as GroupKey)) {
      errors.push(`You do not have permission to import ${group}.`);
      continue;
    }
    selected.push(...keys);
  }

  const invalid: Record<string, string> = {};
  for (const i of index) if (i.invalid) invalid[i.key] = i.invalid;
  const available = new Set(index.filter((i) => !i.invalid && importable(i.key)).map((i) => i.key));
  const graph = new Map(index.map((i) => [i.key, i.deps]));
  const result = closure(graph, available, selected, new Set(decisions.selection.optOut));

  const items: Record<string, PlannedItem> = {};
  const summary: ImportPlan['summary'] = {
    create: 0,
    reuse: 0,
    overwrite: 0,
    copy: 0,
    skip: 0,
    merge: 0,
  };
  for (const key of result.included) {
    const info = byKey.get(key) as ImportIndexItem;
    const group = groupOfItem(key) as GroupKey;
    const def = groupDef(group);
    const action = resolveAction(
      info.state,
      def.actions,
      decisions.defaults[group] ?? def.defaultAction,
      decisions.overrides[key]
    );
    if (action === null) {
      errors.push(`${key}: "${decisions.overrides[key]}" is not possible for this item.`);
      continue;
    }
    const planned: PlannedItem = { action };
    if (
      def.family === 'documents' &&
      (action === 'create' || action === 'copy' || action === 'overwrite')
    )
      planned.targetGroupId = ctx.newGroupId();
    items[key] = planned;
    summary[def.family === 'media' && info.match ? 'reuse' : action]++;
  }
  if (errors.length > 0) return { ok: false, errors };

  const { order, patch } = writeOrder(result.included, graph, itemRank);
  return {
    ok: true,
    plan: {
      order,
      patch: [...patch],
      items,
      required: Object.fromEntries(result.required),
      external: Object.fromEntries(result.external),
      invalid,
      summary,
    },
  };
}

export interface IdMaps {
  /** Source document row id → target row id. */
  doc: Record<string, number>;
  /** Source media uuid → target uuid. */
  media: Record<string, string>;
}

/**
 * References resolve to what this import wrote first, then to what the target
 * already had (`existing`, resolved by natural key when the plan was made), and
 * otherwise are dropped. Never to the source id itself: on this site that id
 * belongs to something else.
 */
export function makeResolver(written: IdMaps, existing: IdMaps): RefResolver {
  return {
    doc: (id) => written.doc[String(id)] ?? existing.doc[String(id)] ?? null,
    media: (uuid) => written.media[uuid] ?? existing.media[uuid] ?? null,
  };
}
