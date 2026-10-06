/**
 * Settings → Analytics & Marketing → Status (REQ-5 §6, §7): what loads, what
 * the site sends, the Conversions API and its queue, debug, and the privacy
 * text to add for the server-side sends.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AnalyticsStatusPanel, eventExamples, providerStatuses } from '@/cms/admin/analytics/AnalyticsStatusPanel';
import { resolveEventSwitches } from '@/cms/core/analytics/catalog';
import { resolveMarketingConfig } from '@/cms/core/settings/marketing';

const config = resolveMarketingConfig({
  'analytics.gaMeasurementId': 'G-ABC1234567',
  'analytics.gtmContainerId': 'GTM-ABCD123',
  'analytics.ga4ViaGtm': 'on',
  'marketing.metaPixelId': '123456789012345',
});

describe('providerStatuses', () => {
  test('each provider: loads after consent, through GTM, or does not load', () => {
    const s = providerStatuses(config, { production: true });
    assert.deepEqual(
      s.map((p) => [p.provider, p.state]),
      [
        ['Google Tag Manager', 'waits_consent'],
        ['GA4', 'via_gtm'],
        ['Meta Pixel', 'waits_consent'],
      ],
    );
  });

  test('nothing loads outside production', () => {
    assert.ok(providerStatuses(config, { production: false }).every((p) => p.state === 'off'));
  });

  test('a provider without an ID does not load', () => {
    const none = providerStatuses(resolveMarketingConfig({}), { production: true });
    assert.ok(none.every((p) => p.state === 'off'));
  });
});

describe('eventExamples', () => {
  test('active events with example parameters, never personal data', () => {
    const list = eventExamples(resolveEventSwitches({ profiles: ['website'] }), []);
    const lead = list.find((e) => e.id === 'generate_lead');
    assert.ok(lead);
    assert.match(JSON.stringify(lead.example), /form_id/);
    assert.ok(!list.some((e) => e.id === 'add_to_cart'));
    assert.doesNotMatch(JSON.stringify(list), /@/);
  });
});

describe('AnalyticsStatusPanel', () => {
  const html = renderToStaticMarkup(
    <AnalyticsStatusPanel
      config={config}
      production
      switches={resolveEventSwitches({ profiles: ['website'] })}
      customEvents={[]}
      capi={{ events: ['Purchase', 'Lead', 'CompleteRegistration'] }}
      capiTokenSet={false}
      queue={{ counts: { pending: 1, sent: 5, failed: 1 }, recentFailures: [{ eventName: 'Lead', eventId: 'x', attempts: 6, lastError: 'HTTP 400', createdAt: new Date('2026-10-01T00:00:00Z') }] }}
    />,
  );

  test('shows the state of each provider in words', () => {
    assert.match(html, /Loads after consent/);
    assert.match(html, /Loads through GTM/);
  });

  test('says when the Conversions API token is missing, and where it goes', () => {
    assert.match(html, /META_CAPI_ACCESS_TOKEN/);
  });

  test('the queue: counts and the last failures', () => {
    assert.match(html, /HTTP 400/);
    assert.match(html, /Failed/);
  });

  test('the Test Event Code field and the event choices', () => {
    assert.match(html, /Test Event Code/);
    assert.match(html, /aria-label="Conversions API: Purchase"/);
  });

  test('debug and testing instructions', () => {
    for (const p of ['[cms analytics]', 'Tag Assistant', 'Test events', 'Realtime']) assert.ok(html.includes(p), p);
  });

  test('a privacy-policy text to add, in Greek and English', () => {
    assert.match(html, /Meta Platforms/);
    assert.match(html, /κρυπτογραφ/);
  });
});
