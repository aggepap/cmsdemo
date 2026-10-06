import 'server-only';

import { join } from 'node:path';

import { clamdTarget, scanWithClamd, type ClamdVerdict } from '../security/clamav';
import { getSetting } from '../settings';
import { createAttachmentStore, type AttachmentStore } from './attachment-store';
import {
  FORM_ATTACHMENT_ENABLED_KEY,
  FORM_ATTACHMENT_MAX_MB_KEY,
  FORM_ATTACHMENT_TYPES_KEY,
  readAttachmentPolicy,
  type AttachmentPolicy,
} from './attachments';
import {
  FORMS_RETENTION_DAYS_KEY,
  FORMS_SENSITIVE_RETENTION_DAYS_KEY,
  FORMS_SENSITIVE_TYPES_KEY,
  readFormsPolicy,
  type FormsPolicy,
} from './policy';

/**
 * The server side of form attachments (G-V2-01): the site's policy from
 * Settings → Forms, the private store, and the optional virus scan.
 *
 * `CMS_FORM_UPLOADS_DIR` defaults to `<cwd>/.data/form-uploads` — outside
 * `public/`, beside the transfer staging. Files there are only ever served by
 * the admin's permission-checked download route.
 */

let store: AttachmentStore | null = null;

export function getAttachmentStore(): AttachmentStore {
  store ??= createAttachmentStore({
    root: process.env.CMS_FORM_UPLOADS_DIR || join(process.cwd(), '.data', 'form-uploads'),
  });
  return store;
}

/** What the public forms accept right now, or `null` for no attachments. */
export async function formAttachmentPolicy(): Promise<AttachmentPolicy | null> {
  const [enabled, types, maxMb] = await Promise.all([
    getSetting(FORM_ATTACHMENT_ENABLED_KEY),
    getSetting(FORM_ATTACHMENT_TYPES_KEY),
    getSetting(FORM_ATTACHMENT_MAX_MB_KEY),
  ]);
  return readAttachmentPolicy(enabled, types, maxMb);
}

/** Retention and sensitive form types (Settings → Forms) — see `policy.ts`. */
export async function getFormsPolicy(): Promise<FormsPolicy> {
  const [retention, types, sensitiveRetention] = await Promise.all([
    getSetting(FORMS_RETENTION_DAYS_KEY),
    getSetting(FORMS_SENSITIVE_TYPES_KEY),
    getSetting(FORMS_SENSITIVE_RETENTION_DAYS_KEY),
  ]);
  return readFormsPolicy(retention, types, sensitiveRetention);
}

/** Scan with clamd when the server names one; `skipped` when it does not. */
export async function scanFormAttachment(bytes: Uint8Array): Promise<ClamdVerdict> {
  const target = clamdTarget();
  return target ? scanWithClamd(bytes, target) : { status: 'skipped' };
}
