/**
 * Default cookie-catalogue seed.
 *
 * A fresh install had an empty `cookie_categories` table and nothing to fill it:
 * the banner offered no categories, `/legal/cookies` rendered no declaration,
 * and the only route to one was an admin knowing to go and type it. This puts a
 * defensible starting point in place.
 *
 * Non-destructive, like `seedRoles` for every role but `superadmin` (which the
 * code re-syncs to `*`); this table is copy that an admin edits, so a category whose key already
 * exists is left exactly as it is — a seeder that updated in place would revert
 * their wording on the next deploy, silently.
 */
import {
  defaultCookieCategories,
  type CookieCatalogOptions,
  type DefaultCookieCategory,
} from '../../core/cookies/defaults';
import { adapter } from '../index';
import { getMysqlDb } from '../adapters/mysql/client';
import { cookieCategories, cookieServices } from '../adapters/mysql/schema';

/** The defaults not yet present, matched on the exact key (the unique column). */
export function pendingCategories(
  existingKeys: readonly string[],
  options: CookieCatalogOptions = {},
): DefaultCookieCategory[] {
  const have = new Set(existingKeys);
  return defaultCookieCategories(options).filter((c) => !have.has(c.key));
}

const SEED_FLAGS: Record<string, keyof CookieCatalogOptions> = { '--no-shop': 'shop', '--no-marketing': 'marketing' };

/**
 * `npm run db:seed-cookies -- [--no-shop] [--no-marketing]`. An unknown flag is
 * refused: a typo would otherwise seed exactly the copy it was meant to prevent.
 */
export function cookieSeedOptions(argv: readonly string[]): Required<CookieCatalogOptions> {
  const options = { shop: true, marketing: true };
  for (const arg of argv) {
    const key = SEED_FLAGS[arg];
    if (!key) throw new Error(`Unknown option ${arg}. Usage: db:seed-cookies -- [--no-shop] [--no-marketing]`);
    options[key] = false;
  }
  return options;
}

export interface CookieSeedResult {
  created: number;
  skipped: number;
  services: number;
}

export async function seedCookieCatalog(
  options: CookieCatalogOptions = {},
  db: ReturnType<typeof getMysqlDb> = getMysqlDb(),
): Promise<CookieSeedResult> {
  const existing = await db.select({ key: cookieCategories.key }).from(cookieCategories);
  const pending = pendingCategories(
    existing.map((r) => r.key),
    options,
  );

  let services = 0;
  for (const category of pending) {
    const res = await db.insert(cookieCategories).values({
      key: category.key,
      name: category.name,
      description: category.description,
      required: category.required,
      sortOrder: category.sortOrder,
    });
    const categoryId = adapter.insertId(res);
    // Only alongside a category this run created: attaching them to a category
    // that was already there would add rows an admin had chosen to remove.
    for (const service of category.services) {
      await db.insert(cookieServices).values({
        categoryId,
        name: service.name,
        provider: service.provider,
        purpose: service.purpose,
        enabled: true,
      });
      services += 1;
    }
  }

  return {
    created: pending.length,
    skipped: defaultCookieCategories(options).length - pending.length,
    services,
  };
}
