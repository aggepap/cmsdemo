import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SeoManager } from '@/cms/admin/SeoManager';

/** Admin → SEO: pending mappings, the import, and the 404 monitor's link to them. */

const redirect = (over: Record<string, unknown>) => ({
  id: 1,
  source: '/old',
  target: '/new',
  statusCode: 301,
  kind: 'literal',
  active: true,
  hits: 0,
  notes: null,
  ...over,
});
const nf = (over: Record<string, unknown>) => ({
  id: 1,
  path: '/missing',
  locale: 'el',
  hits: 3,
  lastSeen: '2026-09-01T00:00:00.000Z',
  ignored: false,
  ...over,
});

const render = (props: Partial<Parameters<typeof SeoManager>[0]>) =>
  renderToStaticMarkup(<SeoManager redirects={[]} notFounds={[]} metas={[]} {...props} />);

describe('SeoManager — pending mappings', () => {
  test('a pending row is labelled pending instead of offering an on/off switch', () => {
    const html = render({ redirects: [redirect({ id: 9, target: '', active: false, source: '/product/old-thing' })] });
    assert.match(html, /\/product\/old-thing/);
    assert.match(html, />pending</);
    assert.doesNotMatch(html, />disabled</);
  });

  test('a pending row shows the suggested target from the site’s known pages', () => {
    const html = render({
      redirects: [redirect({ id: 9, target: '', active: false, source: '/product/blue-shirt' })],
      knownPaths: ['/shop/blue-shirt'],
    });
    assert.match(html, /\/shop\/blue-shirt/);
  });

  test('the redirect list can be filtered down to pending mappings', () => {
    const html = render({});
    assert.match(html, /<option value="pending">Pending/);
  });

  test('offers a CSV import with a preview step', () => {
    const html = render({});
    assert.match(html, /Import redirects from CSV/);
    assert.match(html, />Preview</);
  });
});

describe('SeoManager — 404 monitor', () => {
  test('a 404 already in the pending list says so', () => {
    const html = render({
      redirects: [redirect({ id: 9, source: '/missing', target: '', active: false })],
      notFounds: [nf({})],
    });
    assert.match(html, /Pending mapping/);
  });

  test('a 404 now covered by a redirect shows where it goes', () => {
    const html = render({ redirects: [redirect({ source: '/missing', target: '/found' })], notFounds: [nf({})] });
    assert.match(html, /Redirected → \/found/);
  });

  test('no longer promises a redirect to the home page', () => {
    const html = render({ notFounds: [nf({})] });
    assert.doesNotMatch(html, /creates a 301 from the path to/);
  });
});
