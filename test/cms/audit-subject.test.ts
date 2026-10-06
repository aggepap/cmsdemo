/**
 * `audit_logs.subject_id` holds 64 characters, and the login lockouts count
 * failures by the email in that column. A longer address made the failure row
 * fail to write — `logAudit` swallows the error — so the count never moved and
 * that account could be guessed at without limit. Every subject is now stored
 * and looked up through one key that always fits.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { AUDIT_SUBJECT_MAX, auditSubjectId } from '@/cms/core/audit-subject';

describe('auditSubjectId', () => {
  test('a short subject is stored as it is, so the audit screen stays readable', () => {
    assert.equal(auditSubjectId('admin@example.com'), 'admin@example.com');
    assert.equal(auditSubjectId('x'.repeat(AUDIT_SUBJECT_MAX)), 'x'.repeat(AUDIT_SUBJECT_MAX));
  });

  test('a longer one becomes a stable digest that fits the column', () => {
    const long = `${'a'.repeat(80)}@example.com`;
    const key = auditSubjectId(long);
    assert.ok(key.length <= AUDIT_SUBJECT_MAX);
    assert.equal(key, auditSubjectId(long));
    assert.notEqual(key, auditSubjectId(`${'b'.repeat(80)}@example.com`));
    // No `@`: a digest can never be mistaken for, or collide with, a real address.
    assert.equal(key.includes('@'), false);
  });

  test('keying twice changes nothing', () => {
    const key = auditSubjectId(`${'a'.repeat(80)}@example.com`);
    assert.equal(auditSubjectId(key), key);
  });
});

test('logAudit writes, and the lockout counts read, the same key', () => {
  const audit = readFileSync(new URL('../../src/cms/core/audit.ts', import.meta.url), 'utf8');
  assert.match(audit, /auditSubjectId\(String\(entry\.subjectId\)\)/);
  assert.match(audit, /eq\(schema\.auditLogs\.subjectId, auditSubjectId\(email\)\)/);
});
