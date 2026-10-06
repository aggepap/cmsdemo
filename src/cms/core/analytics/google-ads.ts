/**
 * Google Ads conversion settings (REQ-5 §1, §5): a conversion ID and one label
 * per event that should count as a conversion. They only ever reach the site
 * through the exported GTM container (`gtm-export.ts`) — Ads runs through GTM.
 *
 * Plain data, client-safe.
 */
import { z } from 'zod';

export const GOOGLE_ADS_KEY = 'marketing.googleAds';

/** The events offered for a label by default; any active event can have one. */
export const DEFAULT_ADS_CONVERSION_EVENTS = ['generate_lead', 'purchase'] as const;

export const googleAdsSchema = z
  .object({
    conversionId: z
      .string()
      .trim()
      .regex(/^AW-\d{6,15}$/, 'looks like AW-123456789')
      .optional(),
    labels: z.record(
      z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
      z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/, 'is the label after the slash in send_to (letters, digits, - and _)'),
    ),
  })
  .strict();

export type GoogleAdsSettings = z.infer<typeof googleAdsSchema>;

export function readGoogleAds(raw: unknown): GoogleAdsSettings {
  const parsed = googleAdsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { labels: {} };
}
