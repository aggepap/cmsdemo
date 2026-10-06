import 'server-only';

import { z } from 'zod';

import { formStatusValues } from '../../db/adapters/mysql/schema/forms';
import { hasPerm, PERMISSIONS, requireApiPerm } from '../../modules/auth';
import { logAudit } from '../audit';
import { createRoute } from '../api/handler';
import { idParam } from '../api/params';
import { ok } from '../api/respond';
import { ApiError, notFound } from '../errors';
import { getAttachmentStore, getFormsPolicy } from '../forms/attachment-runtime';
import { attachmentDownloadHeaders, publicAttachment } from '../forms/attachments';
import { isSensitiveFormType, redactSubmission } from '../forms/policy';
import {
  deleteSubmission,
  getSubmission,
  listSubmissions,
  updateSubmission,
} from '../forms/service';

/** Whether this admin may read what sensitive form types hold (eyelike R3-25). */
const readsSensitive = (auth: { permissions: string[] }) =>
  hasPerm(auth.permissions, PERMISSIONS.formsSensitive);

/** One submission as this admin may see it: no storage key, and redacted when sensitive. */
async function viewable(
  row: NonNullable<Awaited<ReturnType<typeof getSubmission>>>,
  auth: { permissions: string[] }
) {
  return redactSubmission(
    { ...row, attachment: publicAttachment(row.attachment) },
    await getFormsPolicy(),
    readsSensitive(auth)
  );
}

const listQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  formType: z.string().max(64).optional(),
  status: z.enum(formStatusValues).optional(),
  search: z.string().max(200).optional(),
});

/** GET /api/cms/forms — paginated submissions + distinct types. */
export function submissionsListRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.formsRead),
    query: listQuery,
    handler: async ({ query, auth }) => {
      const [result, policy] = await Promise.all([listSubmissions(query ?? {}), getFormsPolicy()]);
      // A sensitive row keeps its place in the list, without its file name (PERMISSIONS.formsSensitive).
      return ok({
        ...result,
        items: result.items.map((i) => redactSubmission(i, policy, readsSensitive(auth))),
      });
    },
  });
}

/** GET /api/cms/forms/:id — one submission with its full payload. */
export function submissionGetRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.formsRead),
    handler: async ({ params, auth }) => {
      const row = await getSubmission(idParam(params.id));
      if (!row) throw notFound('Submission not found.');
      // Content of a sensitive form type only with PERMISSIONS.formsSensitive.
      return ok(await viewable(row, auth));
    },
  });
}

/**
 * GET /api/cms/forms/:id/attachment — the file a visitor attached (G-V2-01).
 *
 * Same permission as reading the submission, since the file is part of it.
 * Audited, because it is a stranger's document leaving the server. Always a
 * download with a sandboxing CSP — see `attachmentDownloadHeaders`.
 */
export function submissionAttachmentRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.formsRead),
    handler: async ({ params, auth }) => {
      const id = idParam(params.id);
      const row = await getSubmission(id);
      const record = row?.attachment ?? null;
      const file = publicAttachment(record);
      if (!row || !record || !file) throw notFound('This submission has no attachment.');
      // A sensitive form's file (a prescription photo) needs PERMISSIONS.formsSensitive.
      if (isSensitiveFormType(row.formType, await getFormsPolicy()) && !readsSensitive(auth)) {
        throw new ApiError('forbidden', 'This file belongs to a sensitive submission.');
      }
      const opened = await getAttachmentStore().open(record.key);
      if (!opened) throw notFound('The attached file is no longer on the server.');
      await logAudit({
        userId: auth.userId,
        action: 'submission.attachment.download',
        subjectType: 'form_submission',
        subjectId: id,
        after: { name: file.name, size: opened.size },
      });
      return new Response(opened.stream, {
        headers: attachmentDownloadHeaders({ ...file, size: opened.size }),
      });
    },
  });
}

const updateBody = z.object({
  status: z.enum(formStatusValues).optional(),
  notes: z.string().max(4000).nullish(),
});

/** PATCH /api/cms/forms/:id — triage (status / notes). */
export function submissionUpdateRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.formsWrite),
    input: updateBody,
    handler: async ({ params, input, auth }) => {
      const id = idParam(params.id);
      const before = await getSubmission(id);
      if (!before) throw notFound('Submission not found.');
      // Notes on a sensitive submission are hidden from whoever cannot read it,
      // so they may not overwrite them blind either. The status they may change.
      if (input.notes !== undefined && (await viewable(before, auth)).redacted) {
        throw new ApiError('forbidden', 'You cannot edit the notes of a sensitive submission.');
      }
      await updateSubmission(id, input);
      await logAudit({
        userId: auth.userId,
        action: 'submission.update',
        subjectType: 'form_submission',
        subjectId: id,
        after: input,
      });
      const after = await getSubmission(id);
      return ok(after && (await viewable(after, auth)));
    },
  });
}

/**
 * DELETE /api/cms/forms/:id — delete a submission and its file, for good
 * (an erasure request, or a sensitive one no longer needed). Its own
 * permission. The audit row says which submission and of what type, never
 * what it held.
 */
export function submissionDeleteRoute() {
  return createRoute({
    guard: () => requireApiPerm(PERMISSIONS.formsDelete),
    handler: async ({ params, auth }) => {
      const id = idParam(params.id);
      const deleted = await deleteSubmission(id);
      if (!deleted) throw notFound('Submission not found.');
      await logAudit({
        userId: auth.userId,
        action: 'submission.delete',
        subjectType: 'form_submission',
        subjectId: id,
        before: { formType: deleted.formType },
      });
      return ok({ id });
    },
  });
}
