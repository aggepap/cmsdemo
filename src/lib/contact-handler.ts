/**
 * The public contact endpoint's pipeline, with its I/O passed in.
 *
 * Lives outside `src/app/api/contact/route.ts` because a route module may only
 * export handlers, and the ORDER of these steps is the thing worth testing:
 *
 *   origin/content-type → rate limit → size → schema → honeypot → captcha → store → send
 *
 * Every refusal before the captcha is cheap and local, so junk never turns into
 * a call to Google. A rejected captcha stores nothing and sends nothing.
 *
 * With a file attached (G-V2-01) the body is `multipart/form-data` — the same
 * fields as JSON in a `payload` part, the file in `attachment` — accepted only
 * while `deps.attachments` says the site allows it. After the captcha:
 *
 *   check the bytes → per-IP attachment limit → scan → save → store → send
 *
 * so nothing reaches the disk or the scanner until every cheaper check passed.
 */
import { z } from 'zod';

import {
  checkAttachment,
  formatAttachmentSize,
  type AttachmentPolicy,
  type AttachmentRecord,
} from '@/cms/core/forms/attachments';
import type { NewSubmissionInput } from '@/cms/core/forms/service';
import type { CaptchaResult } from '@/cms/core/security/captcha';
import type { ClamdVerdict } from '@/cms/core/security/clamav';
import { contactSubmissionRecord } from '@/lib/contact-submission';
import type { Row } from '@/lib/email/rows';

/** Where the token travels. Mirrors `CAPTCHA_HEADER`, which is server-only. */
const CAPTCHA_HEADER = 'x-captcha-token';

const contactSchema = z.object({
  kind: z.literal('contact'),
  locale: z.enum(['el', 'en']).optional(),
  _hp: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  /** Length-capped only: numbers arrive in every format. */
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  message: z.string().trim().min(1).max(4000),
});

/**
 * To add a second form, add a schema to this union, a kind to
 * `ContactFormKind` in `contact-submission.ts`, and a case to `describe` below.
 */
const payloadSchema = z.discriminatedUnion('kind', [contactSchema]);

export type ContactPayload = z.infer<typeof payloadSchema>;

/** Hard cap on the body. Checked on the bytes actually read, not only the header. */
export const CONTACT_MAX_BODY_BYTES = 16 * 1024;

/** Room for the multipart boundaries and part headers around the file. */
const MULTIPART_OVERHEAD_BYTES = 8 * 1024;

export interface ContactRateLimit {
  allowed: boolean;
  retryAfterSeconds: number;
  resetAt: number;
  max: number;
}

export interface ContactNotification {
  data: ContactPayload;
  subject: string;
  rows: Row[];
}

export interface ContactDeps {
  originAllowed(origin: string | null): boolean;
  rateLimit(request: Request): ContactRateLimit;
  /** Whether the public forms currently require a captcha (setting + keys). */
  captchaRequired(): Promise<boolean>;
  verifyCaptcha(token: string | null): Promise<CaptchaResult>;
  /** Stores the submission; `null` when storage failed (the email still goes). */
  store(record: NewSubmissionInput): Promise<number | null>;
  send(notification: ContactNotification): Promise<void>;
  markDelivered(id: number): Promise<void>;
  markUndelivered(id: number, err: unknown): Promise<void>;
  /**
   * After a 2xx only — the moment the browser counts the lead too (Meta
   * Conversions API). Its failure is logged and never reaches the visitor.
   */
  afterAccepted?(info: { data: ContactPayload; submissionId: number | null; request: Request }): Promise<void>;
  /** File attachments (G-V2-01). Absent: multipart is refused, as before. */
  attachments?: ContactAttachmentDeps;
  /**
   * Whether this form type is marked sensitive (Settings → Forms). Its email
   * then carries only where to read it — not the content, not the file name —
   * because an inbox is not access-controlled. The row is stored in full.
   */
  isSensitive?(kind: string): Promise<boolean>;
}

