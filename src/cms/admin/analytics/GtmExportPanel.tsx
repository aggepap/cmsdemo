'use client';

import { useState } from 'react';

import { GOOGLE_ADS_KEY, type GoogleAdsSettings } from '../../core/analytics/google-ads';
import { cmsApi } from '../api-client';
import { apiErrorText } from '../api-error-text';
import { Button, Field, Section, TextInput } from '../ui';

/**
 * Settings → Analytics & Marketing → GTM export.
 *
 * Downloads the container built from this site's settings (`gtm-export.ts`),
 * keeps the Google Ads conversion labels it needs, and says how to import it
 * without duplicating anything — and what a re-import will not remove.
 */
export function GtmExportPanel({
  gtmId,
  googleAds,
  labelEvents,
  stale,
}: {
  /** The container ID, or null when none is set (no download then). */
  gtmId: string | null;
  googleAds: GoogleAdsSettings;
  /** Active events that can carry a conversion label (catalogue ids and custom names). */
  labelEvents: string[];
  /** In the last download, not in the next one: to delete in GTM by hand. */
  stale: string[];
}) {
  const [ads, setAds] = useState<GoogleAdsSettings>(googleAds);
  const [busy, setBusy] = useState<'save' | 'download' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveAds() {
    setBusy('save');
    setMessage(null);
    try {
      const labels = Object.fromEntries(Object.entries(ads.labels).filter(([, v]) => v.trim()));
      await cmsApi.updateSiteSettings({
        [GOOGLE_ADS_KEY]: { ...(ads.conversionId?.trim() ? { conversionId: ads.conversionId.trim() } : {}), labels },
      });
      setMessage({ ok: true, text: 'Saved. Download the settings again for GTM to get them.' });
    } catch (err) {
      setMessage({ ok: false, text: apiErrorText(err, 'Could not save the Google Ads settings.') });
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    if (!gtmId) return;
    setBusy('download');
    setMessage(null);
    try {
      const blob = await cmsApi.downloadGtmContainer();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gtm-${gtmId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage({ ok: false, text: apiErrorText(err, 'Could not build the GTM settings.') });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Google Tag Manager settings (JSON)">
        {gtmId ? (
          <>
            <p className="mb-3 max-w-2xl text-sm text-neutral-600">
              Built from the profile, the active events and their switches, the custom events and the IDs above, for
              container <span className="font-mono">{gtmId}</span>. Tags for GA4 and the Meta Pixel are only included
              when they are set to load through GTM — never both, so nothing is counted twice.
            </p>
            <Button type="button" onClick={() => void download()} disabled={busy !== null}>
              Download GTM settings (JSON)
            </Button>
          </>
        ) : (
          <p className="text-sm text-neutral-700">
            Set the Google Tag Manager container ID in the General tab first.
          </p>
        )}
      </Section>

      {stale.length > 0 ? (
        <Section title="Delete these in GTM by hand">
          <p className="mb-2 max-w-2xl text-sm text-neutral-600">
            The last download had them and the next one will not (an event was switched off or removed). An import never
            deletes anything, so remove them in GTM yourself.
          </p>
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {stale.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Google Ads conversions">
        <p className="mb-3 max-w-2xl text-sm text-neutral-600">
          Optional. For each event that should count as a conversion in Google Ads, the Conversion Label (Google Ads →
          Goals → Conversions → the action → Tag setup: the part after the slash in send_to). The export then adds a
          Conversion tag per labelled event and the Conversion Linker.
        </p>
        <div className="grid max-w-2xl gap-3">
          <Field label="Conversion ID">
            <TextInput
              value={ads.conversionId ?? ''}
              placeholder="AW-123456789"
              onChange={(e) => setAds({ ...ads, conversionId: e.target.value })}
            />
          </Field>
          {labelEvents.map((id) => (
            <div key={id} className="grid grid-cols-[minmax(0,12rem)_1fr] items-center gap-3">
              <span className="font-mono text-xs">{id}</span>
              <TextInput
                aria-label={`Conversion label: ${id}`}
                value={ads.labels[id] ?? ''}
                placeholder="Conversion label"
                onChange={(e) => setAds({ ...ads, labels: { ...ads.labels, [id]: e.target.value } })}
              />
            </div>
          ))}
        </div>
        <Button type="button" variant="secondary" className="mt-4" onClick={() => void saveAds()} disabled={busy !== null}>
          Save Google Ads settings
        </Button>
      </Section>

      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-green-700' : 'text-sm text-red-700'}>
          {message.text}
        </p>
      ) : null}

      <Section title="How to import it into GTM">
        <ol className="flex max-w-2xl list-decimal flex-col gap-1 pl-5 text-sm text-neutral-700">
          <li>GTM → Admin → Import Container → choose the file.</li>
          <li>Workspace: your existing one (or a new one).</li>
          <li>
            Import option: <strong>Merge</strong> → <strong>Overwrite conflicting tags, triggers and variables</strong>.
            Never &ldquo;Rename&rdquo; — it makes duplicates.
          </li>
          <li>Preview (Tag Assistant), check the events fire, then Publish.</li>
        </ol>
        <ul className="mt-3 flex max-w-2xl list-disc flex-col gap-1 pl-5 text-sm text-neutral-600">
          <li>
            Everything named <span className="font-mono">CMS · …</span> belongs to the CMS: do not edit it — the next
            import puts it back. For a variation, copy it under your own name.
          </li>
          <li>Anything of yours with another name is never touched.</li>
          <li>An event switched off is not deleted by an import; it is listed above, to delete by hand.</li>
        </ul>
      </Section>
    </div>
  );
}
