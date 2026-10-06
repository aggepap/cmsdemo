/**
 * Google Consent Mode v2 and Meta consent, from the banner's two categories.
 *
 * "Analytics" (Στατιστικά) → `analytics_storage`.
 * "Marketing" (Μάρκετινγκ) → `ad_storage`, `ad_user_data`, `ad_personalization`,
 * and the Meta Pixel / Conversions API.
 *
 * Pure: the loader applies these, the tests read them.
 */

export type ConsentSignal = 'granted' | 'denied';

export interface GoogleConsentState {
  analytics_storage: ConsentSignal;
  ad_storage: ConsentSignal;
  ad_user_data: ConsentSignal;
  ad_personalization: ConsentSignal;
}

export interface MarketingConsent {
  analytics: boolean;
  marketing: boolean;
}

/** What `gtag('consent', 'default', …)` is told before any Google tag runs. */
export const CONSENT_DEFAULT: Readonly<GoogleConsentState & { wait_for_update: number }> = {
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  wait_for_update: 500,
};

export function googleConsentState({ analytics, marketing }: MarketingConsent): GoogleConsentState {
  const ads: ConsentSignal = marketing ? 'granted' : 'denied';
  return {
    analytics_storage: analytics ? 'granted' : 'denied',
    ad_storage: ads,
    ad_user_data: ads,
    ad_personalization: ads,
  };
}

/** `fbq('consent', …)`. */
export function metaConsentAction(marketing: boolean): 'grant' | 'revoke' {
  return marketing ? 'grant' : 'revoke';
}
