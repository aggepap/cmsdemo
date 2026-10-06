/**
 * Pending mappings, and how the 404 monitor relates to the redirect list.
 *
 * A pending mapping is an old URL written down before anyone has decided where it
 * should go — a migration file's row with an empty target, or a 404 someone wants
 * to come back to. It is stored as an ordinary `seo_redirects` row with an EMPTY
 * target and `active = false`, rather than in a column of its own:
 *
 *   - the resolver reads active rows only (`resolve.ts`), so a pending row can
 *     never be served, and the loop check skips inactive rows the same way;
 *   - `(source, kind)` stays unique across real and pending rules, so an old URL
 *     cannot be both pending and redirected at once;
 *   - completing one is the existing PATCH with a target and `active: true`;
 *   - no schema change, so every site gets it without a migration.
 *
 * "Disabled" and "pending" are told apart by the target alone: a disabled rule
 * still has one. The one way to get it wrong — switching a pending row on with
 * nothing to send visitors to — is refused by `pendingActivationProblem`.
 *
 * Pure, so the admin screen and the routes share one definition.
 */
import { redirectMatches } from './match';

export function isPendingRedirect(r: { target: string }): boolean {
  return r.target === '';
}

/**
 * Why a patch may not be applied to a rule, as far as pending is concerned: a
 * row with no target cannot be switched on unless the same patch gives it one.
 */
export function pendingActivationProblem(
  current: { target: string },
  patch: { active?: boolean; target?: string; [field: string]: unknown },
): string | null {
  if (patch.active !== true) return null;
  if ((patch.target ?? current.target) !== '') return null;
  return 'This mapping has no target yet — choose where it should go before switching it on.';
}

/**
 * The address a visitor actually asked for. The 404 log stores the path without
 * its language prefix and the language beside it; a redirect source is matched
 * on the full public path, where the main language has no prefix.
 */
export function publicNotFoundPath(nf: { path: string; locale: string | null }, mainLocale?: string): string {
  if (!nf.locale || !mainLocale || nf.locale === mainLocale) return nf.path;
  return `/${nf.locale}${nf.path === '/' ? '' : nf.path}`;
}

export type NotFoundLink =
  | { state: 'pending'; redirectId: number }
  | { state: 'redirected'; redirectId: number; target: string }
  | null;

/**
 * What the redirect list already says about a logged 404 path: a live rule now
 * catches it (the first one, as the resolver would pick), or it is waiting as a
 * pending mapping. A disabled rule says neither — the path still 404s.
 */
export function notFoundLink(
  path: string,
  redirects: ReadonlyArray<{ id: number; source: string; target: string; kind: string; active: boolean }>,
): NotFoundLink {
  const live = redirects.find((r) => r.active && r.target !== '' && redirectMatches(r.source, r.kind, path));
  if (live) return { state: 'redirected', redirectId: live.id, target: live.target };
  const pending = redirects.find((r) => isPendingRedirect(r) && redirectMatches(r.source, r.kind, path));
  return pending ? { state: 'pending', redirectId: pending.id } : null;
}
