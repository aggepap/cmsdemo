'use client';

import { useState } from 'react';

import type { CapiQueueSummary } from '../../core/analytics/capi-queue';
import { COMMON_EVENT_PARAMS, EVENT_CATALOG, type EventSwitches } from '../../core/analytics/catalog';
import { TRIGGER_PARAMS, type CustomEvent } from '../../core/analytics/custom-events';
import { CAPI_EVENT_OPTIONS, META_CAPI_KEY, type MetaCapiSettings } from '../../core/analytics/meta-capi-settings';
import type { MarketingConfig } from '../../core/settings/marketing';
import { cmsApi } from '../api-client';
import { apiErrorText } from '../api-error-text';
import { Button, Field, Section, TextInput } from '../ui';

/**
 * Settings → Analytics & Marketing → Status.
 *
 * What each provider does on the public site, the events the site sends (with
 * example parameters, for setting up GA4, GTM and Meta), the Conversions API —
 * its events, Test Event Code, token and queue — how to watch it all happen,
 * and the privacy-policy text the server-side sends call for.
 */

export type ProviderState = 'off' | 'waits_consent' | 'via_gtm';

export interface ProviderStatus {
  provider: string;
  state: ProviderState;
  detail: string;
}

/** What each provider does on the public site, from the settings alone. */
export function providerStatuses(config: MarketingConfig, env: { production: boolean }): ProviderStatus[] {
  const off = (provider: string, detail: string): ProviderStatus => ({ provider, state: 'off', detail });
  const notLive = 'Only a production build on the production domain loads tags.';
  const gtm = config.gtmId;
  return [
    !gtm
      ? off('Google Tag Manager', 'No container ID.')
      : !env.production
        ? off('Google Tag Manager', notLive)
        : { provider: 'Google Tag Manager', state: 'waits_consent', detail: `${gtm}, once the visitor accepts Analytics or Marketing.` },
    !config.gaId
      ? off('GA4', 'No Measurement ID.')
      : !env.production
        ? off('GA4', notLive)
        : gtm && config.ga4ViaGtm
          ? { provider: 'GA4', state: 'via_gtm', detail: `${config.gaId}, by your GTM container (cms_ga4_id).` }
          : { provider: 'GA4', state: 'waits_consent', detail: `${config.gaId}, once the visitor accepts Analytics.` },
    !config.pixelId
      ? off('Meta Pixel', 'No Pixel ID.')
      : !env.production
        ? off('Meta Pixel', notLive)
        : gtm && config.pixelViaGtm
          ? { provider: 'Meta Pixel', state: 'via_gtm', detail: `${config.pixelId}, by your GTM container (cms_meta_pixel_id).` }
          : { provider: 'Meta Pixel', state: 'waits_consent', detail: `${config.pixelId}, once the visitor accepts Marketing.` },
  ];
}

const STATE_LABEL: Record<ProviderState, string> = {
  off: 'Does not load',
  waits_consent: 'Loads after consent',
  via_gtm: 'Loads through GTM (after consent)',
};

const EXAMPLE_VALUES: Record<string, unknown> = {
  page_location: 'https://example.gr/contact',
  page_title: 'Contact',
  page_type: 'page',
  language: 'el',
  search_term: 'mug',
  content_type: 'blog',
  content_id: 'my-article',
  form_id: 'contact',
  form_name: 'Contact',
  link_url: 'tel:+302101234567',
  file_name: 'menu.pdf',
  file_extension: 'pdf',
  method: 'email',
  item_list_id: 'category:cups',
  items: [{ item_id: 'MUG-1', item_name: 'Mug', price: 12.5, quantity: 1 }],
  value: 12.5,
  currency: 'EUR',
  shipping_tier: '3',
  payment_type: 'bank_transfer',
  coupon: 'WELCOME10',
  transaction_id: 'ORD-2026-AB12CD',
  tax: 2.42,
  shipping: 3.5,
  element_id: 'virtual-tour',
  element_text: 'Open the tour',
  video_title: 'Our shop',
  video_url: 'https://youtu.be/…',
  video_provider: 'youtube',
  page_path: '/pricing',
  section_id: 'faq',
};

