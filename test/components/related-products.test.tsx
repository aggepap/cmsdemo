import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { CompareProvider } from '@/components/shop/compare/CompareProvider';
import { RelatedProducts } from '@/components/shop/RelatedProducts';

import el from '../../messages/el.json';
import en from '../../messages/en.json';

/** The "You may also like" strip under a product. */

const product = (slug: string) => ({
  id: slug.length,
  slug,
  title: `Title ${slug}`,
  price: 10,
  currency: 'EUR',
  href: `/shop/${slug}`,
});

const render = (locale: 'el' | 'en', products: ReturnType<typeof product>[]) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'el' ? el : en} timeZone="UTC">
      <CompareProvider>
        <RelatedProducts products={products} locale={locale} />
      </CompareProvider>
    </NextIntlClientProvider>,
  );

describe('RelatedProducts', () => {
  test('a headed list of product cards, in order', () => {
    const html = render('en', [product('a'), product('bb')]);
    assert.match(html, /<h2[^>]*>You may also like<\/h2>/);
    assert.match(html, /<ul[\s\S]*Title a[\s\S]*Title bb[\s\S]*<\/ul>/);
  });

  test('the heading is Greek on the Greek site', () => {
    assert.match(render('el', [product('a')]), /<h2[^>]*>Ταιριάζει με<\/h2>/);
  });

  test('nothing at all when there is nothing to show', () => {
    assert.equal(render('en', []), '');
  });
});
