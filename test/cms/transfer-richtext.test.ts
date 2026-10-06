import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { collectRichTextRefs, rewriteRichText } from '@/cms/core/transfer/richtext';

/**
 * Rich text reaches other entities in three ways: the editor's structured
 * `shortcode` node, a paragraph that is exactly one typed shortcode, and a link
 * or image pointing at a media file. A popup is referenced by DOCUMENT ID, so it
 * has to be rewritten; scripts and review locations are referenced by slug, so
 * they only have to travel along.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const doc = {
  type: 'doc',
  content: [
    { type: 'shortcode', attrs: { name: 'popup', attrs: { id: '7' } } },
    { type: 'paragraph', content: [{ type: 'text', text: '[popup id="8"]' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '[script name="chat-widget"]' }] },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: '[google-reviews location="athens" limit="3"]' }],
    },
    { type: 'paragraph', content: [{ type: 'text', text: '[google-reviews location="all"]' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '[[popup id="9"]]' }] },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Prose [popup id="10"] inline is not a shortcode' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'download',
          marks: [{ type: 'link', attrs: { href: `/api/cms/media/file/${UUID_A}` } }],
        },
      ],
    },
  ],
};

describe('collectRichTextRefs', () => {
  test('finds popups by id, scripts and review locations by slug, and linked media', () => {
    const refs = collectRichTextRefs(doc, 'body').map((r) => `${r.kind}:${r.value}`);
    assert.deepEqual(refs.sort(), [
      'doc:7',
      'doc:8',
      `media:${UUID_A}`,
      'reviewLocation:athens',
      'script:chat-widget',
    ]);
  });

  test('a popup reference names the popup collection', () => {
    const popup = collectRichTextRefs(doc, 'body').find((r) => r.value === 7);
    assert.equal(popup?.collection, 'popup');
  });

  test('tolerates non-documents', () => {
    assert.deepEqual(collectRichTextRefs(null, 'x'), []);
    assert.deepEqual(collectRichTextRefs('text', 'x'), []);
  });
});

describe('video and map blocks name their preview image by media id', () => {
  const blocks = {
    type: 'doc',
    content: [
      {
        type: 'shortcode',
        attrs: { name: 'video', attrs: { url: 'https://youtu.be/x', title: 'T', image: UUID_A } },
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `[map image="${UUID_A}" title="Shop" address="Athens"]` }],
      },
    ],
  };

  test('the image travels with the page', () => {
    const refs = collectRichTextRefs(blocks, 'body').map((r) => `${r.kind}:${r.value}`);
    assert.deepEqual(refs, [`media:${UUID_A}`, `media:${UUID_A}`]);
  });

  test('and is rewritten to the id it has on this site', () => {
    const resolver = { doc: (id: number) => id, media: () => UUID_B };
    const out = rewriteRichText(blocks, resolver, 'body', []) as typeof blocks;
    assert.equal((out.content[0].attrs as { attrs: { image: string } }).attrs.image, UUID_B);
    assert.deepEqual(out.content[1].content, [
      { type: 'text', text: `[map image="${UUID_B}" title="Shop" address="Athens"]` },
    ]);
  });

  test('an image that did not travel is dropped, so the block renders nothing rather than a broken picture', () => {
    const dropped: unknown[] = [];
    const resolver = { doc: (id: number) => id, media: () => null };
    const out = rewriteRichText(blocks, resolver, 'body', dropped as never[]) as typeof blocks;
    assert.equal((out.content[0].attrs as { attrs: { image?: string } }).attrs.image, undefined);
    assert.equal(dropped.length, 2);
  });
});

describe('rewriteRichText', () => {
  const resolver = {
    doc: (id: number) => (id === 7 ? 70 : id === 8 ? null : id),
    media: (uuid: string) => (uuid === UUID_A ? UUID_B : uuid),
  };

  test('rewrites node and paragraph popup ids, linked media, and leaves escaped/inline text alone', () => {
    const dropped: unknown[] = [];
    const out = rewriteRichText(doc, resolver, 'body', dropped as never[]) as typeof doc;
    assert.deepEqual(out.content[0], {
      type: 'shortcode',
      attrs: { name: 'popup', attrs: { id: '70' } },
    });
    // Unresolved: the id is emptied so the shortcode renders nothing rather than a stranger's popup.
    assert.deepEqual(out.content[1].content, [{ type: 'text', text: '[popup]' }]);
    assert.deepEqual(out.content[5], doc.content[5]);
    assert.deepEqual(out.content[6], doc.content[6]);
    const link = (out.content[7].content?.[0] as { marks: Array<{ attrs: { href: string } }> })
      .marks[0];
    assert.equal(link.attrs.href, `/api/cms/media/file/${UUID_B}`);
    assert.equal(dropped.length, 1);
  });
});
