/**
 * The Analytics & Marketing settings, read and resolved.
 *
 * NOT `server-only`: the proxy imports it to build the page CSP (it runs on the
 * Node runtime, as the redirect resolver does). `getSettings` is cached and
 * tag-invalidated on every settings write, and fails open — an unreachable
 * database reads as "nothing configured", which loads no tag and adds no host.
 */
import {
  ANALYTICS_TRACKING_KEY,
  readTrackingSettings,
  resolveEventSwitches,
  suggestProfiles,
  type EventSwitches,
} from '../analytics/catalog';
import { CUSTOM_EVENTS_KEY, readCustomEvents, type CustomEvent } from '../analytics/custom-events';
import { getSetting, getSettings } from './index';
import { ANALYTICS_GA_ID_KEY } from './analytics';
import { MARKETING_SETTING_KEYS, resolveMarketingConfig, type MarketingConfig } from './marketing';

export async function getMarketingConfig(): Promise<MarketingConfig> {
  const stored = await getSettings([ANALYTICS_GA_ID_KEY, ...MARKETING_SETTING_KEYS]);
  return resolveMarketingConfig(stored);
}

/**
 * Every event's GA4 / Meta switch: the chosen profiles (or, when none were
 * chosen, the ones the open modules suggest), then the admin's overrides.
 */
export async function getEventSwitches(modules: { commerce: boolean; booking: boolean }): Promise<EventSwitches> {
  const stored = readTrackingSettings(await getSetting(ANALYTICS_TRACKING_KEY));
  return resolveEventSwitches(stored, suggestProfiles(modules));
}

/** Settings → Analytics & Marketing → Custom events; malformed reads as none. */
export async function getCustomEvents(): Promise<CustomEvent[]> {
  return readCustomEvents(await getSetting(CUSTOM_EVENTS_KEY));
}
