import 'server-only';

import { z } from 'zod';

import { PERMISSIONS, requireApiPerm } from '../../modules/auth';
import { logAudit } from '../audit';
import { createRoute } from '../api/handler';
import { idParam } from '../api/params';
import { created, noContent, ok } from '../api/respond';
import {
  applyRedirectImport,
  createRedirect,
  delete404,
  deleteMeta,
  deleteRedirect,
  list404,
  listMeta,
  listRedirects,
  patchMeta,
  set404Ignored,
  updateRedirect,
} from '../seo/service';
import { redirectWouldLoop } from '../seo/match';
import { pendingActivationProblem } from '../seo/pending';
import { parseRedirectCsv, REDIRECT_CSV_MAX_BYTES } from '../seo/redirect-csv';
import { planRedirectImport, summarizeImport } from '../seo/redirect-import';
import {
  checkKindShape,
  pendingRedirectBody,
  publishableUrl,
  redirectBody,
  redirectPatchBody,
  SELF_LOOP,
  storableSource,
  validateRedirect,
  validatePendingRedirect,
  type PendingRedirectBody,
  type RedirectBody,
} from '../seo/redirect-rules';
import { revalidateMeta, revalidateRedirects } from '../seo/resolve';
import { invalidInput, notFound } from '../errors';

/**
 * Would saving `source -> target` create a redirect cycle?
 *
 * Blocking only a rule that points at itself was not enough: two rules,
 * `/a -> /b` and `/b -> /a`, are each individually fine and together send the
 * visitor bouncing forever. The resolver follows ONE hop per request, so a
 * multi-rule cycle never surfaces server-side — it only manifests in the
 * browser, as a page that will not load.
 *
 * So the chain is walked here, at write time, across the other active rules.
 * `excludeId` is the rule being edited, whose stored version must not be
 * counted against its own replacement.
 */
async function wouldLoop(source: string, target: string, excludeId?: number): Promise<boolean> {
  /*
   * Every active rule, not only the literal ones.
   *
   * This used to filter `kind === 'literal'`, which made the loop check blind to
   * exactly the rules most likely to form one: a wildcard `/docs/*` that swallows
   * a whole subtree can send a visitor straight back to a path a literal rule
   * bounces forward again, and neither rule looks wrong on its own. The check that
   * refuses a self-loop and a two-rule cycle (F-013, F-014) therefore passed
   * happily on a cycle built from mixed kinds (F-051).
   *
   * The walk itself is `redirectWouldLoop`, which asks the resolver's own question
   * — "does any active rule match this path?" — so the two cannot disagree.
   */
  return redirectWouldLoop(await activeRulesExcept(excludeId), source, target);
}

/** The rules a new or changed one is checked against: the active ones, minus itself. */
async function activeRulesExcept(excludeId?: number) {
  return (await listRedirects()).filter((r) => r.active !== false && r.id !== excludeId);
}

export function redirectsListRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoRead),
    handler: async () => ok(await listRedirects()),
  });
}

/**
 * Every check a new redirect goes through — shape, the kind's own rules (a regex
 * must be safe to run on every request), and loops across the active rules —
 * returning it as stored. Shared by the screen and by site transfer, so an
 * imported redirect cannot be one the screen would refuse.
 *
 * @param excludeId the rule being replaced, whose stored version must not count against it
 */
export async function checkRedirect(raw: unknown, excludeId?: number): Promise<RedirectBody> {
  return validateRedirect(raw, await activeRulesExcept(excludeId));
}

/**
 * The same for a pending mapping — an old URL with no target yet. Shared with
 * site transfer, which carries pending rows like any other.
 */
export function checkPendingRedirect(raw: unknown): PendingRedirectBody {
  return validatePendingRedirect(raw);
}

export function redirectCreateRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    input: redirectBody,
    handler: async ({ input: body, auth }) => {
      const input = await checkRedirect(body);
      const row = await createRedirect(input, auth.userId);
      revalidateRedirects();
      await logAudit({ userId: auth.userId, action: 'redirect.create', subjectType: 'seo_redirect', subjectId: row.id, after: row });
      return created(row);
    },
  });
}

export function redirectUpdateRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    input: redirectPatchBody,
    handler: async ({ params, input, auth }) => {
      const id = idParam(params.id);
      // Changing one side only: compare against what is stored, or a PATCH
      // carrying just `target` could still point the rule at its own source.
      // Switching a rule on needs the stored row too: a pending mapping has no
      // target, and switching it on alone would publish a redirect to nowhere.
      const sides = input.source !== undefined || input.target !== undefined;
      if (sides || input.active === true) {
        const current = (await listRedirects()).find((r) => r.id === id);
        if (!current) throw notFound('Redirect not found.');
        const pending = pendingActivationProblem(current, input);
        if (pending) throw invalidInput({ fieldErrors: { target: [pending] } }, pending);
        if (sides) {
          const nextSource = input.source ?? current.source;
          const nextTarget = input.target ?? current.target;
          // A patch may change only the kind, or only the source — either can turn a
          // sound rule into a misleading or a dangerous one, so the final shape is what
          // gets checked.
          const nextKind = input.kind ?? current.kind;
          const shape = checkKindShape(nextKind, nextSource);
          if (shape) throw invalidInput({ fieldErrors: { source: [shape] } }, shape);
          if (input.source !== undefined) input.source = storableSource(input.source);
          // A pending mapping that only gets a new source still has nowhere to go,
          // so there is no chain to walk.
          if (nextTarget !== '' && (await wouldLoop(nextSource, nextTarget, id))) {
            throw invalidInput({ fieldErrors: { target: [SELF_LOOP] } }, SELF_LOOP);
          }
        }
      }
      await updateRedirect(id, input);
      revalidateRedirects();
      await logAudit({ userId: auth.userId, action: 'redirect.update', subjectType: 'seo_redirect', subjectId: id, after: input });
      return ok({ ok: true });
    },
  });
}