export interface EventExample {
  id: string;
  name: string;
  destinations: string;
  example: Record<string, unknown>;
}

/** The active events, each with example parameters as the dataLayer receives them. */
export function eventExamples(switches: EventSwitches, customEvents: readonly CustomEvent[]): EventExample[] {
  const example = (params: readonly string[], fixed: Record<string, string> = {}) => ({
    ...Object.fromEntries([...COMMON_EVENT_PARAMS, ...params].map((p) => [p, EXAMPLE_VALUES[p] ?? '…'])),
    ...fixed,
  });
  const dest = (ga4: boolean, meta: string | null) => [ga4 ? 'GA4' : null, meta].filter(Boolean).join(' · ');
  return [
    ...EVENT_CATALOG.filter((e) => !e.serverOnly && (switches[e.id]?.ga4 || switches[e.id]?.meta)).map((e) => ({
      id: e.id,
      name: e.ga4,
      destinations: dest(switches[e.id].ga4, switches[e.id].meta && e.meta ? `Meta: ${e.meta.name}` : null),
      example: example(e.params, { ...(e.fixed ?? {}) }),
    })),
    ...customEvents
      .filter((c) => c.ga4 || c.meta)
      .map((c) => ({
        id: c.name,
        name: c.name,
        destinations: dest(c.ga4, c.meta ? 'Meta: custom' : null),
        example: example(TRIGGER_PARAMS[c.trigger.type], Object.fromEntries(c.params.map((p) => [p.key, p.value]))),
      })),
  ];
}

const PRIVACY_TEXT = {
  el: 'Όταν έχετε αποδεχθεί τα cookies Μάρκετινγκ, ο διακομιστής μας στέλνει στη Meta Platforms (Facebook/Instagram) πληροφορίες για ενέργειες όπως μια αγορά, ένα αίτημα ή μια εγγραφή, ώστε να μετράμε την απόδοση των διαφημίσεών μας. Το email και το τηλέφωνό σας αποστέλλονται μόνο κρυπτογραφημένα (hash SHA-256), μαζί με τη διεύθυνση IP, τον τύπο του προγράμματος περιήγησης και τα cookies _fbp/_fbc. Χωρίς τη συγκατάθεσή σας δεν αποστέλλεται τίποτα. Μπορείτε να την ανακαλέσετε οποτεδήποτε από τις ρυθμίσεις cookies.',
  en: 'When you have accepted Marketing cookies, our server sends Meta Platforms (Facebook/Instagram) information about actions such as a purchase, an enquiry or a registration, so we can measure how our ads perform. Your email and phone number are only sent encrypted (SHA-256 hash), together with your IP address, browser type and the _fbp/_fbc cookies. Without your consent nothing is sent. You can withdraw it at any time from the cookie settings.',
};

