import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BRAND_IDENTITY_KEY,
  brandIdentityOf,
  parseBrandIdentity,
  parsePalette,
  resolveBrand,
} from '@/cms/core/brand/policy';
import { checkStructuredSetting } from '@/cms/core/settings/structured';
import { collectSettingRefs, rewriteSettingValue } from '@/cms/core/transfer/settings-refs';

/**
 * Opening hours and store locations live in the brand identity, beside the
 * address and phone they belong with — edited in Settings → Branding, read by
 * the structured data and by any page that lists the shops.
 */

const UUID = '0b6f0d4e-6a1e-4c55-9d47-1f3b2a9c8e11';
const U2 = '22222222-2222-4222-8222-222222222222';

const identity = (over: Record<string, unknown> = {}) => ({
  name: 'Acme',
  legalName: '',
  tagline: '',
  email: '',
  phone: '+30 210 000 0000',
  address: { street: '1 Main St', city: 'Athens', postcode: '10557', country: 'GR' },
  socials: {},
  logoId: null,
  logoDarkId: null,
  faviconId: null,
  ogImageId: null,
  ...over,
});

const hours = (over: Record<string, unknown> = {}) => ({
  days: ['Mo', 'Tu', 'We', 'Th', 'Fr'],
  opens: '09:00',
  closes: '17:00',
  ...over,
});

const location = (over: Record<string, unknown> = {}) => ({
  id: 'kifisia',
  name: 'Kifisia store',
  address: { street: '5 Levidou', city: 'Kifisia', postcode: '14562', country: 'GR' },
  phone: '+30 210 111 1111',
  openingHours: [hours()],
  mapUrl: 'https://maps.google.com/?cid=1',
  tourUrl: 'https://my.matterport.com/show/?m=abc',
  imageId: UUID,
  ...over,
});

const check = (value: unknown) => checkStructuredSetting(BRAND_IDENTITY_KEY, value)!;
const ok = (value: unknown) => check(value).ok;

