import '../setup/react-global'; // must precede any component import

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MapBlockView } from '@/components/shortcodes/MapBlockView';
import { VideoBlockView } from '@/components/shortcodes/VideoBlockView';

/**
 * What `[video]` and `[map]` put in the page: a picture from the site's own
 * media library and a link that opens the real thing in a new tab. No iframe
 * and no remote image, ever — the owner's rule, and the CSP's.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const videoLabels = { play: 'Watch the video', newTab: 'opens in a new tab' };
const mapLabels = { directions: 'Directions', directionsTo: 'Directions to', newTab: 'opens in a new tab' };

const video = (props: Partial<Parameters<typeof VideoBlockView>[0]> = {}) =>
  renderToStaticMarkup(
    <VideoBlockView
      url="https://youtu.be/dQw4w9WgXcQ"
      title="Κατάστημα Λουτρακίου"
      image={UUID}
      labels={videoLabels}
      {...props}
    />,
  );

describe('VideoBlockView', () => {
  test('the link names the video for custom events (title, url, provider)', () => {
    const html = video();
    assert.match(html, /data-cms-video-title="Κατάστημα Λουτρακίου"/);
    assert.match(html, /data-cms-video-url="https:\/\/youtu\.be\/dQw4w9WgXcQ"/);
    assert.match(html, /data-cms-video-provider="youtube"/);
    assert.match(video({ url: 'https://vimeo.com/76979871' }), /data-cms-video-provider="vimeo"/);
  });

  test('is a link to the video that opens in a new tab without handing over the opener', () => {
    const html = video();
    assert.match(html, /<a [^>]*href="https:\/\/youtu.be\/dQw4w9WgXcQ"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  test('its accessible name carries the title and says it opens a new tab', () => {
    const html = video();
    assert.match(html, /aria-label="Watch the video: Κατάστημα Λουτρακίου \(opens in a new tab\)"/);
  });

  test('shows the title as visible text too', () => {
    assert.match(video(), />Κατάστημα Λουτρακίου</);
  });

  test('the preview is the site’s own copy of the image', () => {
    const html = video();
    assert.match(html, new RegExp(`<img [^>]*src="/api/cms/media/file/${UUID}"`));
    assert.doesNotMatch(html, /ytimg|vimeocdn|iframe/i);
  });

  test('renders nothing for a host outside the allow-list', () => {
    assert.equal(video({ url: 'https://evil.com/x' }), '');
    assert.equal(video({ url: 'javascript:alert(1)' }), '');
  });

  test('renders nothing without an image or a title', () => {
    assert.equal(video({ image: '' }), '');
    assert.equal(video({ image: 'https://i.ytimg.com/x.jpg' }), '');
    assert.equal(video({ title: '  ' }), '');
  });
});

const map = (props: Partial<Parameters<typeof MapBlockView>[0]> = {}) =>
  renderToStaticMarkup(
    <MapBlockView
      image={UUID}
      title="Κατάστημα Λουτρακίου"
      address="Ελ. Βενιζέλου 1, Λουτράκι"
      lat=""
      lng=""
      labels={mapLabels}
      {...props}
    />,
  );

describe('MapBlockView', () => {
  test('shows the local map image, the title and the address', () => {
    const html = map();
    assert.match(html, new RegExp(`<img [^>]*src="/api/cms/media/file/${UUID}"`));
    assert.match(html, />Κατάστημα Λουτρακίου</);
    assert.match(html, />Ελ. Βενιζέλου 1, Λουτράκι</);
    assert.doesNotMatch(html, /iframe|tile|maps\.googleapis/i);
  });

  test('links to Google Maps directions in a new tab', () => {
    const html = map();
    const href = `https://www.google.com/maps/dir/?api=1&amp;destination=${encodeURIComponent('Ελ. Βενιζέλου 1, Λουτράκι')}`;
    assert.ok(html.includes(`href="${href}"`), html);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, />Directions</);
    assert.match(html, /aria-label="Directions to Κατάστημα Λουτρακίου \(opens in a new tab\)"/);
  });

  test('uses the coordinates when given', () => {
    assert.match(map({ lat: '37.97', lng: '22.97' }), /destination=37\.97%2C22\.97"/);
  });

  test('without a destination there is no directions link, only the picture', () => {
    const html = map({ address: '' });
    assert.doesNotMatch(html, /<a /);
    assert.match(html, /<img /);
  });

  test('renders nothing without an image or a title', () => {
    assert.equal(map({ image: '' }), '');
    assert.equal(map({ title: '' }), '');
  });
});
