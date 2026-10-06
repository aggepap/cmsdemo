import 'server-only';

import { and, desc, eq, inArray, like, lt, notInArray, or, sql } from 'drizzle-orm';

import { getDb, schema } from '../../db';
import { likeTerm } from '../db/like';
import { publicAttachment, type AttachmentRecord, type PublicAttachment } from './attachments';
import { getAttachmentStore, getFormsPolicy } from './attachment-runtime';
import { retentionCutoffs } from './policy';
import { type FormStatus, type FormSubmission } from '../../db/adapters/mysql/schema/forms';

/** List row — everything except the heavy `payload` JSON. */
export interface SubmissionSummary {
  id: number;
  formType: string;
  email: string;
  status: FormStatus;
  emailStatus: string;
  sourcePageSlug: string | null;
  sourceLocale: string | null;
  /** The attached file's name, size and type — never its storage key. */
  attachment: PublicAttachment | null;
  createdAt: Date;
}

export interface ListSubmissionsOptions {
  formType?: string;
  status?: FormStatus;
  /** Substring match against email + source slug. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ListSubmissionsResult {
  items: SubmissionSummary[];
  page: number;
  pageSize: number;
  total: number;
  /** Distinct form types present (for the filter dropdown). */
  types: string[];
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export async function listSubmissions(
  opts: ListSubmissionsOptions = {}
): Promise<ListSubmissionsResult> {
  const db = getDb();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));

  const conditions = [];
  if (opts.formType) conditions.push(eq(schema.formSubmissions.formType, opts.formType));
  if (opts.status) conditions.push(eq(schema.formSubmissions.status, opts.status));
  if (opts.search) {
    const term = likeTerm(opts.search);
    const match = or(
      like(schema.formSubmissions.email, term),
      like(schema.formSubmissions.sourcePageSlug, term)
    );
    if (match) conditions.push(match);
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.formSubmissions)
    .where(where);

  const items = await db
    .select({
      id: schema.formSubmissions.id,
      formType: schema.formSubmissions.formType,
      email: schema.formSubmissions.email,
      status: schema.formSubmissions.status,
      emailStatus: schema.formSubmissions.emailStatus,
      sourcePageSlug: schema.formSubmissions.sourcePageSlug,
      sourceLocale: schema.formSubmissions.sourceLocale,
      attachment: schema.formSubmissions.attachment,
      createdAt: schema.formSubmissions.createdAt,
    })
    .from(schema.formSubmissions)
    .where(where)
    .orderBy(desc(schema.formSubmissions.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const typeRows = await db
    .selectDistinct({ formType: schema.formSubmissions.formType })
    .from(schema.formSubmissions);

  return {
    items: items.map((row) => ({ ...row, attachment: publicAttachment(row.attachment) })),
    page,
    pageSize,
    total: Number(total),
    types: typeRows.map((r) => r.formType).sort(),
  };
}

export interface NewSubmissionInput {
  formType: string;
  email: string;
  payload: Record<string, unknown>;
  sourcePageSlug?: string | null;
  sourceLocale?: string | null;
  referrerUrl?: string | null;
  ua?: string | null;
  /** A file already checked and saved by `attachment-runtime` (G-V2-01). */
  attachment?: AttachmentRecord | null;
}

/**
 * Record a public form submission, before anything is emailed about it.
 *
 * The table had a reader and no writer for the site's own contact forms: they only
 * sent an email, so every enquiry lived solely in whatever inbox that landed in and
 * `/admin/submissions` could never show anything at all (F-064). `email_status` and
 * `email_error` were already on the table for exactly this — the row is the record,
 * the notification is a side effect that may fail.
 *
 * The two long columns are truncated rather than allowed to fail the insert: losing
 * an enquiry because a browser sent a 600-character referrer would be absurd.
 */
export async function createSubmission(input: NewSubmissionInput): Promise<number> {
  const db = getDb();
  const [res] = await db.insert(schema.formSubmissions).values({
    formType: input.formType,
    email: input.email,
    payload: input.payload,
    sourcePageSlug: input.sourcePageSlug ?? null,
    sourceLocale: input.sourceLocale ?? null,
    referrerUrl: input.referrerUrl?.slice(0, 512) ?? null,
    ua: input.ua?.slice(0, 255) ?? null,
    attachment: input.attachment ?? null,
    emailStatus: 'pending',
  });
  return Number((res as { insertId: number | string }).insertId);
}

/**
 * Claim the right to send this submission's notification, exactly once.
 *
 * A conditional update — `pending` → `sent` — so two requests racing for the
 * same row cannot both win: MySQL applies them in order and the second matches
 * no rows. Returns whether this caller is the one that should send.
 *
 * The kiosk questionnaire needs this because its notification is triggered by a
 * human tapping a button on a tablet, and a laggy tap is a double tap. Nothing
 * else about the flow would stop that from mailing the team twice.
 *
 * The status is set BEFORE the send rather than after, which is the trade-off:
 * a process killed mid-send leaves a row claiming `sent` that never went. A
 * send that merely fails is corrected by `markSubmissionUndelivered`, and a
 * duplicate notification is the more likely and more annoying failure of the
 * two. `email_status` has no `sending` value to use instead and adding one
 * would mean a migration for a state nothing reads.
 */
export async function claimSubmissionNotification(id: number): Promise<boolean> {
  const [res] = await getDb()
    .update(schema.formSubmissions)
    .set({ emailStatus: 'sent', emailError: null })
    .where(
      and(eq(schema.formSubmissions.id, id), eq(schema.formSubmissions.emailStatus, 'pending'))
    );
  return Number((res as { affectedRows: number }).affectedRows) > 0;
}

/** The notification went out. */
export async function markSubmissionDelivered(id: number): Promise<void> {
  await getDb()
    .update(schema.formSubmissions)
    .set({ emailStatus: 'sent', emailError: null })
    .where(eq(schema.formSubmissions.id, id));
}

/**
 * The notification did not go out — recorded on the row, not swallowed.
 *
 * Someone wrote in and nobody was told. That has to be visible on the submissions
 * screen, or the enquiry sits there looking handled while no reply is coming.
 */
export async function markSubmissionUndelivered(id: number, err: unknown): Promise<void> {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  await getDb()
    .update(schema.formSubmissions)
    .set({ emailStatus: 'failed', emailError: reason.slice(0, 1000) })
    .where(eq(schema.formSubmissions.id, id));
}

/**
 * Merge extra fields into a submission's stored `payload`.
 *
 * The kiosk questionnaire is written in two passes — the exhibitor's answers
 * when they tap submit, the PRAION team's own notes a minute later — and the
 * second pass has to land somewhere a colleague will actually read.
 *
 * Not `notes`: that column is the triager's own editable textarea on the
 * submissions drawer, so a later "Save notes" would silently overwrite the
 * team's write-up of the conversation. `payload` is rendered read-only and
 * properly labelled by `PayloadView`.
 *
 * Read-modify-write rather than a blind replace — `payload` is a whole-column
 * JSON write, so composing the merge here is what stops the second pass from
 * discarding the first. Returns false when the row has gone, rather than
 * throwing: the caller still has an email to send.
 */
export async function appendSubmissionPayload(
  id: number,
  patch: Record<string, unknown>
): Promise<boolean> {
  const db = getDb();
  const existing = await getSubmission(id);
  if (!existing) return false;
  await db
    .update(schema.formSubmissions)
    .set({ payload: { ...existing.payload, ...patch } })
    .where(eq(schema.formSubmissions.id, id));
  return true;
}

export async function getSubmission(id: number): Promise<FormSubmission | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.formSubmissions)
    .where(eq(schema.formSubmissions.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateSubmission(
  id: number,
  patch: { status?: FormStatus; notes?: string | null }
): Promise<void> {
  const db = getDb();
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (Object.keys(set).length === 0) return;
  await db.update(schema.formSubmissions).set(set).where(eq(schema.formSubmissions.id, id));
}

/**
 * Delete one submission and its attached file, for good. Returns false when
 * there was nothing to delete. The row goes first: a file left behind by a
 * failed unlink is unreachable, a row pointing at a deleted file is not.
 */
export async function deleteSubmission(id: number): Promise<{ formType: string } | false> {
  const row = await getSubmission(id);
  if (!row) return false;
  await getDb().delete(schema.formSubmissions).where(eq(schema.formSubmissions.id, id));
  if (row.attachment?.key) {
    await getAttachmentStore()
      .remove(row.attachment.key)
      .catch((err: unknown) => console.error('[cms/forms] attachment unlink failed', { id, err }));
  }
  return { formType: row.formType };
}

/** Rows deleted per round — bounded, so a first run on years of data is not one huge statement. */
const PURGE_BATCH = 500;

/**
 * The `forms-retention` job (Settings → Forms): delete every submission older
 * than its form type's retention period, with its attached file.
 */
export async function purgeExpiredSubmissions(
  now: Date = new Date()
): Promise<{ removed: number; files: number }> {
  const policy = await getFormsPolicy();
  const cutoffs = retentionCutoffs(policy, now);
  const t = schema.formSubmissions;
  const due = [];
  if (cutoffs.general) {
    due.push(
      policy.sensitiveTypes.length
        ? and(
            lt(t.createdAt, cutoffs.general),
            notInArray(sql`lower(${t.formType})`, policy.sensitiveTypes)
          )
        : lt(t.createdAt, cutoffs.general)
    );
  }
  if (cutoffs.sensitive && policy.sensitiveTypes.length) {
    due.push(
      and(
        lt(t.createdAt, cutoffs.sensitive),
        inArray(sql`lower(${t.formType})`, policy.sensitiveTypes)
      )
    );
  }
  if (due.length === 0) return { removed: 0, files: 0 };

  const db = getDb();
  const store = getAttachmentStore();
  let removed = 0;
  let files = 0;
  for (;;) {
    const rows = await db
      .select({ id: t.id, attachment: t.attachment })
      .from(t)
      .where(or(...due))
      .limit(PURGE_BATCH);
    if (rows.length === 0) break;
    await db.delete(t).where(
      inArray(
        t.id,
        rows.map((r) => r.id)
      )
    );
    removed += rows.length;
    for (const row of rows) {
      if (!row.attachment?.key) continue;
      await store.remove(row.attachment.key).catch((err: unknown) => {
        console.error('[cms/forms] attachment unlink failed', { id: row.id, err });
      });
      files += 1;
    }
    if (rows.length < PURGE_BATCH) break;
  }
  return { removed, files };
}
