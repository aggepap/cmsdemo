import { sitemapRoutes } from '@/app/sitemap';
import { SeoManager } from '@/cms/admin';
import { list404, listMeta, listRedirects } from '@/cms/core/seo/service';
import { getLocaleSettings } from '@/lib/i18n/locale-settings';
import { PERMISSIONS, requirePerm } from '@/cms/modules/auth';

export default async function SeoPage() {
  await requirePerm(PERMISSIONS.seoRead);
  const [redirects, notFounds, metas, locales] = await Promise.all([
    listRedirects(),
    list404(),
    listMeta(),
    getLocaleSettings(),
  ]);
  // The live pages a redirect target is suggested from — the sitemap's own list.
  const { routes } = await sitemapRoutes(locales.public);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-neutral-900">SEO</h1>
      <SeoManager
        redirects={JSON.parse(JSON.stringify(redirects))}
        notFounds={JSON.parse(JSON.stringify(notFounds))}
        metas={JSON.parse(JSON.stringify(metas))}
        knownPaths={routes}
        mainLocale={locales.main}
        localePrefixes={locales.public.filter((l) => l !== locales.main)}
      />
    </div>
  );
}
