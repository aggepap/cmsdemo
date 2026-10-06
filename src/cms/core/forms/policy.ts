/**
 * How long submissions are kept, and which form types are sensitive
 * (eyelike R3-25) — the rules, with no I/O.
 *
 * Settings → Forms:
 * - `forms.retentionDays`: submissions older than this are deleted, with any
 *   attached file, by the `forms-retention` job. Blank keeps them for ever.
 * - `forms.sensitiveTypes`: form types (as Submissions → Type shows them) whose
 *   content only `cms.forms.sensitive` may read — a prescription is health data.
 * - `forms.sensitiveRetentionDays`: their own, usually shorter, period. Blank
 *   follows `forms.retentionDays`.
 *
 * A leaf, like `attachments.ts`: the settings schema declares its fields from
 * these constants.
 */

export const FORMS_RETENTION_DAYS_KEY = 'forms.retentionDays';
export const FORMS_SENSITIVE_TYPES_KEY = 'forms.sensitiveTypes';
export const FORMS_SENSITIVE_RETENTION_DAYS_KEY = 'forms.sensitiveRetentionDays';

const DAY_MS = 86_400_000;

export interface FormsPolicy {
  /** Whole days, or null for "keep for ever". */
  retentionDays: number | null;
  /** Lower-case form types whose content is sensitive. */
  sensitiveTypes: string[];
  sensitiveRetentionDays: number | null;
}

/** Whole positive days, or null. Anything else — blank, 0, a typo — keeps. */
function days(raw: unknown): number | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)
        ? Number(raw)
        : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function readFormsPolicy(
  rawRetention: unknown,
  rawSensitiveTypes: unknown,
  rawSensitiveRetention: unknown
): FormsPolicy {
  const types =
    typeof rawSensitiveTypes === 'string'
      ? rawSensitiveTypes
          .split(/[\n,]+/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      : [];
  return {
    retentionDays: days(rawRetention),
    sensitiveTypes: [...new Set(types)],
    sensitiveRetentionDays: days(rawSensitiveRetention),
  };
}

export function isSensitiveFormType(formType: string, policy: FormsPolicy): boolean {
  return policy.sensitiveTypes.includes(formType.trim().toLowerCase());
}

/**
 * Rows created before these moments are due for deletion: `general` for every
 * form type that is not sensitive, `sensitive` for those that are. Null means
 * keep.
 */
export function retentionCutoffs(
  policy: FormsPolicy,
  now: Date
): { general: Date | null; sensitive: Date | null } {
  const at = (d: number | null) => (d === null ? null : new Date(now.getTime() - d * DAY_MS));
  return {
    general: at(policy.retentionDays),
    sensitive: at(policy.sensitiveRetentionDays ?? policy.retentionDays),
  };
}

/**
 * A submission as a viewer may see it. A sensitive one, for someone without
 * `cms.forms.sensitive`, keeps what is needed to know someone wrote and to
 * reply — type, email, dates, status — and loses its content, its file and the
 * team's notes about it (which tend to repeat the content).
 */
export function redactSubmission<
  T extends { formType: string; attachment?: unknown; payload?: unknown; notes?: unknown },
>(row: T, policy: FormsPolicy, canReadSensitive: boolean): T & { redacted: boolean } {
  if (canReadSensitive || !isSensitiveFormType(row.formType, policy))
    return { ...row, redacted: false };
  const out: T & { redacted: boolean } = { ...row, attachment: null, redacted: true };
  if ('payload' in row) (out as Record<string, unknown>).payload = {};
  if ('notes' in row) (out as Record<string, unknown>).notes = null;
  return out;
}
