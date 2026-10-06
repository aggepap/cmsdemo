/**
 * How the contact-form attachment is wired through the app (G-V2-01).
 *
 * The pieces that need a database or a running server are pinned by their
 * shape here: the download is behind `cms.forms.read` and audited, the storage
 * key never reaches the browser, the settings exist, the column has a migration,
 * and the files go outside public/. The reference site's wiring is checked in
 * `test/site/contact-attachment-wiring.test.ts` — this file is copied to every
 * site by `cms:update`, and a site's own contact form is its own business.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  FORM_ATTACHMENT_ENABLED_KEY,
  FORM_ATTACHMENT_MAX_MB_KEY,
  FORM_ATTACHMENT_TYPES_KEY,
  publicAttachment,
} from '@/cms/core/forms/attachments';
import { MANAGED_SETTINGS } from '@/cms/core/settings/schema';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('download route', () => {
  test('the admin API serves the file at /api/cms/forms/:id/attachment', () => {
    const path = 'src/app/api/cms/forms/[id]/attachment/route.ts';
    assert.ok(existsSync(join(process.cwd(), path)));
    assert.match(read(path), /export const GET = submissionAttachmentRoute\(\)/);
  });

  test('it needs the read permission for submissions and is audited', () => {
    const src = read('src/cms/core/routes/forms.ts');
    const at = src.indexOf('export function submissionAttachmentRoute');
    assert.ok(at > -1);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.match(body, /requireApiPerm\(PERMISSIONS\.formsRead\)/);
    assert.match(body, /logAudit\(/);
    assert.match(body, /attachmentDownloadHeaders\(/);
  });
});

describe('what the admin API returns', () => {
  test('the storage key is stripped from the attachment record', () => {
    assert.deepEqual(
      publicAttachment({ key: 'k', name: 'a.pdf', size: 3, type: 'application/pdf' }),
      {
        name: 'a.pdf',
        size: 3,
        type: 'application/pdf',
      }
    );
    assert.equal(publicAttachment(null), null);
    assert.equal(publicAttachment('junk'), null);
  });

  test('list and detail both go through publicAttachment', () => {
    const service = read('src/cms/core/forms/service.ts');
    assert.match(service, /publicAttachment\(/);
    const routes = read('src/cms/core/routes/forms.ts');
    assert.match(routes, /publicAttachment\(/);
  });

  test('the admin list and drawer link to the download', () => {
    const table = read('src/cms/admin/SubmissionsTable.tsx');
    assert.match(table, /\/api\/cms\/forms\/\$\{[^}]+\}\/attachment/);
  });
});

describe('settings', () => {
  test('a switch, types and size live under Forms; off by default, PDF up to 10 MB', () => {
    const enabled = MANAGED_SETTINGS.find((f) => f.key === FORM_ATTACHMENT_ENABLED_KEY);
    const types = MANAGED_SETTINGS.find((f) => f.key === FORM_ATTACHMENT_TYPES_KEY);
    const size = MANAGED_SETTINGS.find((f) => f.key === FORM_ATTACHMENT_MAX_MB_KEY);
    assert.equal(enabled?.type, 'boolean');
    assert.equal(enabled?.defaultValue, 'off');
    for (const f of [enabled, types, size]) assert.equal(f?.group, 'Forms');
    assert.equal(types?.type, 'multiselect');
    assert.equal(types?.defaultValue, 'pdf');
    assert.deepEqual(
      types?.options?.map((o) => o.value),
      ['pdf', 'docx', 'xlsx', 'jpg', 'png']
    );
    assert.equal(size?.type, 'select');
    assert.equal(size?.defaultValue, '10');
  });
});

describe('database', () => {
  test('form_submissions has a nullable attachment column, with a migration', () => {
    assert.match(
      read('src/cms/db/adapters/mysql/schema/forms.ts'),
      /attachment: json\('attachment'\)/
    );
    const dir = 'src/cms/db/adapters/mysql/migrations';
    const sql = readdirSync(join(process.cwd(), dir))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => read(`${dir}/${f}`))
      .join('\n');
    assert.match(sql, /ALTER TABLE `form_submissions` ADD `attachment` json;/);
  });
});

describe('storage', () => {
  test('uploads are stored outside public/', () => {
    const runtime = read('src/cms/core/forms/attachment-runtime.ts');
    assert.match(runtime, /CMS_FORM_UPLOADS_DIR/);
    assert.match(runtime, /'\.data', 'form-uploads'/);
  });
});
