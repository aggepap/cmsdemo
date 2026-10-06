/**
 * VAT rates, as the CMS stores them: a percentage typed by an admin (a
 * setting, or a product's own field), read here into basis points.
 *
 * Prices stay VAT-inclusive everywhere; a rate only says how much of a price is
 * VAT, for gateways that itemise (Klarna). Pure — no DB, no `server-only`.
 */

/** The standard Greek rate, used when a site has not set its own. */
export const DEFAULT_VAT_BPS = 2400;

/**
 * A percentage (`24`, `"13"`, `6.5`) as basis points, or `fallbackBps` when the
 * value is unset, not a number, or outside 0–100. `0` is a real rate.
 */
export function vatPercentToBps(raw: unknown, fallbackBps: number): number {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === ''))
    return fallbackBps;
  const percent = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return fallbackBps;
  return Math.round(percent * 100);
}
