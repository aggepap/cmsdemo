'use client';

import { useState } from 'react';

import {
  ANNOUNCEMENT_KEY,
  ANNOUNCEMENT_TEXT_MAX,
  type AnnouncementConfig,
} from '../core/settings/announcement';
import { cmsApi } from './api-client';
import { apiErrorText } from './api-error-text';
import { Button, Checkbox, Field, Section, TextInput } from './ui';

/**
 * Settings → Announcement bar.
 *
 * One line of plain text per language, an optional link and whether visitors
 * may close it. Validated by the settings API (`announcementSchema`); the
 * length limit is also on the box, so it cannot be overrun by accident.
 */
export function AnnouncementSettings({
  initial,
  locales,
}: {
  initial: AnnouncementConfig;
  /** The languages being edited, main one first. */
  locales: string[];
}) {
  const [config, setConfig] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await cmsApi.updateSiteSettings({ [ANNOUNCEMENT_KEY]: config });
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, 'Could not save the announcement bar.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Announcement bar">
      <div className="flex max-w-lg flex-col gap-4">
        <Checkbox
          label="Show the announcement bar"
          info="A single line above the header on every page of the site."
          checked={config.enabled}
          onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
        />
        {locales.map((locale) => (
          <Field
            key={locale}
            label={`Text (${locale.toUpperCase()})`}
            description={`Plain text, up to ${ANNOUNCEMENT_TEXT_MAX} characters. A language left empty shows the main language’s text.`}
          >
            <TextInput
              value={config.text[locale] ?? ''}
              maxLength={ANNOUNCEMENT_TEXT_MAX}
              onChange={(e) =>
                setConfig({ ...config, text: { ...config.text, [locale]: e.target.value } })
              }
            />
          </Field>
        ))}
        <Field
          label="Link (optional)"
          description="A page on this site, starting with / (e.g. /shop), or a full https:// address. A link to another site opens in a new tab."
        >
          <TextInput
            value={config.href}
            placeholder="/shop"
            onChange={(e) => setConfig({ ...config, href: e.target.value })}
          />
        </Field>
        <Checkbox
          label="Visitors can dismiss it"
          info="Adds a close button. A closed bar stays closed in that browser until you change the text or the link."
          checked={config.dismissible}
          onChange={(e) => setConfig({ ...config, dismissible: e.target.checked })}
        />
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
        <Button type="button" onClick={() => void save()} disabled={saving}>
          Save
        </Button>
      </div>
    </Section>
  );
}
