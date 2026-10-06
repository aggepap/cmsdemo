/**
 * Where an old URL most likely belongs on the site as it is now.
 *
 * The 404 monitor's "→ redirect" used to send every missing path to the home
 * page. Search engines treat a redirect from a specific page to the home page as
 * a soft 404 — the old page's ranking is dropped anyway — and visitors land
 * somewhere that has nothing to do with what they followed. A migration also
 * tends to keep slugs while changing the folders around them
 * (`/product/blue-shirt/` → `/shop/blue-shirt`), so the slug is usually the
 * strongest clue there is.
 *
 * In order of confidence:
 *   1. `exact`        — the same path, give or take case, a trailing slash or an
 *                       old `.html` / `.php` ending;
 *   2. `same-slug`    — a page whose last segment is the same slug;
 *   3. `similar-slug` — a page whose slug is nearly the same (`blue-shirt-2`);
 *   4. `parent`       — the page is gone, but its parent category exists.
 * Otherwise nothing — never `/`. A suggestion is only a proposal: the admin
 * confirms or edits it before anything is created.
 *
 * Pure: the admin screen computes it from the site's known URLs (the sitemap's
 * own list), and tests call it directly.
 */
import { redirectMatches } from './match';

export type SuggestionReason = 'exact' | 'same-slug' | 'similar-slug' | 'parent';

export interface TargetSuggestion {
  target: string;
  reason: SuggestionReason;
}

/** How alike two slugs must be (Dice coefficient over character pairs) to be suggested. */
const SIMILARITY_THRESHOLD = 0.7;

/** Endings an old site's URLs carried that mean nothing on this one. */
const OLD_EXTENSION = /\.(html?|php|aspx?|jsp)$/i;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Case- and accent-insensitive, so `Πουκάμισο` and `πουκαμισο` are the same slug. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function segmentsOf(path: string): string[] {
  const segs = decode(path.split(/[?#]/, 1)[0]).split('/').filter(Boolean);
  if (segs.length) segs[segs.length - 1] = segs[segs.length - 1].replace(OLD_EXTENSION, '');
  return segs.map(fold).filter(Boolean);
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const pair = s.slice(i, i + 2);
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const pa = bigrams(a);
  const pb = bigrams(b);
  let shared = 0;
  for (const [pair, n] of pa) shared += Math.min(n, pb.get(pair) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

interface Candidate {
  path: string;
  segs: string[];
  slug: string;
}

/** How many of the old path's folders the candidate shares — the tie-breaker. */
function sharedFolders(old: string[], c: Candidate): number {
  const folders = new Set(c.segs.slice(0, -1));
  return old.slice(0, -1).filter((s) => folders.has(s)).length;
}

function best(old: string[], pool: Candidate[]): Candidate | undefined {
  return [...pool].sort(
    (a, b) => sharedFolders(old, b) - sharedFolders(old, a) || a.path.length - b.path.length,
  )[0];
}

/** The best candidate for one set of segments, or undefined. `similar` allows step 3. */
function match(
  segs: string[],
  candidates: Candidate[],
  similar: boolean,
): { candidate: Candidate; reason: SuggestionReason } | undefined {
  const joined = segs.join('/');
  const exact = candidates.find((c) => c.segs.join('/') === joined);
  if (exact) return { candidate: exact, reason: 'exact' };

  const slug = segs[segs.length - 1];
  const sameSlug = best(
    segs,
    candidates.filter((c) => c.slug === slug),
  );
  if (sameSlug) return { candidate: sameSlug, reason: 'same-slug' };

  if (!similar || slug.length < 3) return undefined;
  let top: { candidate: Candidate; score: number } | undefined;
  for (const c of candidates) {
    const score = dice(slug, c.slug);
    if (score >= SIMILARITY_THRESHOLD && (!top || score > top.score)) top = { candidate: c, score };
  }
  return top ? { candidate: top.candidate, reason: 'similar-slug' } : undefined;
}

export function suggestRedirectTarget(
  oldPath: string,
  knownPaths: readonly string[],
  opts: { localePrefixes?: readonly string[] } = {},
): TargetSuggestion | null {
  const segs = segmentsOf(oldPath);
  // A language prefix belongs to the visitor, not to the page: match without it,
  // and send them to the same language on the new address.
  let prefix = '';
  if (segs.length > 1 && opts.localePrefixes?.includes(segs[0])) prefix = `/${segs.shift()}`;
  if (!segs.length) return null;

  const candidates: Candidate[] = [];
  for (const path of knownPaths) {
    const cSegs = segmentsOf(path);
    // The home page is never a suggestion, and neither is the old path itself —
    // that would be a redirect onto itself.
    if (!cSegs.length || redirectMatches(oldPath, 'literal', `${prefix}${path}`)) continue;
    candidates.push({ path, segs: cSegs, slug: cSegs[cSegs.length - 1] });
  }

  const direct = match(segs, candidates, true);
  if (direct) return { target: `${prefix}${direct.candidate.path}`, reason: direct.reason };

  for (let depth = segs.length - 1; depth >= 1; depth -= 1) {
    const parent = match(segs.slice(0, depth), candidates, false);
    if (parent) return { target: `${prefix}${parent.candidate.path}`, reason: 'parent' };
  }
  return null;
}
