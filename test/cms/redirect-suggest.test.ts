import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { suggestRedirectTarget } from '@/cms/core/seo/suggest-target';

/**
 * Where an old URL should most likely go on the new site.
 *
 * The 404 monitor's "→ redirect" used to send every missing path to the home
 * page — which search engines treat as a soft 404, so the old page's ranking is
 * lost anyway. A suggestion is only ever a proposal the admin confirms, and when
 * nothing fits the answer is "no suggestion", never "/".
 */

const KNOWN = [
  '/',
  '/about',
  '/blog',
  '/blog/summer-sale-2024',
  '/blog/categories/news',
  '/shop',
  '/shop/blue-cotton-shirt',
  '/shop/red-wool-scarf',
  '/shop/category/shirts',
  '/shop/category/accessories',
];

describe('suggestRedirectTarget', () => {
  test('the same path in different case or with a trailing slash is an exact match', () => {
    assert.deepEqual(suggestRedirectTarget('/About/', KNOWN), { target: '/about', reason: 'exact' });
  });

  test('an old WooCommerce product URL finds the product with the same slug', () => {
    assert.deepEqual(suggestRedirectTarget('/product/blue-cotton-shirt/', KNOWN), {
      target: '/shop/blue-cotton-shirt',
      reason: 'same-slug',
    });
  });

  test('an old product-category URL finds the category with the same slug', () => {
    assert.equal(suggestRedirectTarget('/product-category/shirts', KNOWN)?.target, '/shop/category/shirts');
  });

  test('a slightly different slug still finds the closest page', () => {
    assert.deepEqual(suggestRedirectTarget('/product/blue-cotton-shirt-2', KNOWN), {
      target: '/shop/blue-cotton-shirt',
      reason: 'similar-slug',
    });
  });

  test('old file-style URLs drop their extension before matching', () => {
    assert.equal(suggestRedirectTarget('/about.html', KNOWN)?.target, '/about');
  });

  test('when the page itself is gone, its parent category is proposed', () => {
    assert.deepEqual(suggestRedirectTarget('/product-category/accessories/hats-that-no-longer-exist', KNOWN), {
      target: '/shop/category/accessories',
      reason: 'parent',
    });
  });

  test('when nothing fits there is no suggestion — never the home page', () => {
    assert.equal(suggestRedirectTarget('/wp-login.php', KNOWN), null);
    assert.equal(suggestRedirectTarget('/completely/unrelated/thing', KNOWN), null);
    assert.equal(suggestRedirectTarget('/x', ['/']), null);
  });

  test('a path is never suggested as its own target', () => {
    assert.equal(suggestRedirectTarget('/shop/blue-cotton-shirt', ['/shop/blue-cotton-shirt']), null);
  });

  test('Greek slugs match whether percent-encoded or not, and regardless of accents', () => {
    const known = ['/shop/μπλε-πουκάμισο'];
    assert.equal(
      suggestRedirectTarget(`/product/${encodeURIComponent('μπλε-πουκαμισο')}`, known)?.target,
      '/shop/μπλε-πουκάμισο',
    );
  });

  test('a language prefix on the old path is kept on the suggestion', () => {
    assert.equal(
      suggestRedirectTarget('/en/product/red-wool-scarf', KNOWN, { localePrefixes: ['en'] })?.target,
      '/en/shop/red-wool-scarf',
    );
  });

  test('two equally good candidates are broken in favour of the one sharing more of the old path', () => {
    const known = ['/blog/shirts', '/shop/category/shirts'];
    assert.equal(suggestRedirectTarget('/shop-old/category/shirts', known)?.target, '/shop/category/shirts');
  });
});
