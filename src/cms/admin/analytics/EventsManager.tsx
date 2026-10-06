'use client';

import { useMemo, useState } from 'react';

import {
  ANALYTICS_PROFILES,
  ANALYTICS_TRACKING_KEY,
  EVENT_CATALOG,
  PROFILE_LABELS,
  resolveEventSwitches,
  setEventSwitch,
  type AnalyticsProfile,
  type TrackingSettings,
} from '../../core/analytics/catalog';
import { cmsApi } from '../api-client';
import { apiErrorText } from '../api-error-text';
import { Button, Section } from '../ui';

/**
 * Settings → Analytics & Marketing → Events.
 *
 * Profiles (combinable) load the default events; every event then has a GA4
 * and a Meta switch, either way, including events of a profile not chosen.
 * Events with no Meta equivalent have no Meta switch; Meta custom events start
 * off. Saved as `analytics.tracking`, overrides only.
 */
export function EventsManager({
  initial,
  suggested,
}: {
  initial: TrackingSettings;
  /** What the open modules suggest, used while no profile has been saved. */
  suggested: AnalyticsProfile[];
}) {
  const [settings, setSettings] = useState<TrackingSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profiles = settings.profiles ?? suggested;
  const switches = useMemo(() => resolveEventSwitches(settings, suggested), [settings, suggested]);

  function update(next: TrackingSettings) {
    setSettings(next);
    setSaved(false);
  }

  function toggleProfile(profile: AnalyticsProfile, on: boolean) {
    const next = new Set(profiles);
    if (on) next.add(profile);
    else next.delete(profile);
    update({ ...settings, profiles: ANALYTICS_PROFILES.filter((p) => next.has(p)) });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await cmsApi.updateSiteSettings({ [ANALYTICS_TRACKING_KEY]: { ...settings, profiles } });
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, 'Could not save the analytics events.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Profiles">
        <p className="mb-3 max-w-2xl text-sm text-neutral-600">
          A profile switches on the events that matter for that kind of site. They combine. Suggested from the
          modules that are on; the switches below can then turn any event on or off.
        </p>
        <div className="flex flex-wrap gap-6">
          {ANALYTICS_PROFILES.map((profile) => (
            <label key={profile} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-warm-gold"
                aria-label={`Profile: ${PROFILE_LABELS[profile]}`}
                checked={profiles.includes(profile)}
                onChange={(e) => toggleProfile(profile, e.target.checked)}
              />
              {PROFILE_LABELS[profile]}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Events">
        <p className="mb-3 max-w-2xl text-sm text-neutral-600">
          Every event is sent the moment the server confirms the action — never on the button click. It goes to the
          dataLayer (for Google Tag Manager) and, when they load directly, to GA4 and the Meta Pixel. &ldquo;Meta:
          custom&rdquo; events appear by themselves in Events Manager; they start off so Meta is not filled with noise.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th scope="col" className="py-2 pr-3">Event</th>
                <th scope="col" className="py-2 pr-3">When</th>
                <th scope="col" className="py-2 pr-3">Meta</th>
                <th scope="col" className="py-2 pr-3">Profiles</th>
                <th scope="col" className="py-2 pr-3 text-center">GA4</th>
                <th scope="col" className="py-2 text-center">Meta</th>
              </tr>
            </thead>
            <tbody>
              {EVENT_CATALOG.filter((e) => !e.serverOnly).map((event) => {
                const sw = switches[event.id];
                return (
                  <tr key={event.id} className="border-b border-neutral-100 align-top">
                    <th scope="row" className="py-2 pr-3 font-mono text-xs font-normal">
                      {event.ga4}
                      {event.ga4 !== event.id ? <span className="block text-neutral-500">{event.id}</span> : null}
                    </th>
                    <td className="py-2 pr-3 text-neutral-600">{event.when}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {event.meta ? (event.meta.standard ? `Meta: ${event.meta.name}` : 'Meta: custom') : '—'}
                    </td>
                    <td className="py-2 pr-3 text-xs text-neutral-500">
                      {event.profiles.map((p) => PROFILE_LABELS[p]).join(' · ')}
                    </td>
                    <td className="py-2 pr-3 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-warm-gold"
                        aria-label={`GA4: ${event.id}`}
                        checked={sw.ga4}
                        onChange={(e) => update(setEventSwitch(settings, suggested, event.id, 'ga4', e.target.checked))}
                      />
                    </td>
                    <td className="py-2 text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-warm-gold"
                        aria-label={`Meta: ${event.id}`}
                        checked={sw.meta}
                        disabled={event.meta === null}
                        onChange={(e) => update(setEventSwitch(settings, suggested, event.id, 'meta', e.target.checked))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Sent with every event: page_location, page_title, page_type, language. Never sent: email, name, phone or
          address.
        </p>
      </Section>

      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-green-700">
          Saved.
        </p>
      ) : null}
      <div>
        <Button type="button" onClick={() => void save()} disabled={saving}>
          Save events
        </Button>
      </div>
    </div>
  );
}
