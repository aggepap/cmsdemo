import 'server-only';

import type { CmsConfig } from '../../config';
import { PERMISSIONS, requireApiPerm } from '../../modules/auth';
import { CUSTOM_EVENTS_KEY, readCustomEvents } from '../analytics/custom-events';
import { GOOGLE_ADS_KEY, readGoogleAds } from '../analytics/google-ads';
import { buildGtmContainer, gtmEntityNames, GTM_LAST_EXPORT_KEY } from '../analytics/gtm-export';
import { createRoute } from '../api/handler';
import { badRequest } from '../errors';
import { getSetting, isModuleEnabled, setSetting } from '../settings';
import { getEventSwitches, getMarketingConfig } from '../settings/marketing-read';

/**
 * POST /api/cms/analytics/gtm-export — the container JSON to import into GTM
 * (Settings → Analytics & Marketing → GTM export).
 *
 * POST and `settings.write`, not GET: it records what was exported, so the next
 * download can list the entities an import will not remove by itself.
 */
export function gtmExportRoute(config: CmsConfig) {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.settingsWrite),
    handler: async ({ auth }) => {
      const marketing = await getMarketingConfig();
      if (!marketing.gtmId) throw badRequest('Set the Google Tag Manager container ID first.');
      const [commerce, booking, customEvents, googleAds] = await Promise.all([
        isModuleEnabled(config, 'commerce'),
        isModuleEnabled(config, 'booking'),
        getSetting(CUSTOM_EVENTS_KEY),
        getSetting(GOOGLE_ADS_KEY),
      ]);
      const container = buildGtmContainer({
        gtmId: marketing.gtmId,
        ga4ViaGtm: Boolean(marketing.gaId && marketing.ga4ViaGtm),
        pixelViaGtm: marketing.pixelViaGtm,
        pixelId: marketing.pixelId,
        switches: await getEventSwitches({ commerce, booking }),
        customEvents: readCustomEvents(customEvents),
        googleAds: readGoogleAds(googleAds),
        exportTime: new Date(),
      });
      await setSetting(GTM_LAST_EXPORT_KEY, gtmEntityNames(container), auth.userId);
      return new Response(JSON.stringify(container, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="gtm-${marketing.gtmId}.json"`,
          'Cache-Control': 'no-store',
        },
      });
    },
  });
}
