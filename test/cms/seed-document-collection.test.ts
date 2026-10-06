/**
 * `applySeedDocument` validates against the collection the admin uses (F-002).
 *
 * The SEO/AEO group (`data.seo`) and admin custom fields (`data.custom`) are added
 * to a collection at runtime. Writing with the bare config collection validated
 * the seed against a field set without them, so a seeded answer summary, key
 * facts, FAQ or custom field was dropped without a word. Sites had to bypass the
 * helper to keep them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const src = readFileSync(new URL('../../src/cms/db/seeds/documents.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*/g, '');
const body = src.slice(src.indexOf('export async function applySeedDocument'));

describe('applySeedDocument', () => {
  test('resolves the collection with its runtime fields', () => {
    assert.match(body, /resolveCollectionWithCustomFields\(config, type/);
  });

  test('creates and updates with that collection', () => {
    assert.match(body, /createDocument\(config, type, input, null, \{ collection \}\)/);
    assert.match(body, /updateDocument\(config, existing\.id, input, null, \{ collection \}\)/);
  });
});
