/**
 * Which target locale each source locale lands in.
 *
 * A package carries the source site's languages; the target may have fewer, or
 * others. A value stored under a locale the target does not have is not
 * harmless: localized maps are validated per locale, so it would fail the write.
 * `null` means "drop this language".
 */
export type LocaleMap = Readonly<Record<string, string | null>>;

/** Keep every language both sites have; drop the rest. */
export function defaultLocaleMap(source: readonly string[], target: readonly string[]): LocaleMap {
  const out: Record<string, string | null> = {};
  for (const locale of source) out[locale] = target.includes(locale) ? locale : null;
  return out;
}

export function mapLocale(map: LocaleMap, locale: string): string | null {
  return map[locale] ?? null;
}

/**
 * A `{ [locale]: value }` map re-keyed through `map`. When two source locales
 * land on the same target locale, the first one in the value wins: silently
 * preferring the last would depend on key order nobody chose.
 */
export function mapLocalizedValue(
  value: Readonly<Record<string, unknown>>,
  map: LocaleMap
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [locale, v] of Object.entries(value)) {
    const to = mapLocale(map, locale);
    if (to !== null && !(to in out)) out[to] = v;
  }
  return out;
}

/**
 * Why `map` cannot be used, or null. Two package languages landing on one site
 * language is refused: both rows of a document would claim the same language
 * of one translation group, and one would silently overwrite the other.
 */
export function localeMapProblem(
  map: LocaleMap,
  source: readonly string[],
  target: readonly string[]
): string | null {
  const seen = new Map<string, string>();
  for (const [from, to] of Object.entries(map)) {
    if (!source.includes(from)) return `The package has no language "${from}".`;
    if (to === null) continue;
    if (!target.includes(to)) return `This site has no language "${to}".`;
    const other = seen.get(to);
    if (other)
      return `"${other}" and "${from}" both go to "${to}"; choose one and leave the other out.`;
    seen.set(to, from);
  }
  return null;
}
