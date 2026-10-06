import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { BrandSettings } from '@/cms/admin/BrandSettings';
import { BASE_PALETTE, PALETTE_TOKENS, parseBrandIdentity } from '@/cms/core/brand/policy';

/**
 * Settings → Branding. One screen for who the site is and what colours it wears,
 * so an owner never needs a developer (or a code deploy) to change either.
 */

const render = (palette = BASE_PALETTE, identity: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <BrandSettings
      initialIdentity={parseBrandIdentity(null, { name: 'Acme', ...identity })}
      initialPalette={palette}
    />,
  );

const kifisia = {
  id: 'kifisia',
  name: 'Kifisia store',
  address: { street: '5 Levidou', city: 'Kifisia', postcode: '14562', country: 'GR' },
  phone: '+30 210 111 1111',
  openingHours: [
    { days: ['Mo', 'Fr'], opens: '09:00', closes: '17:00', validFrom: '', validThrough: '' },
  ],
  mapUrl: 'https://maps.google.com/?cid=1',
  tourUrl: '',
  imageId: null,
};

describe('BrandSettings', () => {
  test('the identity fields are labelled', () => {
    const html = render();
    for (const label of ['Site name', 'Legal name', 'Tagline', 'Email', 'Phone', 'Logo', 'Favicon']) {
      assert.ok(html.includes(label), label);
    }
    assert.ok(html.includes('value="Acme"'));
  });

  test('every colour token has a picker', () => {
    const html = render();
    for (const token of PALETTE_TOKENS) {
      assert.ok(html.includes(token.label), token.key);
    }
  });

  test('the base palette raises no contrast warning', () => {
    assert.ok(!render().includes('role="alert"'));
  });

  test('text that would be unreadable on the page background is flagged', () => {
    const html = render({ ...BASE_PALETTE, 'text-primary': '#f5f5f5' });
    assert.match(html, /role="alert"/);
    assert.match(html, /Main text/);
  });

  test('opening hours have an editor with labelled days, times and season dates', () => {
    const html = render(BASE_PALETTE, {
      openingHours: [
        { days: ['Mo', 'Tu'], opens: '09:00', closes: '17:00', validFrom: '2026-06-01', validThrough: '' },
      ],
    });
    assert.match(html, /Opening hours/);
    for (const label of ['Monday', 'Sunday', 'Opens', 'Closes', 'Valid from', 'Valid through']) {
      assert.ok(html.includes(label), label);
    }
    assert.match(html, /type="time"[^>]*value="09:00"|value="09:00"[^>]*type="time"/);
    assert.match(html, /Add opening hours/);
  });

  test('store locations can be added, removed and reordered', () => {
    const html = render(BASE_PALETTE, { locations: [kifisia, { ...kifisia, id: 'b', name: 'Glyfada' }] });
    assert.match(html, /Store locations/);
    assert.ok(html.includes('value="Kifisia store"'));
    assert.ok(html.includes('value="Glyfada"'));
    for (const label of ['Location name', 'Map link', '3D tour link', 'Add a location', 'Move up', 'Move down']) {
      assert.ok(html.includes(label), label);
    }
    assert.ok(html.includes('Remove location'));
  });

  test('with no locations, the editor says what they are for', () => {
    assert.match(render(), /No other locations/);
  });
});
