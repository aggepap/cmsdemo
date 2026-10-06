import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseBrandIdentity, parsePalette, resolveBrand } from '@/cms/core/brand/policy';
import { documentSeo } from '@/cms/core/seo/document';
import { parseSchemaPolicy } from '@/cms/core/structured-data/policy';
import { CategoryIntro } from '@/components/shop/CategoryIntro';
import { FaqSection } from '@/components/site/FaqSection';
import { documentStructuredData, organizationSchema, SITE_URL } from '@/lib/seo/schemas';

/**
 * A shop category page answers questions too: the SEO panel's answer summary is
 * its intro, its FAQs are shown on the page, and the same FAQs reach search
 * engines as a FAQPage when Settings → Structured data says so.
 */

const faqs = [
  { question: 'Do you ship to islands?', answer: 'Yes, within 3 days.' },
  { question: 'Can I return glasses?', answer: 'Within 14 days.' },
];

describe('CategoryIntro', () => {
  test('the answer summary is the intro when set', () => {
    const html = renderToStaticMarkup(
      <CategoryIntro answerSummary="Prescription frames from €80." description="Our frames." />,
    );
    assert.match(html, /Prescription frames from €80\./);
    assert.doesNotMatch(html, /Our frames\./);
  });

  test('otherwise the category description is', () => {
    const html = renderToStaticMarkup(<CategoryIntro answerSummary={null} description="Our frames." />);
    assert.match(html, /Our frames\./);
  });

  test('with neither, nothing is rendered', () => {
    assert.equal(renderToStaticMarkup(<CategoryIntro answerSummary={null} description="" />), '');
  });
});

describe('FaqSection', () => {
  test('every question and answer is visible under a labelled heading', () => {
    const html = renderToStaticMarkup(<FaqSection title="Frequently asked questions" faqs={faqs} />);
    assert.match(html, /<h2[^>]*id="faq-heading"[^>]*>Frequently asked questions<\/h2>/);
    assert.match(html, /aria-labelledby="faq-heading"/);
    assert.match(html, /<dt[^>]*>Do you ship to islands\?<\/dt>/);
    assert.match(html, /<dd[^>]*>Within 14 days\.<\/dd>/);
  });

  test('no FAQs, no section', () => {
    assert.equal(renderToStaticMarkup(<FaqSection title="FAQ" faqs={[]} />), '');
  });

  test('question text is escaped, never parsed as HTML', () => {
    const html = renderToStaticMarkup(
      <FaqSection title="FAQ" faqs={[{ question: '<img src=x onerror=alert(1)>', answer: 'a' }]} />,
    );
    assert.ok(!html.includes('<img'));
  });
});

type Graph = { '@graph': readonly Record<string, unknown>[] };

describe('category page structured data', () => {
  const itemList = { '@type': 'ItemList', itemListElement: [] };
  const input = (stored: unknown, data: Record<string, unknown> = { seo: { faqs } }) => ({
    category: 'productCategories' as const,
    seo: documentSeo({ data }),
    policy: parseSchemaPolicy(stored),
    url: `${SITE_URL}/shop/category/frames`,
    locale: 'en',
    facts: { name: 'Frames' },
    crumbs: [
      { name: 'Shop', path: '/shop' },
      { name: 'Frames', path: '/shop/category/frames' },
    ],
    extraNodes: [itemList],
  });

  test('a CollectionPage, the breadcrumbs, the product list and the FAQs as a FAQPage', () => {
    const graph = JSON.parse(documentStructuredData(input(null))!) as Graph;
    assert.deepEqual(
      graph['@graph'].map((n) => n['@type']).sort(),
      ['BreadcrumbList', 'CollectionPage', 'FAQPage', 'ItemList'],
    );
    const faq = graph['@graph'].find((n) => n['@type'] === 'FAQPage')!;
    assert.equal((faq.mainEntity as unknown[]).length, 2);
  });

  test('with FAQs switched off for product categories, no FAQPage is emitted', () => {
    const graph = JSON.parse(
      documentStructuredData(input({ categories: { productCategories: { appendFaq: false } } }))!,
    ) as Graph;
    assert.ok(!graph['@graph'].some((n) => n['@type'] === 'FAQPage'));
    assert.ok(graph['@graph'].some((n) => n['@type'] === 'ItemList'));
  });

  test('set to None, the category emits nothing at all', () => {
    assert.equal(documentStructuredData(input({ categories: { productCategories: { type: 'None' } } })), null);
  });
});

describe('the Organization lists the store locations', () => {
  const UUID = '0b6f0d4e-6a1e-4c55-9d47-1f3b2a9c8e11';
  const brand = resolveBrand(
    parseBrandIdentity({
      name: 'Acme Optics',
      legalName: '',
      tagline: '',
      email: '',
      phone: '+30 210 000 0000',
      address: { street: '1 Main St', city: 'Athens', postcode: '', country: 'GR' },
      socials: {},
      logoId: null,
      logoDarkId: null,
      faviconId: null,
      ogImageId: null,
      openingHours: [{ days: ['Mo'], opens: '09:00', closes: '17:00' }],
      locations: [
        {
          id: 'kifisia',
          name: 'Kifisia',
          address: { street: '5 Levidou', city: 'Kifisia', postcode: '', country: 'GR' },
          phone: '+30 210 111 1111',
          mapUrl: 'https://maps.google.com/?cid=1',
          imageId: UUID,
        },
      ],
    }),
    parsePalette(null),
  );

  test('each location is a department with a stable id and absolute image URL', () => {
    const org = organizationSchema(brand, { type: 'Optician', priceRange: '' }) as Record<string, unknown>;
    assert.equal((org.openingHoursSpecification as unknown[]).length, 1);
    const [dept] = org.department as Record<string, unknown>[];
    assert.equal(dept['@id'], `${SITE_URL}/#location-kifisia`);
    assert.equal(dept.telephone, '+302101111111');
    assert.equal(dept.image, `${SITE_URL}/api/cms/media/file/${UUID}`);
    assert.deepEqual(JSON.parse(JSON.stringify(dept.address)), {
      '@type': 'PostalAddress',
      streetAddress: '5 Levidou',
      addressLocality: 'Kifisia',
      addressCountry: 'GR',
    });
  });
});