export function AnalyticsStatusPanel({
  config,
  production,
  switches,
  customEvents,
  capi,
  capiTokenSet,
  queue,
}: {
  config: MarketingConfig;
  production: boolean;
  switches: EventSwitches;
  customEvents: readonly CustomEvent[];
  capi: MetaCapiSettings;
  capiTokenSet: boolean;
  queue: CapiQueueSummary;
}) {
  const [settings, setSettings] = useState<MetaCapiSettings>(capi);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const statuses = providerStatuses(config, { production });
  const examples = eventExamples(switches, customEvents);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await cmsApi.updateSiteSettings({
        [META_CAPI_KEY]: { events: settings.events, ...(settings.testEventCode?.trim() ? { testEventCode: settings.testEventCode.trim() } : {}) },
      });
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: apiErrorText(err, 'Could not save the Conversions API settings.') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="On the public site">
        <ul className="flex max-w-2xl flex-col gap-2 text-sm">
          {statuses.map((s) => (
            <li key={s.provider} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{s.provider}</span>
              <span className={s.state === 'off' ? 'text-neutral-500' : 'text-green-700'}>{STATE_LABEL[s.state]}</span>
              <span className="text-neutral-500">— {s.detail}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Meta Conversions API (server)">
        <p className="mb-3 max-w-2xl text-sm text-neutral-600">
          The chosen events are also sent from the server at the moment of confirmation, with the same event id as the
          Pixel so Meta counts them once. Email and phone go only hashed (SHA-256); with no Marketing consent nothing
          is sent.
        </p>
        <p className={capiTokenSet ? 'mb-3 text-sm text-green-700' : 'mb-3 text-sm text-red-700'}>
          {capiTokenSet
            ? 'Access token: set on the server.'
            : 'Access token: not set. Add META_CAPI_ACCESS_TOKEN to the server .env (Events Manager → Settings → Conversions API). It is never stored here.'}
        </p>
        <fieldset className="flex max-w-2xl flex-wrap gap-x-6 gap-y-2 text-sm">
          <legend className="mb-1 text-sm font-medium">Events sent from the server</legend>
          {CAPI_EVENT_OPTIONS.map((name) => (
            <label key={name} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-warm-gold"
                aria-label={`Conversions API: ${name}`}
                checked={settings.events.includes(name)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    events: e.target.checked ? [...settings.events, name] : settings.events.filter((x) => x !== name),
                  })
                }
              />
              {name}
            </label>
          ))}
        </fieldset>
        <div className="mt-3 max-w-sm">
          <Field label="Test Event Code" description="From Events Manager → Test events. While set, server events show up there. Clear it when done.">
            <TextInput value={settings.testEventCode ?? ''} placeholder="TEST12345" onChange={(e) => setSettings({ ...settings, testEventCode: e.target.value })} />
          </Field>
        </div>
        <Button type="button" variant="secondary" className="mt-3" onClick={() => void save()} disabled={saving}>
          Save Conversions API settings
        </Button>
        {message ? (
          <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'mt-2 text-sm text-green-700' : 'mt-2 text-sm text-red-700'}>
            {message.text}
          </p>
        ) : null}

        <h3 className="mt-5 text-sm font-semibold">Queue</h3>
        <p className="text-sm text-neutral-700">
          Sent: {queue.counts.sent} · Waiting to retry: {queue.counts.pending} · Failed: {queue.counts.failed}
        </p>
        {queue.recentFailures.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-red-800">
            {queue.recentFailures.map((f) => (
              <li key={`${f.eventName}:${f.eventId}`}>
                {f.eventName} {f.eventId} — {f.attempts} attempts — {f.lastError ?? 'unknown error'}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Events the site sends">
        {examples.length === 0 ? (
          <p className="text-sm text-neutral-600">No event is switched on.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {examples.map((e) => (
              <li key={e.id}>
                <p className="text-sm">
                  <span className="font-mono">{e.name}</span>
                  {e.name !== e.id ? <span className="text-neutral-500"> ({e.id})</span> : null}
                  <span className="text-neutral-500"> → {e.destinations || 'dataLayer only'}</span>
                </p>
                <pre className="mt-1 overflow-x-auto rounded-sm bg-neutral-50 p-2 text-xs">{JSON.stringify(e.example, null, 2)}</pre>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Checking it works">
        <ul className="flex max-w-2xl list-disc flex-col gap-1 pl-5 text-sm text-neutral-700">
          <li>
            Signed in to this admin, open the site: every event is written to the browser console as{' '}
            <span className="font-mono">[cms analytics]</span>, with what was sent where. Visitors never see this.
          </li>
          <li>GTM: Preview (Tag Assistant), accept the cookies, and watch the CMS · tags fire on each event.</li>
          <li>GA4: Reports → Realtime, or Admin → DebugView while Tag Assistant is connected.</li>
          <li>Meta: Events Manager → Test events (browser), and with the Test Event Code above for the server.</li>
        </ul>
      </Section>

      <Section title="Privacy policy: text to add">
        <p className="mb-2 max-w-2xl text-sm text-neutral-600">
          With the Conversions API in use, the privacy policy should say so. A suggestion:
        </p>
        <p className="max-w-2xl rounded-sm bg-neutral-50 p-3 text-sm" lang="el">
          {PRIVACY_TEXT.el}
        </p>
        <p className="mt-2 max-w-2xl rounded-sm bg-neutral-50 p-3 text-sm" lang="en">
          {PRIVACY_TEXT.en}
        </p>
      </Section>
    </div>
  );
}