export interface ContactAttachmentDeps {
  /** What the site accepts now (Settings → Forms), or `null` for no files. */
  policy(): Promise<AttachmentPolicy | null>;
  /** A tighter per-IP limit for posts that carry a file. */
  rateLimit(request: Request): ContactRateLimit;
  scan(bytes: Uint8Array): Promise<ClamdVerdict>;
  /** Writes the bytes to the private store; returns their key. */
  save(bytes: Uint8Array): Promise<string>;
  remove(key: string): Promise<void>;
}

function fail(error: string, status: number, headers?: Record<string, string>): Response {
  return Response.json({ ok: false, error }, { status, headers });
}

function rateLimited(limit: ContactRateLimit): Response {
  return fail('rate_limited', 429, {
    'Retry-After': String(limit.retryAfterSeconds),
    'X-RateLimit-Limit': String(limit.max),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(Math.ceil(limit.resetAt / 1000)),
  });
}

const ATTACHMENT_STATUS = {
  attachment_empty: 400,
  attachment_too_large: 413,
  attachment_type: 415,
} as const;

function describe(data: ContactPayload): { subject: string; rows: Row[] } {
  const localeTag = data.locale ? data.locale.toUpperCase() : '—';
  switch (data.kind) {
    case 'contact':
      return {
        subject: `New enquiry — ${data.name}`,
        rows: [
          ['Name', data.name],
          ['Email', data.email],
          ['Phone', data.phone ?? ''],
          ['Message', data.message],
          ['Locale', localeTag],
        ],
      };
  }
}

/**
 * The body's bytes, or `null` once it passes `max` bytes. Reads the stream and
 * stops there: `request.text()` would buffer a chunked upload of any size first.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface ParsedBody {
  json: unknown;
  file: { name: string; bytes: Uint8Array } | null;
}

/** JSON as before, or the multipart form's `payload` part plus its `attachment`. */
async function parseBody(bytes: Uint8Array, contentType: string, multipart: boolean): Promise<ParsedBody | 'invalid_json'> {
  if (!multipart) {
    try {
      return { json: JSON.parse(new TextDecoder().decode(bytes)), file: null };
    } catch {
      return 'invalid_json';
    }
  }
  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return 'invalid_json';
  }
  const payload = form.get('payload');
  let json: unknown;
  try {
    json = JSON.parse(typeof payload === 'string' ? payload : '');
  } catch {
    return 'invalid_json';
  }
  const part = form.get('attachment');
  // A form with an empty file input still sends the part, with no name and no bytes.
  if (!(part instanceof File) || (part.size === 0 && !part.name)) return { json, file: null };
  return { json, file: { name: part.name, bytes: new Uint8Array(await part.arrayBuffer()) } };
}

