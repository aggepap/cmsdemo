import { unstable_cache } from 'next/cache';

/**
 * `unstable_cache`, minus its one failure outside a Next server.
 *
 * With no server around it — a seed CLI, a `tsx` script — `unstable_cache`
 * throws "incrementalCache missing". Callers that treat any throw as a DB
 * failure then read every value as unset: a seed saw no custom fields, no SEO
 * field overrides and no module toggles, and logged an error per read. Outside
 * Next there is no cache to use and none to keep in step, so the read runs
 * directly. Any other error, including the read's own, still throws.
 */
export function cmsCached<Args extends unknown[], T>(
  read: (...args: Args) => Promise<T>,
  keyParts: string[],
  options: { tags: string[]; revalidate?: number | false }
): (...args: Args) => Promise<T> {
  const cached = unstable_cache(read, keyParts, options);
  return async (...args: Args) => {
    try {
      return await cached(...args);
    } catch (err) {
      if (err instanceof Error && err.message.includes('incrementalCache missing'))
        return read(...args);
      throw err;
    }
  };
}
