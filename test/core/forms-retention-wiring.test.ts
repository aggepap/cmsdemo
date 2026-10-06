/**
 * Deleting submissions, keeping them only so long, and hiding sensitive ones
 * (eyelike R3-25) — the wiring. The rules are in `test/cms/forms-policy.test.ts`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  FORMS_RETENTION_DAYS_KEY,
  FORMS_SENSITIVE_RETENTION_DAYS_KEY,
  FORMS_SENSITIVE_TYPES_KEY,
} from '@/cms/core/forms/policy';
import { MANAGED_SETTINGS } from '@/cms/core/settings/schema';
import { DEFAULT_ROLES } from '@/cms/db/seeds/roles';
import { permissionDescription, permissionLabel } from '@/cms/modules/auth/permission-labels';
import { PERMISSIONS } from '@/cms/modules/auth/permissions';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function fnBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = text.indexOf('\nexport ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

describe('permissions', () => {
  test('reading sensitive submissions and deleting submissions are their own permissions', () => {
    assert.equal(PERMISSIONS.formsSensitive, 'cms.forms.sensitive');
    assert.equal(PERMISSIONS.formsDelete, 'cms.forms.delete');
    for (const key of ['cms.forms.sensitive', 'cms.forms.delete']) {
      assert.ok(permissionDescription(key), key);
      // A mapped verb ("Delete form submissions"), not the raw key segment.
      assert.match(permissionLabel(key), /^[A-Z]/, key);
    }
  });

  test('the editor role gets neither', () => {
    const editor = DEFAULT_ROLES.find((r) => r.name === 'editor');
    assert.ok(editor);
    assert.ok(!editor.permissions.includes(PERMISSIONS.formsSensitive));
    assert.ok(!editor.permissions.includes(PERMISSIONS.formsDelete));
  });
});

describe('settings', () => {
  test('retention and sensitive types live under Forms', () => {
    for (const key of [
      FORMS_RETENTION_DAYS_KEY,
      FORMS_SENSITIVE_TYPES_KEY,
      FORMS_SENSITIVE_RETENTION_DAYS_KEY,
    ]) {
      const field = MANAGED_SETTINGS.find((f) => f.key === key);
      assert.equal(field?.group, 'Forms', key);
    }
  });
});

describe('the retention job', () => {
  test('is registered as forms-retention', () => {
    const route = read('src/app/api/cms/cron/[job]/route.ts');
    assert.match(route, /'forms-retention': \{ run: purgeExpiredSubmissions \}/);
  });

  test('deletes the attached files with the rows', () => {
    const service = read('src/cms/core/forms/service.ts');
    const body = fnBody(service, 'purgeExpiredSubmissions');
    assert.match(body, /retentionCutoffs\(/);
    assert.match(body, /\.remove\(/);
  });
});

describe('the admin API', () => {
  const routes = read('src/cms/core/routes/forms.ts');

  test('DELETE /api/cms/forms/:id needs cms.forms.delete and is audited without the content', () => {
    assert.match(
      read('src/app/api/cms/forms/[id]/route.ts'),
      /export const DELETE = submissionDeleteRoute\(\)/
    );
    const body = fnBody(routes, 'submissionDeleteRoute');
    assert.match(body, /requireApiPerm\(PERMISSIONS\.formsDelete\)/);
    assert.match(body, /logAudit\(/);
    assert.doesNotMatch(body, /payload/);
  });

  test('the list, the detail and the download respect the sensitive permission', () => {
    for (const name of [
      'submissionsListRoute',
      'submissionGetRoute',
      'submissionAttachmentRoute',
    ]) {
      assert.match(fnBody(routes, name), /formsSensitive/, name);
    }
  });

  test('the admin page redacts its first, server-rendered page too', () => {
    assert.match(read('src/app/admin/(shell)/submissions/page.tsx'), /redactSubmission\(/);
  });

  test('the drawer offers Delete and says when content is hidden', () => {
    const table = read('src/cms/admin/SubmissionsTable.tsx');
    assert.match(table, /deleteSubmission/);
    assert.match(table, /redacted/);
    assert.ok(existsSync(join(process.cwd(), 'src/cms/admin/api-client.ts')));
    assert.match(read('src/cms/admin/api-client.ts'), /deleteSubmission/);
  });
});
