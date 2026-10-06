import { createHash } from 'node:crypto';

/** The width of `audit_logs.subject_id`. */
export const AUDIT_SUBJECT_MAX = 64;

const DIGEST_PREFIX = 'sha256:';

/**
 * What an audit row stores as its subject, and what the login lockouts look it
 * up by.
 *
 * A subject longer than the column used to make the insert fail — and
 * `logAudit` swallows that — so a long email's failed logins were never
 * counted and the lockout never engaged. A short subject is kept as it is, so
 * the audit screen stays readable; a long one becomes a stable digest with no
 * `@`, which no real address can collide with. Pure, so it is unit-tested
 * (`test/cms/audit-subject.test.ts`).
 */
export function auditSubjectId(value: string): string {
  if (value.length <= AUDIT_SUBJECT_MAX) return value;
  const digest = createHash('sha256').update(value).digest('hex');
  return DIGEST_PREFIX + digest.slice(0, AUDIT_SUBJECT_MAX - DIGEST_PREFIX.length);
}
