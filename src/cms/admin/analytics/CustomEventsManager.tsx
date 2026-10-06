'use client';

import { useState } from 'react';

import {
  CUSTOM_EVENTS_KEY,
  MAX_CUSTOM_PARAMS,
  customEventSchema,
  customParamsToDeclare,
  type CustomEvent,
  type CustomTrigger,
  type TriggerType,
} from '../../core/analytics/custom-events';
import { cmsApi } from '../api-client';
import { apiErrorText } from '../api-error-text';
import { Button, Field, Section, Select, TextInput } from '../ui';

/**
 * Settings → Analytics & Marketing → Custom events.
 *
 * The admin names an event, says when it fires, adds up to five fixed
 * parameters and flips GA4 / Meta. Meta receives them with `trackCustom`; they
 * show up in Events Manager on their own, nothing is created there first. The
 * guide below the table is the "i" REQ-5 asks for: what each use needs, in
 * both tools, and which parameters to declare in GA4.
 */

export function triggerSummary(trigger: CustomTrigger): string {
  switch (trigger.type) {
    case 'click':
      return /^[#.]/.test(trigger.selector) ? `Click on ${trigger.selector}` : `Click on [data-track="${trigger.selector}"]`;
    case 'download':
      return `Download of ${trigger.extensions.map((e) => `.${e}`).join(', ')}`;
    case 'video':
      return 'A [video] block is opened';
    case 'view':
      return trigger.path ? `Page ${trigger.path} is opened` : `Section #${trigger.sectionId ?? ''} is shown`;
    case 'form':
      return `Form ${trigger.formId} is sent`;
  }
}

const TRIGGER_LABELS: Record<TriggerType, string> = {
  click: 'Click on an element',
  download: 'File download',
  video: 'Video block opened',
  view: 'Page or section shown',
  form: 'Form sent',
};

interface Draft {
  name: string;
  type: TriggerType;
  /** The one text field the trigger needs: selector, extensions, path or #section, form id. */
  target: string;
  params: { key: string; value: string }[];
  ga4: boolean;
  meta: boolean;
}

const EMPTY_DRAFT: Draft = { name: '', type: 'click', target: '', params: [], ga4: true, meta: false };

function draftTrigger(d: Draft): unknown {
  const target = d.target.trim();
  switch (d.type) {
    case 'click':
      return { type: 'click', selector: target };
    case 'download':
      return { type: 'download', extensions: target.split(/[\s,]+/).map((e) => e.replace(/^\./, '')).filter(Boolean) };
    case 'video':
      return { type: 'video' };
    case 'view':
      return target.startsWith('#') ? { type: 'view', sectionId: target.slice(1) } : { type: 'view', path: target };
    case 'form':
      return { type: 'form', formId: target };
  }
}

const TARGET_HINTS: Record<TriggerType, { label: string; placeholder: string } | null> = {
  click: { label: 'data-track value, #id or .class', placeholder: 'virtual-tour' },
  download: { label: 'File extensions', placeholder: 'pdf, zip' },
  video: null,
  view: { label: 'Path (exact, or ending in /*) or #section-id', placeholder: '/pricing' },
  form: { label: 'form_id', placeholder: 'quote_request' },
};

export function CustomEventsManager({ initial }: { initial: CustomEvent[] }) {
  const [events, setEvents] = useState<CustomEvent[]>(initial);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addDraft() {
    const parsed = customEventSchema.safeParse({
      name: draft.name.trim(),
      trigger: draftTrigger(draft),
      params: draft.params.filter((p) => p.key.trim() || p.value.trim()),
      ga4: draft.ga4,
      meta: draft.meta,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setDraftError(`${issue.path.join('.') || 'Event'}: ${issue.message}`);
      return;
    }
    if (events.some((e) => e.name === parsed.data.name)) {
      setDraftError(`An event called ${parsed.data.name} already exists.`);
      return;
    }
    setEvents([...events, parsed.data]);
    setDraft(EMPTY_DRAFT);
    setDraftError(null);
    setSaved(false);
  }

  function remove(name: string) {
    setEvents(events.filter((e) => e.name !== name));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await cmsApi.updateSiteSettings({ [CUSTOM_EVENTS_KEY]: events });
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, 'Could not save the custom events.'));
    } finally {
      setSaving(false);
    }
  }

  const hint = TARGET_HINTS[draft.type];

  return (
    <div className="flex flex-col gap-6">
      <Section title="Custom events">
        {events.length === 0 ? (
          <p className="text-sm text-neutral-600">No custom events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th scope="col" className="py-2 pr-3">Event</th>
                  <th scope="col" className="py-2 pr-3">When</th>
                  <th scope="col" className="py-2 pr-3">Fixed parameters</th>
                  <th scope="col" className="py-2 pr-3">Sent to</th>
                  <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.name} className="border-b border-neutral-100 align-top">
                    <th scope="row" className="py-2 pr-3 font-mono text-xs font-normal">{event.name}</th>
                    <td className="py-2 pr-3">{triggerSummary(event.trigger)}</td>
                    <td className="py-2 pr-3 text-xs">
                      {event.params.length === 0 ? '—' : event.params.map((p) => `${p.key} = ${p.value}`).join(', ')}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {[event.ga4 ? 'GA4' : null, event.meta ? 'Meta (custom)' : null].filter(Boolean).join(' · ') || 'Nowhere (off)'}
                    </td>
                    <td className="py-2 text-right">
                      <Button type="button" variant="ghost" size="sm" onClick={() => remove(event.name)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Add a custom event">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          <Field label="Name" description="snake_case, for example virtual_tour_open. At most 40 characters.">
            <TextInput value={draft.name} placeholder="virtual_tour_open" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="When it fires">
            <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as TriggerType, target: '' })}>
              {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {hint ? (
            <Field label={hint.label} description={draft.type === 'click' ? 'In the site code: <a data-track="virtual-tour">…</a>' : undefined}>
              <TextInput value={draft.target} placeholder={hint.placeholder} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
            </Field>
          ) : null}
        </div>

        <fieldset className="mt-4 max-w-3xl">
          <legend className="text-sm font-medium text-neutral-800">
            Fixed parameters (up to {MAX_CUSTOM_PARAMS})
          </legend>
          {draft.params.map((p, i) => (
            <div key={i} className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-2">
              <TextInput
                aria-label={`Parameter ${i + 1} name`}
                value={p.key}
                placeholder="tour_name"
                onChange={(e) => setDraft({ ...draft, params: draft.params.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
              />
              <TextInput
                aria-label={`Parameter ${i + 1} value`}
                value={p.value}
                placeholder="Λουτράκι"
                onChange={(e) => setDraft({ ...draft, params: draft.params.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, params: draft.params.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          {draft.params.length < MAX_CUSTOM_PARAMS ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setDraft({ ...draft, params: [...draft.params, { key: '', value: '' }] })}
            >
              + Parameter
            </Button>
          ) : null}
        </fieldset>

        <div className="mt-4 flex gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 accent-warm-gold" checked={draft.ga4} onChange={(e) => setDraft({ ...draft, ga4: e.target.checked })} />
            Send to GA4
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 accent-warm-gold" checked={draft.meta} onChange={(e) => setDraft({ ...draft, meta: e.target.checked })} />
            Send to Meta (custom event)
          </label>
        </div>

        {draftError ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {draftError}
          </p>
        ) : null}
        <Button type="button" variant="secondary" className="mt-4" onClick={addDraft}>
          Add to the list
        </Button>
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
          Save custom events
        </Button>
      </div>

      <CustomEventsGuide events={events} />
    </div>
  );
}

function CustomEventsGuide({ events }: { events: readonly CustomEvent[] }) {
  const dimensions = customParamsToDeclare(events);
  return (
    <Section title="How to use a custom event">
      <div className="flex max-w-3xl flex-col gap-4 text-sm text-neutral-700">
        <div>
          <h3 className="font-semibold text-neutral-900">a. Tracking</h3>
          <p>
            Nothing to set up. GA4: Reports → Engagement → Events. Meta: Events Manager → Data sources → your Pixel.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-neutral-900">b. Retargeting</h3>
          <p>
            Meta: Audiences → Create audience → Custom audience → Website → &ldquo;Events&rdquo; → choose the event (for
            example virtual_tour_open) and a period (for example 30 days) → Create.
          </p>
          <p>
            Google Ads: in GA4, Admin → Audiences → New audience → condition &ldquo;event name = …&rdquo;, with GA4 linked
            to Google Ads.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-neutral-900">c. As an ad goal / a measured result</h3>
          <p>
            Meta: Events Manager → Custom conversions → Create → Data source: your Pixel → Event: the custom event
            (optionally a rule on a parameter, for example tour_name = Λουτράκι) → Category (for example Lead) →
            optional value → Create. Then choose it as the conversion event in the campaign.
          </p>
          <p>
            GA4: Admin → Events → Mark as key event, then in Google Ads: Tools → Conversions → Import → Google
            Analytics 4.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-neutral-900">Custom dimensions in GA4</h3>
          <p>
            For a parameter of your own to appear as a column in GA4 reports: Admin → Custom definitions → Create custom
            dimension → Scope: Event → Event parameter: its name. Declare these:
          </p>
          <ul className="mt-1 flex flex-wrap gap-2 font-mono text-xs">
            {dimensions.map((d) => (
              <li key={d} className="rounded-sm bg-neutral-100 px-2 py-0.5">
                {d}
              </li>
            ))}
          </ul>
        </div>
        {events.length > 0 ? (
          <div>
            <h3 className="font-semibold text-neutral-900">Worth making custom conversions</h3>
            <ul className="mt-1 flex flex-wrap gap-2 font-mono text-xs">
              {events.map((e) => (
                <li key={e.name} className="rounded-sm bg-neutral-100 px-2 py-0.5">
                  {e.name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
