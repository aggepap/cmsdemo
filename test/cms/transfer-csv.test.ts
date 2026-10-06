import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { csvCell, csvRow } from '@/cms/core/csv';

describe('csvCell', () => {
  test('quotes and escapes', () => {
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(3), '"3"');
  });

  test('neutralises formula triggers, including behind leading whitespace', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('\t+1'), `"'+1"`);
    assert.equal(csvCell('-2'), `"'-2"`);
    assert.equal(csvCell('@a'), `"'@a"`);
  });

  test('csvRow joins cells', () => {
    assert.equal(csvRow(['a', 1]), '"a","1"');
  });

  test('the orders export uses the shared helper', () => {
    const src = readFileSync('src/cms/modules/commerce/orders.ts', 'utf8');
    assert.match(src, /from '\.\.\/\.\.\/core\/csv'/);
    assert.doesNotMatch(src, /const csvCell =/);
  });
});
