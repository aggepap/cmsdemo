/**
 * What importing a redirect CSV would do, row by row.
 *
 * The same plan serves both steps: the preview the admin reads before
 * committing, and the commit itself, which re-plans from the same file against
 * the table as it is at that moment rather than trusting what the browser saw.
 *
 * Every row goes through `validateRedirect` — the admin form's own rules — with
 * the rules accepted so far in the file counted as active, so two rows that
 * together form a loop are caught even though neither is stored yet.
 *
 * An import never overwrites an existing redirect. A migration file is re-run,
 * edited and re-run again; silently re-pointing a live rule that someone fixed
 * by hand in between is the one outcome nobody wants from a bulk tool. The row
 * is reported as skipped with the current target, and the table is where a live
 * rule is changed. The single exception is a pending mapping, which exists only
 * to be completed: a target for it completes it.
 */
import { ApiError } from '../errors';
import type { RedirectRuleLike } from './match';
import type { RedirectCsvRow } from './redirect-csv';
import { normalizePath, validatePendingRedirect, validateRedirect } from './redirect-rules';

export type ImportOutcome = 'create' | 'pending' | 'complete' | 'skip' | 'error';

export interface ImportRowResult {
  line: number;
  /** As it will be stored (trailing slash removed), or as written when the row failed. */
  source: string;
  target: string;
  statusCode: number;
  notes: string | null;
  outcome: ImportOutcome;
  /** Why a row is skipped or refused. */
  message?: string;
  /** The pending row a `complete` fills in. */
  existingId?: number;
}

export interface ExistingRedirect extends RedirectRuleLike {
  id: number;
  active: boolean;
}

/** The sentence a refusal carries — the field-level one, not "Validation failed.". */
function reason(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.issues as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | undefined;
    const specific = [...Object.values(issues?.fieldErrors ?? {}).flat(), ...(issues?.formErrors ?? [])];
    return specific[0] ?? err.message;
  }
  return err instanceof Error ? err.message : 'This row could not be read.';
}

const STATUS_CODES = ['301', '302', '307', '308'];

export function planRedirectImport(
  rows: readonly RedirectCsvRow[],
  existing: readonly ExistingRedirect[],
): ImportRowResult[] {
  // Only a literal rule can be "the same source": the import writes literal rules.
  const bySource = new Map<string, ExistingRedirect>();
  for (const r of existing) if (r.kind === 'literal') bySource.set(normalizePath(r.source), r);

  const active: RedirectRuleLike[] = existing.filter((r) => r.active && r.target !== '');
  const seenAt = new Map<string, number>();

  return rows.map((row): ImportRowResult => {
    const notes = row.notes || null;
    const statusCode = row.statusCode === '' ? 301 : Number(row.statusCode);
    const base = { line: row.line, source: row.source, target: row.target, statusCode, notes };
    const fail = (message: string): ImportRowResult => ({ ...base, outcome: 'error', message });

    if (!row.source.trim()) return fail('This row has no source.');
    if (row.statusCode !== '' && !STATUS_CODES.includes(row.statusCode)) {
      return fail(`Status must be one of ${STATUS_CODES.join(', ')} — or left blank for 301.`);
    }
    const key = normalizePath(row.source);
    const firstLine = seenAt.get(key);
    if (firstLine !== undefined) {
      return { ...base, source: key, outcome: 'skip', message: `Same source as line ${firstLine}.` };
    }
    seenAt.set(key, row.line);

    const statusField = row.statusCode === '' ? undefined : row.statusCode;
    const current = bySource.get(key);

    if (row.target === '') {
      try {
        const input = validatePendingRedirect({ source: row.source, statusCode: statusField, notes });
        if (current) {
          return {
            ...base,
            source: input.source,
            outcome: 'skip',
            message: current.target ? `Already redirects to ${current.target}.` : 'Already pending.',
          };
        }
        return { ...base, source: input.source, outcome: 'pending' };
      } catch (err) {
        return fail(reason(err));
      }
    }

    if (current && current.target !== '') {
      const same = normalizePath(current.target) === normalizePath(row.target);
      return {
        ...base,
        source: key,
        outcome: 'skip',
        message: same
          ? 'Already redirects there.'
          : `Already redirects to ${current.target} — change it in the table if that is wrong.`,
      };
    }

    try {
      const input = validateRedirect(
        { source: row.source, target: row.target, statusCode: statusField, kind: 'literal', notes },
        active,
      );
      active.push({ source: input.source, target: input.target, kind: 'literal' });
      return {
        ...base,
        source: input.source,
        target: input.target,
        ...(current ? { outcome: 'complete', existingId: current.id } : { outcome: 'create' }),
      };
    } catch (err) {
      return fail(reason(err));
    }
  });
}

export function summarizeImport(results: readonly ImportRowResult[]): Record<ImportOutcome, number> {
  const out: Record<ImportOutcome, number> = { create: 0, pending: 0, complete: 0, skip: 0, error: 0 };
  for (const r of results) out[r.outcome] += 1;
  return out;
}
