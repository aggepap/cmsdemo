/**
 * Analytics & Marketing: the settings, and what they mean for what loads.
 *
 * A leaf with no runtime imports beyond the GA one, like `analytics.ts`: the
 * settings schema (client-safe), the public layout, the proxy's CSP and the
 * cookie declaration all read the same resolution, so none of them can
 * disagree about whether, say, the Meta Pixel is running.
 *
 * The one rule that matters most: GA4 and the Pixel load EITHER directly (by
 * the CMS) OR through GTM (by the container, which reads the IDs from the
 * dataLayer) — never both. "Via GTM" without a GTM container means direct,
 * because the alternative is a site that measures nothing.
 */
import { resolveGaId } from './analytics';

export const ANALYTICS_GTM_ID_KEY = 'analytics.gtmContainerId';
export const ANALYTICS_GA4_VIA_GTM_KEY = 'analytics.ga4ViaGtm';
export const MARKETING_META_PIXEL_ID_KEY = 'marketing.metaPixelId';
export const MARKETING_META_PIXEL_VIA_GTM_KEY = 'marketing.metaPixelViaGtm';
export const MARKETING_META_DOMAIN_VERIFICATION_KEY = 'marketing.metaDomainVerification';

/** The settings tab every field here lives in. */
export const ANALYTICS_MARKETING_GROUP = 'Analytics & Marketing';

/**
 * Allow-lists, not escape lists. Each value ends up inside an inline script or
 * a meta tag; the real formats are narrow and known. Shared by the write
 * boundary (`validate.ts`) and the readers below — a stored value that does not
 * match (written before the guard, or straight into the database) reads as unset.
 */
export const GA_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/i;
export const GTM_ID_PATTERN = /^GTM-[A-Z0-9]{4,12}$/i;
export const META_PIXEL_ID_PATTERN = /^\d{5,20}$/;
export const META_DOMAIN_VERIFICATION_PATTERN = /^[A-Za-z0-9]{10,64}$/;

export const MARKETING_SETTING_KEYS = [
  ANALYTICS_GTM_ID_KEY,
  ANALYTICS_GA4_VIA_GTM_KEY,
  MARKETING_META_PIXEL_ID_KEY,
  MARKETING_META_PIXEL_VIA_GTM_KEY,
  MARKETING_META_DOMAIN_VERIFICATION_KEY,
] as const;

export interface MarketingConfig {
  gaId: string | null;
  gtmId: string | null;
  ga4ViaGtm: boolean;
  pixelId: string | null;
  pixelViaGtm: boolean;
  metaDomainVerification: string | null;
}

function matching(raw: unknown, pattern: RegExp): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value && pattern.test(value) ? value : null;
}

/**
 * The stored settings (by key) as a typed config. GA keeps its existing
 * resolution (the setting, falling back to `NEXT_PUBLIC_GA_MEASUREMENT_ID`).
 */
export function resolveMarketingConfig(stored: Readonly<Record<string, unknown>>): MarketingConfig {
  const ga = resolveGaId(stored['analytics.gaMeasurementId']);
  return {
    gaId: GA_ID_PATTERN.test(ga) ? ga : null,
    gtmId: matching(stored[ANALYTICS_GTM_ID_KEY], GTM_ID_PATTERN)?.toUpperCase() ?? null,
    ga4ViaGtm: stored[ANALYTICS_GA4_VIA_GTM_KEY] === 'on',
    pixelId: matching(stored[MARKETING_META_PIXEL_ID_KEY], META_PIXEL_ID_PATTERN),
    pixelViaGtm: stored[MARKETING_META_PIXEL_VIA_GTM_KEY] === 'on',
    metaDomainVerification: matching(stored[MARKETING_META_DOMAIN_VERIFICATION_KEY], META_DOMAIN_VERIFICATION_PATTERN),
  };
}

export interface MarketingLoadPlan {
  /** GTM container the CMS loads, or null. */
  gtmId: string | null;
  /** GA4 ID the CMS loads with gtag.js itself, or null (unset, or GTM loads it). */
  gtagId: string | null;
  /** Pixel ID the CMS loads with fbevents.js itself, or null (unset, or GTM loads it). */
  pixelId: string | null;
  /** Pushed to the dataLayer before GTM, for the container's own tags to read — only the IDs it loads. */
  dataLayerIds: { cms_ga4_id?: string; cms_meta_pixel_id?: string };
  /** Whether the page CSP needs the Google tag hosts / the Meta hosts. */
  googleHosts: boolean;
  metaHosts: boolean;
}

export function marketingLoadPlan(config: MarketingConfig): MarketingLoadPlan {
  const gtm = config.gtmId;
  const gaThroughGtm = Boolean(gtm && config.gaId && config.ga4ViaGtm);
  const pixelThroughGtm = Boolean(gtm && config.pixelId && config.pixelViaGtm);
  const dataLayerIds: MarketingLoadPlan['dataLayerIds'] = {};
  // Only when the container is the one loading it: a container whose Google tag
  // reads `cms_ga4_id` while gtag.js runs too would count every visit twice.
  if (gaThroughGtm && config.gaId) dataLayerIds.cms_ga4_id = config.gaId;
  if (pixelThroughGtm && config.pixelId) dataLayerIds.cms_meta_pixel_id = config.pixelId;
  return {
    gtmId: gtm,
    gtagId: config.gaId && !gaThroughGtm ? config.gaId : null,
    pixelId: config.pixelId && !pixelThroughGtm ? config.pixelId : null,
    dataLayerIds,
    googleHosts: Boolean(gtm || config.gaId),
    metaHosts: Boolean(config.pixelId),
  };
}
