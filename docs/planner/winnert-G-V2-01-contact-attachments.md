# G-V2-01 · Attaching a file to the contact form: hand-off to the Planner

This doc covers how the CMS takes one optional file from a visitor (for example the PDF of a tender) on the public contact form. It also covers what a site must change to offer the field. It was written after the winnert-planner finding of 3/10/2026.

## 1. What `cms:update` brings, and what it doesn't

**Core files, written by the updater:**

- `src/cms/core/forms/attachments.ts`: the rules, with no I/O. It covers the policy, the byte check, the name cleaning, the `accept` value and the download headers.
- `src/cms/core/forms/attachment-store.ts`: the private store on disk.
- `src/cms/core/forms/attachment-runtime.ts`: the settings read, the store instance and the scan.
- `src/cms/core/security/clamav.ts`: the optional clamd scan.
- `src/app/api/cms/forms/[id]/attachment/route.ts`: the admin download.
- Changes to `core/forms/service.ts`, `core/routes/forms.ts`, `core/settings/schema.ts`, the `form_submissions` schema and `admin/SubmissionsTable.tsx`.

**After `cms:update`:**

- **Migration** `0027_concerned_ronan`: `ALTER TABLE form_submissions ADD attachment json`. Run `npm run db:migrate` before the new build serves traffic. The column is nullable, so existing rows are not touched.
- **No new npm dependencies.**
- **New env vars**, all optional:
  - `CMS_FORM_UPLOADS_DIR` (default `<cwd>/.data/form-uploads`). In production, set it to a persistent path outside the release directory.
  - `CLAMD_SOCKET`, or `CLAMD_HOST` with an optional `CLAMD_PORT` (default 3310).
- **Nothing changes visibly** until someone turns on Settings → Forms → "Visitors can attach a file to the contact form". It is off by default.

**Site-owned files the updater does not write.** A site that wants the field ports these from the base by hand:

| Base file | What changed |
|---|---|
| `src/lib/contact-handler.ts` | Multipart parsing, the `attachments` hooks, the order of checks, the `Attachment` row in the email |
| `src/lib/contact-request.ts` (new) | `contactRequestInit()`: JSON without a file, multipart with one |
| `src/app/api/contact/route.ts` | Passes `attachments: { policy, rateLimit, scan, save, remove }` |
| `src/app/[locale]/contact/page.tsx` | `formAttachmentPolicy()` → `<ContactForm attachment={…}>` |
| `src/components/site/ContactForm.tsx` | The file field, the hint, the browser-side check, the multipart send |
| `src/components/site/PublicCaptcha.tsx` | `contactErrorMessageKey()` returns the 4 new message keys |
| `messages/{el,en}.json` → `contact.form` | `attachment`, `attachmentHint`, `attachmentTooLarge`, `attachmentType`, `attachmentRejected`, `attachmentUnavailable` |

A site with its own contact handler doesn't have to copy the base's. It must still follow the contract in §3.

## 2. Settings (Admin → Settings → Forms)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `forms.attachments.enabled` | boolean | `off` | Only exactly `on` turns it on. Off means no field, and the server refuses multipart with `400 attachment_disabled`. |
| `forms.attachments.types` | multiselect `pdf`,`docx`,`xlsx`,`jpg`,`png` | `pdf` | The allowed types. With every box unticked, nothing is allowed. |
| `forms.attachments.maxMb` | select `2`,`5`,`10`,`20` | `10` | The largest file. Any other value is read as 10. |

To read the policy, use `formAttachmentPolicy()` (server only). It returns `{ types, maxBytes } | null` and is plain data, so it can go straight to the client form.

## 3. API contract (`POST /api/contact`)

- **Without a file:** `application/json`, exactly as before.
- **With a file:** `multipart/form-data` with two parts:
  - `payload`: the same JSON as a string.
  - `attachment`: the file.
  - The browser sets the `content-type` itself, because the boundary goes in it. The captcha token still travels in the `x-captcha-token` header.
- **Order on the server:** origin → content type → rate limit (5/min) → is the feature on? → size (16 KB + the allowed size + 8 KB) → schema → honeypot → captcha → **check the file by its bytes** → **attachment rate limit (10/hour per IP)** → **scan** → **save** → store → email.
- **Responses:**

| Status | `error` | Message key |
|---|---|---|
| 400 | `attachment_disabled` | `attachmentUnavailable` |
| 400 | `attachment_empty` | `attachmentType` |
| 413 | `attachment_too_large` / `too_large` | `attachmentTooLarge` |
| 415 | `attachment_type` | `attachmentType` |
| 422 | `attachment_rejected` (virus) | `attachmentRejected` |
| 429 | `rate_limited` | generic |
| 503 | `attachment_unscanned` (clamd set but not answering) | `attachmentUnavailable` |

- **The file check:** the extension must be in the allowed types, and the first bytes must match that type (`%PDF-`, PNG, JPEG, or a zip containing `word/` or `xl/`). The stored `type` comes from the allowlist, never from the browser. The name is cut to the last path segment, with control characters, direction marks and `"` removed, at most 120 characters.
- **Email:** it does **not** carry the file. It has a row reading `Attachment: <name> (<size>) — download it in Admin → Submissions, #<id>`. If the row could not be stored, the file is deleted and the email says "not kept".

## 4. Admin

- **Submissions:** a new **File** column with a download link, and an **Attachment** row in the message panel.
- **`GET /api/cms/forms/{id}/attachment`:** requires `cms.forms.read`. Each download is audited as `submission.attachment.download`. Responses are always `Content-Disposition: attachment` with `nosniff`, `CSP: sandbox` and `no-store`. A submission without a file returns 404.
- **The admin API** (`/api/cms/forms`, `/api/cms/forms/{id}`) returns `attachment: { name, size, type } | null` and never the storage key.

## 5. Production

- **Nginx:** `client_max_body_size` must cover the chosen size plus about 24 KB on `/api/contact`. The documented `12m` is enough for 10 MB. For 20 MB, raise it to `21m`.
- **Backups:** back up `CMS_FORM_UPLOADS_DIR` the same way as the database. The files are personal data.
- **ClamAV:** recommended. Without `CLAMD_*`, files are not scanned (the byte check still runs). With it, the scan fails closed.

## 6. How to test it

1. Turn it on in Settings → Forms. `/contact` should now show the file field with "PDF, up to 10 MB".
2. Send a real PDF. Check that the file shows in Submissions in the File column, that the download works, and that the audit log shows the download.
3. Rename an `.html` file to `.pdf`. It should be refused with the type message.
4. Send a file over the limit. The browser should warn before sending.
5. With clamd running, send the EICAR test file. It should be refused with the security-check message.
6. Turn the setting off. The field should disappear, and a hand-made multipart request should get `400 attachment_disabled`.

Automated tests: `test/cms/form-attachments.test.ts`, `test/core/form-attachment-store.test.ts`, `test/core/clamav.test.ts`, `test/core/form-attachment-wiring.test.ts`, `test/lib/contact-attachment.test.ts`, `test/components/contact-attachment.test.tsx`, `test/site/contact-attachment-wiring.test.ts`.

## 7. Limits

- One file per message.
- There is no automatic deletion. Files stay as long as the submission does, and the admin cannot delete submissions yet.
- The base only puts the file field on the contact form. Other forms can use the same hooks.
- A multipart body is held in memory while it is checked, up to the size limit plus about 24 KB.
