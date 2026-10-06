/**
 * A file attached to a public form (G-V2-01) — the rules, with no I/O.
 *
 * A leaf like `settings/captcha.ts`: the settings schema declares its fields
 * from these constants, the public form builds its `accept` and hint from them,
 * and the endpoint checks every upload with them. Storage is `attachment-store`,
 * the settings read is `attachment-runtime`.
 *
 * What a visitor sends is judged by its bytes. The browser's `type` is never
 * stored: the content type comes from the allowlist below, so the admin
 * download can only ever announce one of five types.
 */

export const FORM_ATTACHMENT_ENABLED_KEY = 'forms.attachments.enabled';
export const FORM_ATTACHMENT_TYPES_KEY = 'forms.attachments.types';
export const FORM_ATTACHMENT_MAX_MB_KEY = 'forms.attachments.maxMb';

const MB = 1024 * 1024;

/** The sizes offered in Settings → Forms. Anything else reads as the default. */
export const FORM_ATTACHMENT_MAX_MB_OPTIONS = ['2', '5', '10', '20'] as const;
export const FORM_ATTACHMENT_DEFAULT_MAX_MB = '10';
/** What the types box shows before anyone saves it, and what an unsaved value means. */
export const FORM_ATTACHMENT_DEFAULT_TYPES = 'pdf';