describe('brand identity — opening hours', () => {
  test('an identity saved before opening hours existed still validates and reads as no hours', () => {
    assert.equal(ok(identity()), true);
    const got = parseBrandIdentity(identity());
    assert.deepEqual(got.openingHours, []);
    assert.deepEqual(got.locations, []);
  });

  test('weekday hours are accepted, and days are stored once each in week order', () => {
    const res = check(identity({ openingHours: [hours({ days: ['Fr', 'Mo', 'Mo'] })] }));
    assert.equal(res.ok, true);
    if (res.ok) {
      const stored = res.value as { openingHours: { days: string[] }[] };
      assert.deepEqual(stored.openingHours[0].days, ['Mo', 'Fr']);
    }
  });

  test('seasonal hours carry a valid-from and valid-through date', () => {
    const summer = hours({ days: ['Sa', 'Su'], validFrom: '2026-06-01', validThrough: '2026-09-30' });
    assert.equal(ok(identity({ openingHours: [summer] })), true);
  });

  test('a season that ends before it starts is refused, naming the field', () => {
    const res = check(
      identity({ openingHours: [hours({ validFrom: '2026-09-30', validThrough: '2026-06-01' })] }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /validThrough/);
  });

  test('a date that does not exist is refused', () => {
    assert.equal(ok(identity({ openingHours: [hours({ validFrom: '2026-02-30' })] })), false);
    assert.equal(ok(identity({ openingHours: [hours({ validFrom: '1/6/2026' })] })), false);
  });

  test('times must be 24-hour HH:MM', () => {
    for (const bad of ['9:00', '24:00', '09:60', '9am', '']) {
      assert.equal(ok(identity({ openingHours: [hours({ opens: bad })] })), false, bad);
    }
  });

  test('closing after midnight is allowed — a bar open 18:00 to 02:00', () => {
    assert.equal(ok(identity({ openingHours: [hours({ opens: '18:00', closes: '02:00' })] })), true);
  });

  test('opening and closing at the same time is refused, except 00:00–00:00 for closed all day', () => {
    assert.equal(ok(identity({ openingHours: [hours({ opens: '09:00', closes: '09:00' })] })), false);
    const closed = hours({ opens: '00:00', closes: '00:00', validFrom: '2026-12-25', validThrough: '2026-12-25' });
    assert.equal(ok(identity({ openingHours: [closed] })), true);
  });

  test('a row with no days, or an unknown day, is refused', () => {
    assert.equal(ok(identity({ openingHours: [hours({ days: [] })] })), false);
    assert.equal(ok(identity({ openingHours: [hours({ days: ['Monday'] })] })), false);
  });

  test('unknown keys in a row are refused', () => {
    assert.equal(ok(identity({ openingHours: [hours({ note: 'x' })] })), false);
  });
});

describe('brand identity — locations', () => {
  test('a well-formed location is accepted', () => {
    assert.equal(ok(identity({ locations: [location()] })), true);
  });

  test('only the id and name are needed; the rest default to empty', () => {
    const res = check(identity({ locations: [{ id: 'x', name: 'Branch', address: location().address }] }));
    assert.equal(res.ok, true);
    if (res.ok) {
      const [loc] = (res.value as { locations: Record<string, unknown>[] }).locations;
      assert.equal(loc.phone, '');
      assert.deepEqual(loc.openingHours, []);
      assert.equal(loc.mapUrl, '');
      assert.equal(loc.tourUrl, '');
      assert.equal(loc.imageId, null);
    }
  });

  test('a location without a name is refused', () => {
    assert.equal(ok(identity({ locations: [location({ name: ' ' })] })), false);
  });

  test('two locations with the same id are refused — the id is what search engines key on', () => {
    assert.equal(ok(identity({ locations: [location(), location({ name: 'Other' })] })), false);
  });

  test('map and tour links must be http(s)', () => {
    assert.equal(ok(identity({ locations: [location({ mapUrl: 'javascript:alert(1)' })] })), false);
    assert.equal(ok(identity({ locations: [location({ tourUrl: 'data:text/html,x' })] })), false);
  });

  test('the image is a media reference, never a path', () => {
    assert.equal(ok(identity({ locations: [location({ imageId: '../../etc/passwd' })] })), false);
  });

  test('a location id that is not a short slug is refused', () => {
    assert.equal(ok(identity({ locations: [location({ id: 'has space' })] })), false);
  });

  test('a location’s own opening hours follow the same rules', () => {
    const bad = location({ openingHours: [hours({ opens: '25:00' })] });
    assert.equal(ok(identity({ locations: [bad] })), false);
  });
});

describe('brand read layer — locations', () => {
  const brand = resolveBrand(
    parseBrandIdentity(identity({ locations: [location()], openingHours: [hours()] })),
    parsePalette(null),
  );

  test('each location gets a tel: target and a public image URL', () => {
    const [loc] = brand.locations;
    assert.equal(loc.name, 'Kifisia store');
    assert.equal(loc.phoneHref, '+302101111111');
    assert.equal(loc.imageUrl, `/api/cms/media/file/${UUID}`);
    assert.deepEqual(brand.openingHours, [{ ...hours(), validFrom: '', validThrough: '' }]);
  });

  test('the editable identity is recovered from the resolved brand, and validates again', () => {
    const back = brandIdentityOf(brand);
    assert.equal('phoneHref' in back.locations[0], false);
    assert.equal('logoUrl' in back, false);
    assert.equal(ok(back), true);
  });
});

describe('transfer — location images', () => {
  test('a location image is a media reference that travels with the brand', () => {
    const value = identity({ logoId: UUID, locations: [location({ imageId: U2 })] });
    const refs = collectSettingRefs(BRAND_IDENTITY_KEY, value);
    assert.deepEqual(refs.map((r) => `${r.value}@${r.path}`).sort(), [
      `${UUID}@logoId`,
      `${U2}@locations.0.imageId`,
    ]);
  });

  test('a location image is rewritten to the target site’s media, or dropped', () => {
    const resolver = { doc: () => null, media: (u: string) => (u === UUID ? U2 : null) };
    const value = identity({ locations: [location({ imageId: UUID }), location({ id: 'b', imageId: U2 })] });
    const out = rewriteSettingValue(BRAND_IDENTITY_KEY, value, resolver);
    const locs = (out.value as { locations: { imageId: string | null }[] }).locations;
    assert.equal(locs[0].imageId, U2);
    assert.equal(locs[1].imageId, null);
    assert.equal(out.dropped.length, 1);
  });
});
