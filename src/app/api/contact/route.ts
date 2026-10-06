import { createSubmission, getSetting, markSubmissionDelivered, markSubmissionUndelivered } from '@/cms/core';
import { sendGraphMail } from '@/cms/core/email';
import { parseRecipients } from '@/cms/core/email/format';
import { queueCapiEvent } from '@/cms/core/analytics/capi-queue';
import {
  formAttachmentPolicy,
  getAttachmentStore,
  getFormsPolicy,
  scanFormAttachment,
} from '@/cms/core/forms/attachment-runtime';
import { isSensitiveFormType } from '@/cms/core/forms/policy';
import { requestAnalyticsContext } from '@/cms/core/analytics/meta-capi';
import { checkRateLimit, getClientIp } from '@/cms/core/rate-limit';
import { verifyCaptchaToken } from '@/cms/core/security/captcha';
import { publicFormsCaptchaSiteKey } from '@/cms/core/security/public-captcha';
import { siteBrand } from '@/lib/brand';
import { handleContactRequest } from '@/lib/contact-handler';
import { rowsToHtml, rowsToText } from '@/lib/email/rows';
import { isAllowedPublicOrigin } from '@/lib/public-origin';
import { SITE_URL } from '@/lib/seo/schemas';

// @azure/identity needs the Node.js runtime (not Edge).
export const runtime = 'nodejs';

/** Per-IP ceiling: generous for a person, useless for a flood. */
const RATE_LIMIT = { max: 5, windowMs: 60 * 1000 } as const;
/** Posts carrying a file, per IP: each one is disk space and a scan. */
const ATTACHMENT_RATE_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 } as const;

/**
 * The contact form endpoint (`kind: 'contact'`, see ContactForm.tsx).
 *
 * The pipeline — and its order — is `handleContactRequest`; this file only
 * supplies the real I/O. The enquiry is stored in `form_submissions` FIRST, so a
 * failed email never loses it, then emailed via Microsoft Graph. With the
 * captcha on (Settings → Security), the `x-captcha-token` header must verify, or
 * the answer is `400 captcha_failed` and nothing is stored.
 */
export async function POST(request: Request) {
  return handleContactRequest(request, {
    originAllowed: (origin) => isAllowedPublicOrigin(origin, SITE_URL, process.env.NODE_ENV === 'production'),
    rateLimit: (req) => ({ ...checkRateLimit('contact', getClientIp(req), RATE_LIMIT), max: RATE_LIMIT.max }),
    captchaRequired: async () => (await publicFormsCaptchaSiteKey()) !== null,
    verifyCaptcha: (token) => verifyCaptchaToken(token),
    store: (record) => createSubmission(record),
    send: async ({ data, subject, rows }) => {
      // The core sender, like every other mail: it applies the email branding.
      // The Reply-To label says the address came from a form, not a known contact
      // — a guard against a submitter putting a partner's mailbox in `email`.
      // To the inboxes set in Settings → Notifications; none set means the
      // mailer's default (`CONTACT_RECIPIENT_EMAIL`).
      const [{ name: brandName }, recipients] = await Promise.all([
        siteBrand(),
        getSetting('notifications.inquiryEmails'),
      ]);
      await sendGraphMail({
        to: parseRecipients(recipients),
        subject,
        html: rowsToHtml(rows),
        text: rowsToText(rows),
        replyTo: data.email,
        replyToName: data.name,
        replyToSuffix: `(via ${brandName} contact form)`,
      });
    },
    markDelivered: (id) => markSubmissionDelivered(id),
    markUndelivered: (id, err) => markSubmissionUndelivered(id, err),
    // Settings → Forms → sensitive types: the email then only says where to read it.
    isSensitive: async (kind) => isSensitiveFormType(kind, await getFormsPolicy()),
    // A file attached to the enquiry (Settings → Forms): checked, scanned when
    // the server has clamd, and kept privately for the admin download.
    attachments: {
      policy: () => formAttachmentPolicy(),
      rateLimit: (req) => ({
        ...checkRateLimit('contact-attachment', getClientIp(req), ATTACHMENT_RATE_LIMIT),
        max: ATTACHMENT_RATE_LIMIT.max,
      }),
      scan: (bytes) => scanFormAttachment(bytes),
      save: (bytes) => getAttachmentStore().save(bytes),
      remove: (key) => getAttachmentStore().remove(key),
    },
    // Meta Conversions API: the same Lead the Pixel sent, by the same event id.
    afterAccepted: async ({ data, submissionId, request: req }) => {
      const context = requestAnalyticsContext(req.headers);
      await queueCapiEvent({
        eventName: 'Lead',
        eventId: context.eventId ?? `contact-${submissionId ?? Date.now()}`,
        user: { email: data.email, phone: data.phone || null },
        customData: { form_id: 'contact', form_name: 'Contact' },
        context,
      });
    },
  });
}
