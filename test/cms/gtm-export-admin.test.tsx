/**
 * Settings → Analytics & Marketing → GTM export (REQ-5 §5): the download, the
 * Ads conversion labels, the import instructions, and the entities a re-import
 * will not delete by itself.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GtmExportPanel } from '@/cms/admin/analytics/GtmExportPanel';

const base = {
  gtmId: 'GTM-ABCD123',
  googleAds: { conversionId: 'AW-123456789', labels: { purchase: 'AbCdBuy' } },
  labelEvents: ['generate_lead', 'purchase', 'virtual_tour_open'],
  stale: [] as string[],
};

describe('GtmExportPanel', () => {
  test('a download button for the container', () => {
    const html = renderToStaticMarkup(<GtmExportPanel {...base} />);
    assert.match(html, /Download GTM settings \(JSON\)/);
  });

  test('without a container ID it says what to set first, and offers no download', () => {
    const html = renderToStaticMarkup(<GtmExportPanel {...base} gtmId={null} />);
    assert.match(html, /Google Tag Manager container ID/);
    assert.doesNotMatch(html, /<button[^>]*>Download GTM settings/);
  });

  test('the import steps: Merge, Overwrite — never Rename — then Preview and Publish', () => {
    const html = renderToStaticMarkup(<GtmExportPanel {...base} />);
    for (const phrase of ['Admin → Import Container', 'Merge', 'Overwrite conflicting tags, triggers and variables', 'Rename', 'Preview', 'Publish']) {
      assert.ok(html.includes(phrase), phrase);
    }
    assert.match(html, /CMS · /);
  });

  test('a Conversion Label field per offered event, with the saved one filled in', () => {
    const html = renderToStaticMarkup(<GtmExportPanel {...base} />);
    for (const id of base.labelEvents) assert.match(html, new RegExp(`aria-label="Conversion label: ${id}"`));
    assert.match(html, /value="AbCdBuy"/);
    assert.match(html, /value="AW-123456789"/);
  });

  test('lists what the last download had and this one will not — to delete in GTM by hand', () => {
    const html = renderToStaticMarkup(<GtmExportPanel {...base} stale={['CMS · GA4 · add_coupon', 'CMS · Trigger · add_coupon']} />);
    assert.match(html, /CMS · GA4 · add_coupon/);
    assert.match(html, /delete/i);
  });
});
