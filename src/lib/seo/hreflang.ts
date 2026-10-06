/**
 * The hreflang alternates for one page: every public locale plus `x-default`
 * (English while it is public, else the main locale), or `undefined` when there
 * is only one language. An alternate set with nothing to alternate to is noise
 * (F-011). Shared by page metadata and the sitemap so the two always agree.
 */
export function hreflangLanguages(
  publicLocales: readonly string[],
  main: string,
  urlFor: (locale: string) => string
): Record<string, string> | undefined {
  if (publicLocales.length < 2) return undefined;
  const languages: Record<string, string> = {};
  for (const l of publicLocales) languages[l] = urlFor(l);
  languages['x-default'] = urlFor(publicLocales.includes('en') ? 'en' : main);
  return languages;
}