interface AttachmentKind {
  label: string;
  extensions: readonly string[];
  mime: string;
  /** Whether these bytes are really this kind of file. */
  matches(bytes: Uint8Array): boolean;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.byteLength >= signature.length && signature.every((b, i) => bytes[i] === b);

const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * An Office file is a zip; which one it is shows in its entry names, which a
 * zip stores uncompressed. A plain byte search — this module also runs in the
 * browser, so no `Buffer`.
 */
function zipHasEntry(bytes: Uint8Array, prefix: string): boolean {
  if (!startsWith(bytes, ZIP)) return false;
  const needle = Array.from(prefix, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.byteLength - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export const FORM_ATTACHMENT_KINDS = {
  pdf: {
    label: 'PDF',
    extensions: ['pdf'],
    mime: 'application/pdf',
    matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
  },
  docx: {
    label: 'DOCX',
    extensions: ['docx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: (b) => zipHasEntry(b, 'word/'),
  },
  xlsx: {
    label: 'XLSX',
    extensions: ['xlsx'],
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    matches: (b) => zipHasEntry(b, 'xl/'),
  },
  jpg: {
    label: 'JPG',
    extensions: ['jpg', 'jpeg'],
    mime: 'image/jpeg',
    matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  png: {
    label: 'PNG',
    extensions: ['png'],
    mime: 'image/png',
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
} as const satisfies Record<string, AttachmentKind>;

export type FormAttachmentType = keyof typeof FORM_ATTACHMENT_KINDS;
export const FORM_ATTACHMENT_TYPES = Object.keys(FORM_ATTACHMENT_KINDS) as FormAttachmentType[];

/** What a site accepts. Plain data, so the page can hand it to the client form. */
export interface AttachmentPolicy {
  types: FormAttachmentType[];
  maxBytes: number;
}

/** The record kept on `form_submissions.attachment`. */
export interface AttachmentRecord {
  /** The file's name in the store — chosen by the server, never sent to a browser. */
  key: string;
  name: string;
  size: number;
  type: string;
}

/** What the admin API shows: the record without its storage key. */
export type PublicAttachment = Omit<AttachmentRecord, 'key'>;

/**
 * The policy from the three settings, or `null` when nothing is allowed.
 *
 * Off unless the switch is exactly `on` — an unset key never switches a
 * feature on (see `readBooleanSetting`). Types never saved mean the default
 * the form showed (PDF); types saved with every box unticked mean none.
 */
export function readAttachmentPolicy(
  rawEnabled: unknown,
  rawTypes: unknown,
  rawMaxMb: unknown
): AttachmentPolicy | null {
  if (rawEnabled !== 'on') return null;
  const stored =
    typeof rawTypes === 'string' ? rawTypes : rawTypes == null ? FORM_ATTACHMENT_DEFAULT_TYPES : '';
  // `parseMultiValue`'s format, split here: this leaf cannot import the settings
  // schema, which imports it.
  const ticked = stored.split(',').map((s) => s.trim());
  const types = FORM_ATTACHMENT_TYPES.filter((t) => ticked.includes(t));
  if (types.length === 0) return null;
  const mb = (FORM_ATTACHMENT_MAX_MB_OPTIONS as readonly unknown[]).includes(rawMaxMb)
    ? Number(rawMaxMb)
    : Number(FORM_ATTACHMENT_DEFAULT_MAX_MB);
  return { types, maxBytes: mb * MB };
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const kindForName = (name: string, policy: AttachmentPolicy) => {
  const ext = extensionOf(name);
  return policy.types
    .map((t) => FORM_ATTACHMENT_KINDS[t])
    .find((k) => (k.extensions as readonly string[]).includes(ext));
};

const MAX_NAME_LENGTH = 120;

/**
 * A name safe to store and to put in a header: the last path segment, without
 * control characters, direction marks or quotes, at most 120 characters with the
 * extension kept. Greek and other letters stay as they are.
 */
export function cleanAttachmentName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  const name = last
    // Control characters, the quote, and the direction marks that can make
    // `invoice<RLO>fdp.pdf` read as something else in the admin list.
    .replace(/[\u0000-\u001f\u007f"‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) return 'attachment';
  if (name.length <= MAX_NAME_LENGTH) return name;
  const ext = extensionOf(name);
  const tail = ext && ext.length < 10 ? `.${ext}` : '';
  return name.slice(0, MAX_NAME_LENGTH - tail.length) + tail;
}

export type AttachmentError = 'attachment_empty' | 'attachment_too_large' | 'attachment_type';

export type AttachmentCheck =
  | { ok: true; name: string; type: string }
  | { ok: false; error: AttachmentError };

/** Whether an uploaded file may be kept under this policy, judged by its bytes. */
export function checkAttachment(
  file: { name: string; bytes: Uint8Array },
  policy: AttachmentPolicy
): AttachmentCheck {
  if (file.bytes.byteLength === 0) return { ok: false, error: 'attachment_empty' };
  if (file.bytes.byteLength > policy.maxBytes) return { ok: false, error: 'attachment_too_large' };
  const name = cleanAttachmentName(file.name);
  const kind = kindForName(name, policy);
  if (!kind || !kind.matches(file.bytes)) return { ok: false, error: 'attachment_type' };
  return { ok: true, name, type: kind.mime };
}

/** The file input's `accept`: each allowed extension and its type. */
export function attachmentAccept(policy: AttachmentPolicy): string {
  return policy.types
    .flatMap((t) => [
      ...FORM_ATTACHMENT_KINDS[t].extensions.map((e) => `.${e}`),
      FORM_ATTACHMENT_KINDS[t].mime,
    ])
    .join(',');
}

/** "PDF, DOCX" — for the hint under the file input. */
export function attachmentTypeLabels(policy: AttachmentPolicy): string {
  return policy.types.map((t) => FORM_ATTACHMENT_KINDS[t].label).join(', ');
}

/** The browser's early warning, by name and size. The server still checks the bytes. */
export function attachmentClientProblem(
  file: { name: string; size: number },
  policy: AttachmentPolicy
): 'attachmentTooLarge' | 'attachmentType' | null {
  if (file.size > policy.maxBytes) return 'attachmentTooLarge';
  if (!kindForName(file.name, policy)) return 'attachmentType';
  return null;
}

/** "1.2 MB" / "34 KB". */
export function formatAttachmentSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The stored record without its key — or `null` for anything that is not one. */
export function publicAttachment(raw: unknown): PublicAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.size !== 'number' || typeof r.type !== 'string')
    return null;
  return { name: r.name, size: r.size, type: r.type };
}

/** `encodeURIComponent` leaves `'()*` bare; RFC 5987 does not allow them. */
const rfc5987 = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

/**
 * Headers for the admin download. Always a download, never rendered: a file a
 * stranger uploaded must not run as a page in the admin's origin, so the type
 * is not sniffed and the response is sandboxed with nothing allowed.
 */
export function attachmentDownloadHeaders(file: PublicAttachment): Record<string, string> {
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    'Content-Type': file.type,
    'Content-Length': String(file.size),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'no-store',
  };
}