/**
 * Write down an old URL with no target yet — from the 404 monitor, when the
 * right destination is not obvious. It is never served (see `seo/pending.ts`)
 * and is completed later through the ordinary PATCH.
 */
export function redirectPendingCreateRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    input: pendingRedirectBody,
    handler: async ({ input: body, auth }) => {
      const input = checkPendingRedirect(body);
      const row = await createRedirect({ ...input, target: '', active: false }, auth.userId);
      await logAudit({ userId: auth.userId, action: 'redirect.pending', subjectType: 'seo_redirect', subjectId: row.id, after: row });
      return created(row);
    },
  });
}

const redirectImportBody = z.object({
  // Characters, not bytes — the parser re-checks the byte size. This is the cap
  // that stops an oversized body before any parsing is spent on it.
  csv: z.string().max(REDIRECT_CSV_MAX_BYTES),
  /** false: a preview of what would happen, nothing written. */
  commit: z.boolean().default(false),
});

/**
 * Import redirects from CSV: `source,target[,status][,notes]`.
 *
 * Two calls with the same file: a preview (`commit: false`) that writes nothing,
 * then the commit. The commit plans again from scratch against the table as it is
 * now, so it never acts on a preview the browser could have edited or that went
 * stale — at worst a row the preview called new is reported as a duplicate.
 */
export function redirectImportRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    input: redirectImportBody,
    handler: async ({ input, auth }) => {
      const parsed = parseRedirectCsv(input.csv);
      if (!parsed.ok) throw invalidInput({ formErrors: [parsed.error] }, parsed.error);
      const plan = planRedirectImport(parsed.rows, await listRedirects());
      if (!input.commit) return ok({ committed: false, summary: summarizeImport(plan), rows: plan });

      const rows = await applyRedirectImport(plan, auth.userId);
      revalidateRedirects();
      const summary = summarizeImport(rows);
      await logAudit({
        userId: auth.userId,
        action: 'redirect.import',
        subjectType: 'seo_redirect',
        after: { summary, rows: rows.length },
      });
      return ok({ committed: true, summary, rows });
    },
  });
}

export function redirectDeleteRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    handler: async ({ params, auth }) => {
      const id = idParam(params.id);
      await deleteRedirect(id);
      revalidateRedirects();
      await logAudit({ userId: auth.userId, action: 'redirect.delete', subjectType: 'seo_redirect', subjectId: id });
      return noContent();
    },
  });
}

// ── 404 monitor ───────────────────────────────────────────────────────────
export function notFoundListRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoRead),
    handler: async () => ok(await list404()),
  });
}

const notFoundPatch = z.object({ ignored: z.boolean().optional() });

export function notFoundUpdateRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    input: notFoundPatch,
    handler: async ({ params, input, auth }) => {
      const id = idParam(params.id);
      // An empty patch changes nothing, so it records nothing. The audit log is
      // only useful if an entry in it means something happened; a caller could
      // otherwise fill it with `seo.404.update` rows that touched no row at all.
      if (input.ignored === undefined) return ok({ ok: true });
      await set404Ignored(id, input.ignored);
      await logAudit({
        userId: auth.userId,
        action: 'seo.404.update',
        subjectType: 'seo_not_found',
        subjectId: id,
        after: input,
      });
      return ok({ ok: true });
    },
  });
}

export function notFoundDeleteRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    handler: async ({ params, auth }) => {
      const id = idParam(params.id);
      await delete404(id);
      await logAudit({
        userId: auth.userId,
        action: 'seo.404.delete',
        subjectType: 'seo_not_found',
        subjectId: id,
      });
      return noContent();
    },
  });
}

// ── Per-path meta overrides ─────────────────────────────────────────────────

/** A per-path meta override as the SEO screen accepts it — shared with site transfer. */
export const metaBody = z.object({
  path: z.string().trim().min(1).max(255),
  locale: z.string().trim().max(8),
  title: z.string().max(255).nullish(),
  description: z.string().max(320).nullish(),
  robots: z.string().max(64).nullish(),
  canonical: publishableUrl('Canonical URL').nullish(),
  ogTitle: z.string().max(255).nullish(),
  ogDescription: z.string().max(320).nullish(),
  ogImage: publishableUrl('Social image URL').nullish(),
});

export function metaListRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoRead),
    handler: async () => ok(await listMeta()),
  });
}

export function metaUpsertRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    input: metaBody,
    handler: async ({ input, auth }) => {
      // A merge, not a whole-row write: the form does not manage og:title /
      // og:description, which the PM bridge writes onto the same row, and a
      // `upsertMeta` here nulled them on every admin save. Fields the form sends
      // (null included) are written; fields it omits are left alone.
      await patchMeta(input, auth.userId);
      revalidateMeta();
      await logAudit({
        userId: auth.userId,
        action: 'seo.meta.upsert',
        subjectType: 'seo_meta',
        after: input,
      });
      return ok({ ok: true });
    },
  });
}

export function metaDeleteRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.seoWrite),
    handler: async ({ params, auth }) => {
      const id = idParam(params.id);
      await deleteMeta(id);
      revalidateMeta();
      await logAudit({
        userId: auth.userId,
        action: 'seo.meta.delete',
        subjectType: 'seo_meta',
        subjectId: id,
      });
      return noContent();
    },
  });
}
