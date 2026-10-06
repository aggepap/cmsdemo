/**
 * Settings → Analytics & Marketing → Events (REQ-5 §3).
 *
 * The admin chooses profiles and flips any event's GA4 / Meta switch. Only what
 * differs from the profile default is stored, so changing the profile later
 * still moves every event the admin never touched.
 */
import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { EVENT_CATALOG, setEventSwitch } from '@/cms/core/analytics/catalog';
import { EventsManager } from '@/cms/admin/analytics/EventsManager';

describe('setEventSwitch', () => {
  test('an override that differs from the default is stored', () => {
    const next = setEventSwitch({ profiles: ['website'] }, ['website'], 'generate_lead', 'meta', false);
    assert.deepEqual(next.events, { generate_lead: { meta: false } });
  });

  test('switching back to the default removes the override', () => {
    const next = setEventSwitch(
      { profiles: ['website'], events: { generate_lead: { meta: false } } },
      ['website'],
      'generate_lead',
      'meta',
      true,
    );
    assert.deepEqual(next.events, {});
  });

  test('the other destination of the same event is kept', () => {
    const next = setEventSwitch(
      { profiles: ['website'], events: { generate_lead: { meta: false, ga4: false } } },
      ['website'],
      'generate_lead',
      'meta',
      true,
    );
    assert.deepEqual(next.events, { generate_lead: { ga4: false } });
  });

  test('an event of another profile can be switched on', () => {
    const next = setEventSwitch({ profiles: ['website'] }, ['website'], 'add_to_cart', 'ga4', true);
    assert.deepEqual(next.events, { add_to_cart: { ga4: true } });
  });
});

describe('EventsManager', () => {
  const html = renderToStaticMarkup(<EventsManager initial={{}} suggested={['website', 'eshop']} />);

  test('one row per browser event, each with a labelled GA4 and Meta switch', () => {
    for (const event of EVENT_CATALOG.filter((e) => !e.serverOnly)) {
      assert.match(html, new RegExp(`aria-label="GA4: ${event.id}"`), event.id);
      assert.match(html, new RegExp(`aria-label="Meta: ${event.id}"`), event.id);
    }
  });

  test('the Meta column says standard or custom', () => {
    assert.match(html, /Meta: Lead/);
    assert.match(html, /Meta: custom/);
  });

  test('the suggested profiles are pre-ticked when none was saved', () => {
    assert.match(html, /<input[^>]*checked=""[^>]*aria-label="Profile: E-shop"|aria-label="Profile: E-shop"[^>]*checked=""/);
    assert.doesNotMatch(html, /<input[^>]*checked=""[^>]*aria-label="Profile: Booking"|aria-label="Profile: Booking"[^>]*checked=""/);
  });

  test('an event with no Meta equivalent has its Meta switch disabled', () => {
    assert.match(html, /aria-label="Meta: remove_from_cart"[^>]*disabled=""|disabled=""[^>]*aria-label="Meta: remove_from_cart"/);
  });
});
