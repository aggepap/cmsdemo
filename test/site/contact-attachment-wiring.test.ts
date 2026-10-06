/**
 * The reference site's contact form uses the attachment hooks (G-V2-01).
 *
 * Site-owned files, so this lives under `test/site` rather than `test/core`:
 * `cms:update` copies core tests to every site, and a site that has not ported
 * the attachment field yet must not fail its suite for that.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('reference site', () => {
  test('the contact route hands the attachment hooks to the pipeline', () => {
    const route = read('src/app/api/contact/route.ts');
    assert.match(route, /attachments: \{/);
    assert.match(route, /formAttachmentPolicy\(\)/);
    assert.match(route, /scanFormAttachment\(/);
  });

  test('the contact page passes the policy to the form', () => {
    const page = read('src/app/[locale]/contact/page.tsx');
    assert.match(page, /formAttachmentPolicy\(\)/);
    assert.match(page, /attachment=\{/);
  });
});

describe('sensitive form types', () => {
  test('the contact route tells the pipeline which form types are sensitive', () => {
    const route = read('src/app/api/contact/route.ts');
    assert.match(route, /isSensitive: async/);
    assert.match(route, /isSensitiveFormType\(/);
  });
});
