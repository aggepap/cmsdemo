import '../setup/react-global'; // must precede any component import

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RichTextToolbar } from '@/cms/admin/fields/RichTextEditor';
import { RichText } from '@/components/cms/RichText';

/**
 * Tables in rich text (F-002).
 *
 * Seeded pages carry TipTap `table` nodes (cancellation 10/30/100%, flight times),
 * but the editor had only StarterKit + Link. TipTap drops a node type its schema
 * does not know, so opening such a page in the admin and saving it deleted the
 * table. The editor and the public renderer must both know the four node types.
 */

const cell = (type: 'tableHeader' | 'tableCell', text: string, attrs?: Record<string, unknown>) => ({
  type,
  ...(attrs ? { attrs } : {}),
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const doc = {
  type: 'doc',
  content: [
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Notice'), cell('tableHeader', 'Refund')] },
        { type: 'tableRow', content: [cell('tableCell', '48 h'), cell('tableCell', '100%')] },
        { type: 'tableRow', content: [cell('tableCell', 'Late', { colspan: 2, rowspan: 1 })] },
      ],
    },
  ],
};

describe('RichText renders tables', () => {
  const html = renderToStaticMarkup(<RichText value={doc} />);

  test('as a real table with header cells and body cells', () => {
    assert.match(html, /<table[\s>]/);
    assert.match(html, /<th[^>]*>.*Notice.*<\/th>/);
    assert.match(html, /<td[^>]*>.*100%.*<\/td>/);
    assert.equal((html.match(/<tr[\s>]/g) ?? []).length, 3);
  });

  test('header cells are column headers for assistive technology', () => {
    assert.match(html, /<th[^>]*scope="col"/);
  });

  test('a merged cell keeps its span', () => {
    assert.match(html, /<td[^>]*colSpan="2"|<td[^>]*colspan="2"/);
  });

  test('a wide table scrolls inside its own box instead of the page', () => {
    assert.match(html, /<div[^>]*overflow-x-auto[^>]*><table/);
  });

  test('a crafted span cannot be absurd', () => {
    const crafted = renderToStaticMarkup(
      <RichText
        value={{
          type: 'doc',
          content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('tableCell', 'x', { colspan: 99999, rowspan: -4 })] }] }],
        }}
      />,
    );
    assert.doesNotMatch(crafted, /99999/);
    assert.doesNotMatch(crafted, /rowspan="-4"|rowSpan="-4"/i);
  });
});

describe('the admin editor knows the table nodes', () => {
  const src = readFileSync(new URL('../../src/cms/admin/fields/RichTextEditor.tsx', import.meta.url), 'utf8');

  test('registers the table extensions alongside StarterKit', () => {
    assert.match(src, /from '@tiptap\/extension-table'/);
    assert.match(src, /\[StarterKit[^\]]*\bTable\b[^\]]*\bTableRow\b[^\]]*\bTableHeader\b[^\]]*\bTableCell\b/);
    assert.match(src, /extensions: EXTENSIONS/);
  });

  test('offers a toolbar control to insert a table', () => {
    assert.match(src, /insertTable\(/);
  });
});

describe('the table controls in the toolbar', () => {
  const render = (inTable: boolean) =>
    renderToStaticMarkup(
      <RichTextToolbar isActive={() => false} inTable={inTable} onTool={() => {}} onInsertBlock={() => {}} />,
    );

  test('an Insert table button is always there', () => {
    assert.match(render(false), /aria-label="Insert table"/);
  });

  test('row and column controls appear only with the cursor in a table', () => {
    for (const label of ['Add row below', 'Add column right', 'Delete row', 'Delete column', 'Delete table']) {
      assert.match(render(true), new RegExp(`aria-label="${label}"`), label);
      assert.doesNotMatch(render(false), new RegExp(`aria-label="${label}"`), label);
    }
  });
});
