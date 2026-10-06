/**
 * Settings → Analytics & Marketing → Custom events (REQ-5 §4): the table, and
 * the guide that explains the three uses (tracking, retargeting, conversions)
 * and lists the GA4 custom dimensions to declare.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CustomEventsManager, triggerSummary } from '@/cms/admin/analytics/CustomEventsManager';
import type { CustomEvent } from '@/cms/core/analytics/custom-events';

const tour: CustomEvent = {
  name: 'virtual_tour_open',
  trigger: { type: 'click', selector: 'virtual-tour' },
  params: [{ key: 'tour_name', value: 'Λουτράκι' }],
  ga4: true,
  meta: true,
};

describe('triggerSummary', () => {
  test('says when each trigger fires', () => {
    assert.equal(triggerSummary({ type: 'click', selector: 'virtual-tour' }), 'Click on [data-track="virtual-tour"]');
    assert.equal(triggerSummary({ type: 'click', selector: '#book' }), 'Click on #book');
    assert.equal(triggerSummary({ type: 'download', extensions: ['pdf', 'zip'] }), 'Download of .pdf, .zip');
    assert.equal(triggerSummary({ type: 'video' }), 'A [video] block is opened');
    assert.equal(triggerSummary({ type: 'view', path: '/pricing' }), 'Page /pricing is opened');
    assert.equal(triggerSummary({ type: 'view', sectionId: 'faq' }), 'Section #faq is shown');
    assert.equal(triggerSummary({ type: 'form', formId: 'quote_request' }), 'Form quote_request is sent');
  });
});

describe('CustomEventsManager', () => {
  const html = renderToStaticMarkup(<CustomEventsManager initial={[tour]} />);

  test('lists the saved events with their trigger and fixed parameters', () => {
    assert.match(html, /virtual_tour_open/);
    assert.match(html, /Click on \[data-track=&quot;virtual-tour&quot;\]/);
    assert.match(html, /tour_name = Λουτράκι/);
  });

  test('offers to add one', () => {
    assert.match(html, /Add a custom event/);
  });

  test('the guide covers tracking, retargeting and conversions in both tools', () => {
    for (const phrase of [
      'Reports → Engagement → Events',
      'Events Manager → Data sources',
      'Audiences → Create audience → Custom audience → Website',
      'Custom conversions',
      'Mark as key event',
      'Tools → Conversions → Import → Google Analytics 4',
      'Custom definitions → Create custom dimension',
    ]) {
      assert.ok(html.includes(phrase), phrase);
    }
  });

  test('the guide lists the parameters to declare, including the custom ones', () => {
    assert.match(html, /tour_name/);
    assert.match(html, /element_text/);
  });
});
