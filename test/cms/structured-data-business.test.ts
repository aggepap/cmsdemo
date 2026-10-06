import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BUSINESS_TYPE_HELP } from '@/cms/admin/StructuredDataSettings';
import type { OpeningHours } from '@/cms/core/brand/policy';
import { businessNode, openingHoursSpecification, type BusinessLocation } from '@/cms/core/structured-data/nodes';
import {
  BUSINESS_TYPES,
  LOCAL_BUSINESS_TYPES,
  SCHEMA_POLICY_KEY,
  availableSchemaCategories,
  categoryForCollection,
  isLocalBusiness,
  parseSchemaPolicy,
  resolveSchemaChoice,
} from '@/cms/core/structured-data/policy';
import { checkStructuredSetting } from '@/cms/core/settings/structured';

/**
 * The site-wide business node: the more specific local-business types our
 * clients are (an optician, a bakery, a pharmacy…), its opening hours, and the
 * other shops it runs.
 */

/**
 * schema.org's LocalBusiness subtypes we offer, checked by hand against
 * https://schema.org/LocalBusiness — a type not on schema.org is ignored by
 * Google, so a typo here would silently cost a client their rich result.
 */
const SCHEMA_ORG_LOCAL_BUSINESS = new Set([
  'LocalBusiness',
  'Store',
  'TravelAgency',
  'LodgingBusiness',
  'Hotel',
  'BedAndBreakfast',
  'Resort',
  'ProfessionalService',
  'Restaurant',
  'Optician',
  'Pharmacy',
  'Dentist',
  'MedicalClinic',
  'BeautySalon',
  'HairSalon',
  'NailSalon',
  'DaySpa',
  'ExerciseGym',
  'AutoRepair',
  'RealEstateAgent',
  'LegalService',
  'AccountingService',
  'Bakery',
  'CafeOrCoffeeShop',
  'BarOrPub',
  'Winery',
  'ClothingStore',
  'JewelryStore',
  'ShoeStore',
  'ElectronicsStore',
  'FurnitureStore',
  'HomeGoodsStore',
  'HardwareStore',
  'SportingGoodsStore',
  'BookStore',
  'Florist',
  'GroceryStore',
  'PetStore',
  'TouristInformationCenter',
]);

describe('business types', () => {
  test('an optician and the other common client types can be chosen', () => {
    for (const type of ['Optician', 'Pharmacy', 'Dentist', 'Bakery', 'CafeOrCoffeeShop', 'ClothingStore', 'TouristInformationCenter']) {
      assert.ok((BUSINESS_TYPES as readonly string[]).includes(type), type);
    }
  });

  test('every local type is a real schema.org LocalBusiness subtype', () => {
    for (const type of LOCAL_BUSINESS_TYPES) assert.ok(SCHEMA_ORG_LOCAL_BUSINESS.has(type), type);
  });

  test('the new types are local businesses — they need the address', () => {
    assert.equal(isLocalBusiness('Optician'), true);
    assert.equal(isLocalBusiness('HairSalon'), true);
    assert.equal(isLocalBusiness('OnlineStore'), false);
  });

  test('every type is explained in plain words in the admin', () => {
    for (const type of BUSINESS_TYPES) assert.ok(BUSINESS_TYPE_HELP[type]?.length > 0, type);
  });

  test('a new type can be saved and is read back', () => {
    const res = checkStructuredSetting(SCHEMA_POLICY_KEY, { business: { type: 'Optician' } })!;
    assert.equal(res.ok, true);
    assert.equal(parseSchemaPolicy({ business: { type: 'Optician' } }).business.type, 'Optician');
  });
});

const org = {
  '@type': 'Organization',
  '@id': 'https://x.test/#organization',
  name: 'Acme',
  address: { '@type': 'PostalAddress', addressLocality: 'Athens' },
  contactPoint: { '@type': 'ContactPoint', telephone: '+30210' },
};

const weekdays: OpeningHours = { days: ['Mo', 'Tu', 'We', 'Th', 'Fr'], opens: '09:00', closes: '17:00', validFrom: '', validThrough: '' };
const summerSaturday: OpeningHours = { days: ['Sa'], opens: '10:00', closes: '14:00', validFrom: '2026-06-01', validThrough: '2026-09-30' };

const branch = (over: Partial<BusinessLocation> = {}): BusinessLocation => ({
  id: 'https://x.test/#location-kifisia',
  name: 'Kifisia store',
  address: { '@type': 'PostalAddress', streetAddress: '5 Levidou', addressLocality: 'Kifisia' },
  telephone: '+302101111111',
  openingHours: [weekdays],
  mapUrl: 'https://maps.google.com/?cid=1',
  tourUrl: 'https://my.matterport.com/show/?m=abc',
  image: 'https://x.test/api/cms/media/file/abc',
  ...over,
});