export async function handleContactRequest(request: Request, deps: ContactDeps): Promise<Response> {
  if (!deps.originAllowed(request.headers.get('origin'))) return fail('forbidden', 403);
  const contentType = request.headers.get('content-type') ?? '';
  const multipart = contentType.includes('multipart/form-data');
  if (!multipart && !contentType.includes('application/json')) {
    return fail('bad_request', 400);
  }

  const limit = deps.rateLimit(request);
  if (!limit.allowed) return rateLimited(limit);

  // A file is only welcome while the site allows one; its size raises the cap.
  let policy: AttachmentPolicy | null = null;
  if (multipart) {
    policy = deps.attachments ? await deps.attachments.policy() : null;
    if (!deps.attachments || !policy) return fail('attachment_disabled', 400);
  }
  const maxBytes = policy ? CONTACT_MAX_BODY_BYTES + policy.maxBytes + MULTIPART_OVERHEAD_BYTES : CONTACT_MAX_BODY_BYTES;

  // The header is a cheap early answer; the bytes are the real check, since
  // `content-length` is whatever the client chose to say — or absent entirely.
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) {
    return fail('too_large', 413);
  }
  const body = await readCapped(request, maxBytes);
  if (body === null) return fail('too_large', 413);

  const read = await parseBody(body, contentType, multipart);
  if (read === 'invalid_json') return fail('invalid_json', 400);

  const parsed = payloadSchema.safeParse(read.json);
  if (!parsed.success) return fail('invalid_payload', 400);
  const data = parsed.data;

  // Honeypot: a bot is told it worked, and nothing else happens.
  if (data._hp && data._hp.length > 0) return Response.json({ ok: true });

  if (await deps.captchaRequired()) {
    const verdict = await deps.verifyCaptcha(request.headers.get(CAPTCHA_HEADER));
    if (!verdict.ok) {
      console.warn('[api/contact] captcha rejected', verdict.reason);
      return fail('captcha_failed', 400);
    }
  }

  // The file: by its bytes, then the per-IP limit, then the scan, then the disk.
  let attachment: AttachmentRecord | null = null;
  if (read.file && policy && deps.attachments) {
    const check = checkAttachment(read.file, policy);
    if (!check.ok) return fail(check.error, ATTACHMENT_STATUS[check.error]);
    const fileLimit = deps.attachments.rateLimit(request);
    if (!fileLimit.allowed) return rateLimited(fileLimit);
    const scan = await deps.attachments.scan(read.file.bytes);
    if (scan.status === 'infected') {
      console.warn('[api/contact] attachment refused by the virus scan', scan.signature);
      return fail('attachment_rejected', 422);
    }
    if (scan.status === 'error') {
      console.error('[api/contact] attachment could not be scanned', scan.reason);
      return fail('attachment_unscanned', 503);
    }
    const key = await deps.attachments.save(read.file.bytes);
    attachment = { key, name: check.name, size: read.file.bytes.byteLength, type: check.type };
  }

  const { subject, rows } = describe(data);

  // Store first; a storage failure is logged and the email still goes out.
  let submissionId: number | null = null;
  try {
    submissionId = await deps.store({
      ...contactSubmissionRecord({
        kind: data.kind,
        email: data.email,
        locale: data.locale,
        payload: Object.fromEntries(rows.filter(([, value]) => value !== '')),
        headers: request.headers,
      }),
      attachment,
    });
  } catch (err) {
    console.error('[api/contact] could not store the submission', err);
  }

  // The email names the file and where it is; it never carries it. A file whose
  // row could not be stored has no way to be downloaded, so it is not kept.
  if (attachment) {
    const label = `${attachment.name} (${formatAttachmentSize(attachment.size)})`;
    if (submissionId === null) {
      await deps.attachments?.remove(attachment.key).catch(() => {});
      rows.push(['Attachment', `${label} — not kept: the enquiry could not be stored. Ask the sender to email it.`]);
    } else {
      rows.push(['Attachment', `${label} — download it in Admin → Submissions, #${submissionId}`]);
    }
  }

  // A sensitive form's notification points at the admin and says nothing else.
  const sensitive = deps.isSensitive ? await deps.isSensitive(data.kind).catch(() => true) : false;
  const emailRows: Row[] = sensitive
    ? [
        [
          'Submission',
          submissionId === null
            ? 'A sensitive enquiry arrived but could not be stored. Ask the sender to contact you again.'
            : `A sensitive enquiry — read it in Admin → Submissions, #${submissionId}`,
        ],
      ]
    : rows;

  try {
    await deps.send({ data, subject, rows: emailRows });
    if (submissionId !== null) await deps.markDelivered(submissionId).catch(() => {});
  } catch (err) {
    // The enquiry is stored (and marked undelivered in the admin); the client
    // still learns the send failed.
    console.error('[api/contact] send failed', err);
    if (submissionId !== null) await deps.markUndelivered(submissionId, err).catch(() => {});
    return fail('send_failed', 502);
  }

  if (deps.afterAccepted) {
    await deps.afterAccepted({ data, submissionId, request }).catch((err: unknown) => {
      console.error('[api/contact] after-accept step failed', err);
    });
  }
  return Response.json({ ok: true });
}
