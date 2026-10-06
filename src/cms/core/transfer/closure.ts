/**
 * Dependency closure and write order over item keys (`doc:product:<group>`,
 * `media:<uuid>`, `setting:<key>`, …).
 *
 * Edges point from an item to what it references. Dependencies are followed one
 * way only: a product brings its categories, a category does not bring its
 * products.
 */
export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

export interface ClosureResult {
  /** Everything that will be written: the selection plus what it needs. */
  included: Set<string>;
  /** Pulled in only because something else needs it → who needs it. */
  required: Map<string, string[]>;
  /** Referenced but not coming along (opted out, or not in the package) → who references it. */
  external: Map<string, string[]>;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/**
 * @param available nodes that can be written (present in the package / on this site)
 * @param selected  what the user ticked
 * @param optOut    dependencies the user chose to leave out; an explicit selection wins
 */
export function closure(
  graph: DependencyGraph,
  available: ReadonlySet<string>,
  selected: Iterable<string>,
  optOut: ReadonlySet<string>
): ClosureResult {
  const picked = new Set([...selected].filter((k) => available.has(k)));
  const included = new Set<string>(picked);
  const required = new Map<string, string[]>();
  const external = new Map<string, string[]>();
  const queue = [...picked];

  while (queue.length > 0) {
    const from = queue.shift() as string;
    for (const to of graph.get(from) ?? []) {
      if (picked.has(to)) continue;
      if (!available.has(to) || optOut.has(to)) {
        push(external, to, from);
        continue;
      }
      push(required, to, from);
      if (!included.has(to)) {
        included.add(to);
        queue.push(to);
      }
    }
  }
  return { included, required, external };
}

/**
 * Order `nodes` for writing: by `rank` first, then dependencies before their
 * dependents.
 *
 * A cycle — two products listing each other as related, a document pointing at
 * itself, a setting holding category ids although settings are written before
 * documents — has no valid order. The member written first is written without
 * the reference that is not there yet, and listed in `patch` to be revisited
 * once everything exists. Iterative, so a long chain of parents cannot exhaust
 * the stack.
 */
export function writeOrder(
  nodes: ReadonlySet<string>,
  graph: DependencyGraph,
  rank: (key: string) => number
): { order: string[]; patch: Set<string> } {
  const sorted = [...nodes].sort((a, b) => rank(a) - rank(b));
  const post: string[] = [];
  const state = new Map<string, 'open' | 'done'>();

  for (const root of sorted) {
    if (state.has(root)) continue;
    const stack: Array<{ key: string; next: number }> = [{ key: root, next: 0 }];
    state.set(root, 'open');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = (graph.get(frame.key) ?? []).filter(
        (d) => nodes.has(d) && rank(d) <= rank(frame.key)
      );
      if (frame.next < deps.length) {
        const dep = deps[frame.next++];
        if (!state.has(dep)) {
          state.set(dep, 'open');
          stack.push({ key: dep, next: 0 });
        }
        continue;
      }
      state.set(frame.key, 'done');
      post.push(frame.key);
      stack.pop();
    }
  }

  // Post-order puts dependencies first; a stable sort by rank keeps that within a rank.
  const order = post
    .map((key, i) => ({ key, i }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.i - b.i)
    .map((x) => x.key);
  const position = new Map(order.map((k, i) => [k, i]));
  const patch = new Set<string>();
  for (const key of order) {
    const at = position.get(key) as number;
    for (const dep of graph.get(key) ?? []) {
      const depAt = position.get(dep);
      if (depAt !== undefined && depAt >= at) patch.add(key);
    }
  }
  return { order, patch };
}