describe('opening hours in structured data', () => {
  test('each row becomes an OpeningHoursSpecification with schema.org day URLs', () => {
    assert.deepEqual(openingHoursSpecification([weekdays, summerSaturday]), [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: [
          'https://schema.org/Monday',
          'https://schema.org/Tuesday',
          'https://schema.org/Wednesday',
          'https://schema.org/Thursday',
          'https://schema.org/Friday',
        ],
        opens: '09:00',
        closes: '17:00',
      },
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['https://schema.org/Saturday'],
        opens: '10:00',
        closes: '14:00',
        validFrom: '2026-06-01',
        validThrough: '2026-09-30',
      },
    ]);
  });

  test('a local business carries its opening hours', () => {
    const node = businessNode(org, { type: 'Optician', priceRange: '' }, { openingHours: [weekdays] });
    assert.equal(node['@type'], 'Optician');
    assert.equal((node.openingHoursSpecification as unknown[]).length, 1);
  });

  test('an Organization or an online store never does — it has no door to open', () => {
    for (const type of ['Organization', 'OnlineStore'] as const) {
      const node = businessNode(org, { type, priceRange: '' }, { openingHours: [weekdays] });
      assert.equal(node.openingHoursSpecification, undefined, type);
    }
  });

  test('no hours means no property, not an empty list', () => {
    const node = businessNode(org, { type: 'Bakery', priceRange: '' }, { openingHours: [] });
    assert.equal('openingHoursSpecification' in node, false);
  });
});

describe('store locations in structured data', () => {
  test('each location is a department of the business, typed like it, with its own id', () => {
    const node = businessNode(org, { type: 'Optician', priceRange: '' }, { locations: [branch()] });
    const [dept] = node.department as Record<string, unknown>[];
    assert.equal(dept['@type'], 'Optician');
    assert.equal(dept['@id'], 'https://x.test/#location-kifisia');
    assert.equal(dept.name, 'Kifisia store');
    assert.equal(dept.telephone, '+302101111111');
    assert.deepEqual(dept.address, branch().address);
    assert.equal(dept.hasMap, 'https://maps.google.com/?cid=1');
    assert.equal(dept.image, 'https://x.test/api/cms/media/file/abc');
    assert.equal((dept.openingHoursSpecification as unknown[]).length, 1);
    assert.deepEqual(dept.parentOrganization, { '@id': org['@id'] });
  });

  test('the 3D tour is a CreativeWork about the location, not a sameAs identity claim', () => {
    const node = businessNode(org, { type: 'Store', priceRange: '' }, { locations: [branch()] });
    const [dept] = node.department as Record<string, unknown>[];
    assert.deepEqual(dept.subjectOf, { '@type': 'CreativeWork', url: 'https://my.matterport.com/show/?m=abc' });
    assert.equal(dept.sameAs, undefined);
  });

  test('optional parts left empty are left out', () => {
    const bare = branch({ telephone: undefined, openingHours: [], mapUrl: undefined, tourUrl: undefined, image: undefined });
    const [dept] = businessNode(org, { type: 'Store', priceRange: '' }, { locations: [bare] }).department as Record<
      string,
      unknown
    >[];
    for (const key of ['telephone', 'openingHoursSpecification', 'hasMap', 'subjectOf', 'image']) {
      assert.equal(key in dept, false, key);
    }
  });

  test('a location without an address is skipped — Google requires one', () => {
    const node = businessNode(org, { type: 'Store', priceRange: '' }, { locations: [branch({ address: null })] });
    assert.equal('department' in node, false);
  });

  test('the shops of an online store or a plain Organization are still listed, as shops', () => {
    const online = businessNode(org, { type: 'OnlineStore', priceRange: '' }, { locations: [branch()] });
    assert.equal((online.department as Record<string, unknown>[])[0]['@type'], 'Store');
    const plain = businessNode(org, { type: 'Organization', priceRange: '' }, { locations: [branch()] });
    assert.equal((plain.department as Record<string, unknown>[])[0]['@type'], 'LocalBusiness');
  });
});

describe('product categories in Settings → Structured data', () => {
  test('a shop category page has its own category, offered only with the shop on', () => {
    assert.equal(categoryForCollection('category'), 'productCategories');
    const keys = (moduleFlags: Record<string, boolean>) =>
      availableSchemaCategories({ collectionKeys: ['page', 'category'], moduleFlags }).map((c) => c.key);
    assert.deepEqual(keys({ commerce: true }), ['pages', 'productCategories']);
    assert.deepEqual(keys({ commerce: false }), ['pages']);
  });

  test('it defaults to a CollectionPage with the SEO panel FAQs appended', () => {
    const choice = resolveSchemaChoice(parseSchemaPolicy(null), 'productCategories', null);
    assert.equal(choice.type, 'CollectionPage');
    assert.equal(choice.appendFaq, true);
  });
});
