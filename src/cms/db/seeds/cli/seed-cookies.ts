/** Seed the default cookie catalogue. `npm run db:seed-cookies -- [--no-shop] [--no-marketing]` */
import '../../adapters/mysql/load-env';

import { cookieSeedOptions, seedCookieCatalog } from '../cookies';

async function main(): Promise<void> {
  const result = await seedCookieCatalog(cookieSeedOptions(process.argv.slice(2)));
  console.log(
    `Cookie catalogue seeded (created ${result.created}, skipped ${result.skipped}, services ${result.services}).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
