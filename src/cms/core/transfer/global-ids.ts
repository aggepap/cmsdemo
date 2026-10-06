/**
 * Fresh row ids for a COPIED document.
 *
 * `autoId` repeater rows carry a uuid that is their identity outside the
 * document — a booking option's id keys its availability calendar (`res:<id>`)
 * and `reservations.resource_group_id`. A copy that kept them would share the
 * original's calendar. So a copy gets new ids, and every other string in the
 * document equal to an old id (a price row naming its option) follows.
 *
 * `ids` is shared across the locale rows of one translation group, so all rows
 * of the copy agree on which option is which.
 */
import type { Field } from '../../config/fields';

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function collectAutoIds(fields: readonly Field[], value: unknown, found: string[]): void {
  if (!isRecord(value)) return;
  for (const field of fields) {
    const v = value[field.key];
    if (field.kind === 'repeater' && Array.isArray(v)) {
      for (const row of v) {
        if (!isRecord(row)) continue;
        if (field.autoId && typeof row.id === 'string' && row.id) found.push(row.id);
        collectAutoIds(field.fields, row, found);
      }
    } else if (field.kind === 'group') {
      collectAutoIds(field.fields, v, found);
    }
  }
}

function replaceStrings(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, ids));
  if (isRecord(value)) {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceStrings(v, ids);
    return out;
  }
  return value;
}

export function regenerateAutoIds(
  fields: readonly Field[],
  data: Rec,
  ids: Map<string, string>,
  generate: () => string
): Rec {
  const found: string[] = [];
  collectAutoIds(fields, data, found);
  for (const id of found) if (!ids.has(id)) ids.set(id, generate());
  return replaceStrings(data, ids) as Rec;
}
