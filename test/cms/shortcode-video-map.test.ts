import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SHORTCODES, attrsToZod, resolveShortcode } from '@/cms/core/shortcodes';
import { directionsUrl, videoHref } from '@/cms/core/shortcodes/media-blocks';

/**
 * `[video]` and `[map]`: a local preview image and a link out — never an
 * iframe, never a remote thumbnail or tile. The CSP has no `frame-src` and
 * `img-src` is 'self', so anything embedded would be blocked anyway, and a
 * remote image would hand every visitor's IP to the video host.
 *
 * The URL is the only thing an editor types that leaves the site, so its host
 * is checked against a short allow-list, twice: by the registry (the editor
 * sees the warning) and again by the helper the component renders through.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const resolve = (name: string, attrs: Record<string, string>) =>
  resolveShortcode(SHORTCODES, { name, attrs }, {});

describe('video shortcode', () => {
  test('is registered with no module, so every site has it', () => {
    assert.ok(SHORTCODES.video);
    assert.equal(SHORTCODES.video.module, undefined);
  });

  test('accepts a YouTube, youtu.be or Vimeo link with a title and a library image', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtu.be/dQw4w9WgXcQ',
      'https://vimeo.com/76979871',
      'https://www.vimeo.com/76979871',
    ]) {
      const result = resolve('video', { url, title: 'Κατάστημα Λουτρακίου', image: UUID });
      assert.equal(result.kind, 'ok', url);
    }
  });

  test('refuses any other host, scheme or a host that only looks right', () => {
    for (const url of [
      'http://www.youtube.com/watch?v=x',
      'https://evil.com/watch?v=x',
      'https://youtube.com.evil.com/x',
      'https://evilyoutube.com/x',
      'https://youtube.com@evil.com/x',
      'https://m.youtube.com/watch?v=x',
      'javascript:alert(1)',
      '//youtube.com/x',
      'https://www.youtube.com/watch?v=x" onmouseover="x',
    ]) {
      assert.notEqual(resolve('video', { url, title: 'T', image: UUID }).kind, 'ok', url);
    }
  });

  test('the url, the title and the image are all required', () => {
    assert.notEqual(resolve('video', { title: 'T', image: UUID }).kind, 'ok');
    assert.notEqual(resolve('video', { url: 'https://youtu.be/x', image: UUID }).kind, 'ok');
    assert.notEqual(resolve('video', { url: 'https://youtu.be/x', title: 'T' }).kind, 'ok');
    assert.notEqual(resolve('video', { url: 'https://youtu.be/x', title: '', image: UUID }).kind, 'ok');
  });

  test('the image must be a media library id, not a URL to somebody else’s server', () => {
    const result = resolve('video', {
      url: 'https://youtu.be/x',
      title: 'T',
      image: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
    });
    assert.notEqual(result.kind, 'ok');
  });
});

describe('videoHref', () => {
  test('returns the normalised link for an allowed host', () => {
    assert.equal(videoHref('https://youtu.be/dQw4w9WgXcQ'), 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(videoHref(' https://vimeo.com/1 '), 'https://vimeo.com/1');
  });

  test('returns null for anything else', () => {
    for (const url of [
      '',
      'not a url',
      'http://youtu.be/x',
      'https://youtube.com.evil.com/x',
      'https://user:pass@youtube.com/x',
      'https://youtube.com:8443/x',
      'javascript:alert(1)',
      'data:text/html,hi',
    ]) {
      assert.equal(videoHref(url), null, url);
    }
  });
});

describe('map shortcode', () => {
  test('is registered with no module', () => {
    assert.ok(SHORTCODES.map);
    assert.equal(SHORTCODES.map.module, undefined);
  });

  test('accepts an image and a title with coordinates, an address, or both', () => {
    assert.equal(resolve('map', { image: UUID, title: 'Shop', lat: '37.97', lng: '22.98' }).kind, 'ok');
    assert.equal(resolve('map', { image: UUID, title: 'Shop', address: 'Λουτράκι 203 00' }).kind, 'ok');
  });

  test('requires the image and the title', () => {
    assert.notEqual(resolve('map', { title: 'Shop', address: 'x' }).kind, 'ok');
    assert.notEqual(resolve('map', { image: UUID, address: 'x' }).kind, 'ok');
  });

  test('refuses coordinates that are not numbers', () => {
    assert.notEqual(resolve('map', { image: UUID, title: 'S', lat: 'north', lng: '1' }).kind, 'ok');
    assert.notEqual(resolve('map', { image: UUID, title: 'S', lat: '1', lng: '1e3' }).kind, 'ok');
  });

  test('an undeclared attribute is still refused', () => {
    assert.equal(attrsToZod(SHORTCODES.map.attrs).safeParse({ image: UUID, title: 'S', zoom: '3' }).success, false);
  });
});

describe('directionsUrl', () => {
  const BASE = 'https://www.google.com/maps/dir/?api=1&destination=';

  test('prefers coordinates, which do not depend on how Google reads an address', () => {
    assert.equal(
      directionsUrl({ lat: '37.9761', lng: '22.9786', address: 'Somewhere' }),
      `${BASE}${encodeURIComponent('37.9761,22.9786')}`,
    );
  });

  test('falls back to the address, encoded', () => {
    assert.equal(
      directionsUrl({ address: 'Ελ. Βενιζέλου 1 & Λουτράκι' }),
      `${BASE}${encodeURIComponent('Ελ. Βενιζέλου 1 & Λουτράκι')}`,
    );
  });

  test('coordinates out of range are ignored, not sent', () => {
    assert.equal(directionsUrl({ lat: '91', lng: '0', address: '' }), null);
    assert.equal(directionsUrl({ lat: '0', lng: '181' }), null);
    assert.equal(directionsUrl({ lat: '91', lng: '0', address: 'Athens' }), `${BASE}Athens`);
  });

  test('half a coordinate pair is not a destination', () => {
    assert.equal(directionsUrl({ lat: '37.9' }), null);
  });

  test('nothing to go on gives no link', () => {
    assert.equal(directionsUrl({}), null);
    assert.equal(directionsUrl({ address: '   ' }), null);
  });
});
