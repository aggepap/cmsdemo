import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseRedirectCsv, REDIRECT_CSV_MAX_ROWS } from '@/cms/core/seo/redirect-csv';

/**
 * Reading a redirect list someone exported from the old site — typically a few
 * hundred WooCommerce URLs in a spreadsheet. The parser only reads; whether a row
 * is a valid redirect is decided by the same rules as the admin form.
 */

function rows(text: string) {
  const res = parseRedirectCsv(text);
  if (!res.ok) throw new Error(res.error);
  return res.rows;
}

describe('parseRedirectCsv', () => {
  test('reads source and target by position when there is no header', () => {
    assert.deepEqual(rows('/old,/new\n/a,/b'), [
      { line: 1, source: '/old', target: '/new', statusCode: '', notes: '' },
      { line: 2, source: '/a', target: '/b', statusCode: '', notes: '' },
    ]);
  });

  test('detects a header row and maps columns by name, in any order', () => {
    const out = rows('Notes,Target,Source,Status\nshoes,/shop/shoes,/product-category/shoes,302');
    assert.deepEqual(out, [
      { line: 2, source: '/product-category/shoes', target: '/shop/shoes', statusCode: '302', notes: 'shoes' },
    ]);
  });

  test('understands the usual header spellings', () => {
    assert.equal(rows('old url;new url\n/x;/y')[0].target, '/y');
    assert.equal(rows('from,to,code\n/x,/y,308')[0].statusCode, '308');
  });

  test('reads the optional status and notes columns by position', () => {
    assert.deepEqual(rows('/old,/new,302,from the old shop'), [
      { line: 1, source: '/old', target: '/new', statusCode: '302', notes: 'from the old shop' },
    ]);
  });

  test('accepts semicolon- and tab-separated files, as spreadsheets in Greek locales export them', () => {
    assert.equal(rows('/a;/b')[0].target, '/b');
    assert.equal(rows('/a\t/b')[0].target, '/b');
  });

  test('handles quotes, embedded commas, CRLF line ends and a byte-order mark', () => {
    const out = rows('﻿"/old,with,commas","/new ""quoted""",,"a, b"\r\n/x,/y\r\n');
    assert.equal(out[0].source, '/old,with,commas');
    assert.equal(out[0].target, '/new "quoted"');
    assert.equal(out[0].notes, 'a, b');
    assert.equal(out[1].source, '/x');
  });

  test('an empty target is kept as empty — that row becomes a pending mapping', () => {
    assert.deepEqual(rows('/old-product,'), [{ line: 1, source: '/old-product', target: '', statusCode: '', notes: '' }]);
    assert.equal(rows('/only-a-source')[0].target, '');
  });

  test('blank lines are skipped but line numbers still point at the file', () => {
    const out = rows('/a,/b\n\n   \n/c,/d');
    assert.deepEqual(
      out.map((r) => r.line),
      [1, 4],
    );
  });

  test('a full URL in the source column is reduced to its path, since only paths reach the site', () => {
    assert.equal(rows('https://old-shop.gr/product/blue-shirt/?ref=x,/shop/blue-shirt')[0].source, '/product/blue-shirt/');
  });

  test('a row without a source is kept, so it can be reported with its line number', () => {
    assert.equal(rows(',/somewhere')[0].source, '');
  });

  test('refuses a file with more rows than the limit, before anything is checked', () => {
    const text = Array.from({ length: REDIRECT_CSV_MAX_ROWS + 1 }, (_, i) => `/a${i},/b`).join('\n');
    const res = parseRedirectCsv(text);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /rows/);
  });

  test('refuses a file larger than the byte limit', () => {
    const res = parseRedirectCsv('/a,/b\n'.repeat(10), { maxBytes: 20 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /large/i);
  });

  test('refuses an empty file', () => {
    assert.equal(parseRedirectCsv('').ok, false);
    assert.equal(parseRedirectCsv('source,target\n').ok, false);
  });
});
