# R3-3 / R3-25 (eyelike): order lookup, sensitive forms, retention — hand-off to the Planner

This covers what the CMS now does after the eyelike-planner v2 findings (3/10/2026), and what the site must change.

## 1. Order lookup (R3-3)

**`POST /api/cms/commerce/order-lookup`** now returns an allow-list, built by `publicOrder` in `src/cms/modules/commerce/order-public.ts`:

```
{
  reference, status, customerName, currency, subtotal, total, locale, notes, createdAt,
  metadata: {
    shipping: { address1, city, postal, country, method, virtual?, shippingMethod?: {name, courier, kind, cost}, locker?: {name}, pickup?: {name, address} },
    costs?: { shipping, surcharge, discount, giftWrap },
    coupon?: string,
    gift?: { wrap, message }
  },
  items: [{ id, name, sku, variantLabel, unitPrice, quantity, lineTotal, image: { uuid, alt } | null }],
  payments: [{ id, provider, status, amount, currency, method, createdAt }],
  paymentInstructions: string | null
}
```

- **Removed:**
  - From the order: `id`, `customerId`, `shippingMethodId`, `version`, `updatedAt`.
  - From `metadata`: `consent`, `analytics`, `codAmount`, `shipping.phone`, and every other key.
  - From each line: `snapshot`.
- **`items[].image`** is the product's first photo when it was ordered. **The site must read `item.image.uuid` in place of `snapshot.gallery[0].image`.**
- **`paymentInstructions`** is the bank-transfer text (Settings → Ecommerce, in the order's language) while a `bank_transfer` payment is `pending`. Otherwise it is `null`. Render it like the thank-you page does.
- For server-side callers, `findGuestOrder(reference, email)` returns the full order. The review badge uses it, and it must never be returned to a browser.

## 2. Forms: retention, sensitive types, deletion (R3-25)

### Settings (Admin → Settings → Forms)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `forms.retentionDays` | whole days | empty (keep) | Delete submissions, and their files, older than this |
| `forms.sensitiveTypes` | form types, one per line | empty | Content and files readable only with `cms.forms.sensitive` |
| `forms.sensitiveRetentionDays` | whole days | follows the general setting | A separate, usually shorter, period for the sensitive types |

### Permissions (Admin → Roles)

- `cms.forms.sensitive`, "Read sensitive form submissions".
- `cms.forms.delete`, "Delete form submissions".

The default `editor` role gets **neither**. `superadmin` (`*`) has both.

### Behaviour

- **Without `cms.forms.sensitive`, a sensitive submission:**
  - shows in the list without a file name;
  - shows in the drawer with "content hidden" and no payload, file or notes;
  - the API returns `payload: {}`, `attachment: null`, `notes: null`, `redacted: true`;
  - its file download returns 403;
  - its notes can't be changed (403). Its status can.
- **Deletion:** `DELETE /api/cms/forms/:id` with `cms.forms.delete` deletes the row and its file. It is audited as `submission.delete` with the form type only, never the content.
- **Cron job `forms-retention`:** run it daily (`POST /api/cms/cron/forms-retention`, `x-cron-secret`). It deletes expired submissions and their files in batches of 500. It does nothing until a retention period is set.
- **Email for a sensitive form type:** a single row, "A sensitive enquiry — read it in Admin → Submissions, #id". It carries no content and no file name. The stored record keeps everything.

## 3. File upload on a public form (R3-25, "Αποστολή συνταγής")

This is covered by G-V2-01 (see `docs/planner/winnert-G-V2-01-contact-attachments.md`): one file per message, a type and size allow-list, a byte check, an optional ClamAV scan, private storage, the admin download with audit, and the link in Submissions and in the email.

To use it for the prescription form, the site's own handler:

1. Adds a `kind: 'prescription'` to its `payloadSchema` and to `describe()`. That is site code, the same as the base's `contact`.
2. Passes the same hooks the base route does:
   - `attachments: { policy, rateLimit, scan, save, remove }`;
   - `isSensitive: async (kind) => isSensitiveFormType(kind, await getFormsPolicy())`.
3. Shows the file field with `formAttachmentPolicy()`, like the base `ContactForm` does.

The allowed types and size are **site-wide**: Settings → Forms → "File types allowed" (for example JPG, PNG, PDF) and "Largest attachment".

## 4. After `cms:update`

- **No migration** beyond G-V2-01's `0027`.
- **No new env vars.**
- **Do this:**
  - Schedule `forms-retention` daily.
  - Fill in the settings in §2 according to the privacy policy.
  - Add `prescription` to the sensitive types.
  - Give `cms.forms.sensitive` and `cms.forms.delete` to the right people.
- **Site code:**
  - The order page reads `item.image` and `paymentInstructions` (§1).
  - The prescription form (§3).

## 5. How to test it

1. **Order lookup:** look up a bank-transfer order. Check the response has `paymentInstructions` but no `snapshot`, `consent` or `phone`.
2. **Sensitive form type:**
   - Mark `contact` as sensitive and send a message. The email should only point to #id.
   - An `editor` sees "content hidden", and a download returns 403.
   - `superadmin` sees everything.
3. **Retention:** set `forms.retentionDays = 1` and run the job. Rows older than a day disappear, along with their files in `CMS_FORM_UPLOADS_DIR`.
4. **Deletion:** Delete in the drawer removes the row, and the audit log shows `submission.delete` without content.

Automated tests: `test/commerce/order-lookup-public.test.ts`, `test/cms/forms-policy.test.ts`, `test/core/forms-retention-wiring.test.ts`, `test/lib/contact-attachment.test.ts` (sensitive email).

## 6. Limits

- Retention counts from `created_at`. A submission marked "handled" isn't kept any longer because of that.
- An export (Export/Import) doesn't carry submissions.
- Database backups keep deleted rows until those backups expire. That belongs in the privacy policy.
