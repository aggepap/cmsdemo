/**
 * The contact endpoint with a file attached (G-V2-01).
 *
 * A form with a file posts `multipart/form-data`: the same fields as JSON in a
 * `payload` part, the file in an `attachment` part. Everything that already
 * guards the JSON form still runs first, so a refused captcha or a honeypot hit
 * never puts a byte on disk. Then: check the file → per-IP attachment limit →
 * scan → save → store the row with the file's record → send. The email names
 * the file and where to download it; it never carries the bytes.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readAttachmentPolicy, type AttachmentPolicy } from '@/cms/core/forms/attachments';
import type { NewSubmissionInput } from '@/cms/core/forms/service';
import type { CaptchaResult } from '@/cms/core/security/captcha';
import type { ClamdVerdict } from '@/cms/core/security/clamav';
import {
  handleContactRequest,
  type ContactDeps,
  type ContactNotification,
} from '@/lib/contact-handler';

const FIELDS = {
  kind: 'contact',
  locale: 'el',
  name: 'Μαρία',
  email: 'maria@example.com',
  phone: '',
  message: 'Σας στέλνω τη διακήρυξη',
  _hp: '',
};

const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF');
const KEY = '3f2a1b4c-0d9e-4f8a-9b7c-6d5e4f3a2b1c';

function multipart(
  fields: Record<string, unknown> = FIELDS,
  file: { name: string; bytes: Uint8Array; type?: string } | null = {
    name: 'Διακήρυξη.pdf',
    bytes: PDF,
  },
  headers: Record<string, string> = { 'x-captcha-token': 'tok' }
): Request {
  const form = new FormData();
  form.set('payload', JSON.stringify(fields));
  if (file)
    form.set(
      'attachment',
      new File([Uint8Array.from(file.bytes)], file.name, { type: file.type ?? 'application/pdf' })
    );
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'x-real-ip': '203.0.113.9', ...headers },
    body: form,
  });
}

interface Recorder {
  deps: ContactDeps;
  calls: string[];
  stored: NewSubmissionInput[];
  sent: ContactNotification[];
  scanned: Uint8Array[];
}

function recorder(
  over: {
    policy?: AttachmentPolicy | null;
    captcha?: CaptchaResult;
    scan?: ClamdVerdict;
    storeFails?: boolean;
    attachmentAllowed?: boolean;
  } = {}
): Recorder {
  const calls: string[] = [];
  const stored: NewSubmissionInput[] = [];
  const sent: ContactNotification[] = [];
  const scanned: Uint8Array[] = [];
  const policy = over.policy === undefined ? readAttachmentPolicy('on', 'pdf', '2') : over.policy;
  const deps: ContactDeps = {
    originAllowed: () => true,
    rateLimit: () => {
      calls.push('rateLimit');
      return { allowed: true, retryAfterSeconds: 0, resetAt: Date.now() + 60_000, max: 5 };
    },
    captchaRequired: async () => true,
    verifyCaptcha: async () => {
      calls.push('captcha');
      return over.captcha ?? { ok: true };
    },
    store: async (record) => {
      calls.push('store');
      if (over.storeFails) throw new Error('db down');
      stored.push(record);
      return 42;
    },
    send: async (n) => {
      calls.push('send');
      sent.push(n);
    },
    markDelivered: async () => {
      calls.push('delivered');
    },
    markUndelivered: async () => {
      calls.push('undelivered');
    },
    attachments: {
      policy: async () => policy,
      rateLimit: () => {
        calls.push('attachmentLimit');
        return over.attachmentAllowed === false
          ? { allowed: false, retryAfterSeconds: 600, resetAt: Date.now() + 600_000, max: 10 }
          : { allowed: true, retryAfterSeconds: 0, resetAt: Date.now() + 600_000, max: 10 };
      },
      scan: async (bytes) => {
        calls.push('scan');
        scanned.push(bytes);
        return over.scan ?? { status: 'clean' };
      },
      save: async () => {
        calls.push('save');
        return KEY;
      },
      remove: async (key) => {
        calls.push(`remove:${key}`);
      },
    },
  };
  return { deps, calls, stored, sent, scanned };
}

const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

describe('handleContactRequest with an attachment', () => {
  test('a PDF is scanned, saved, recorded on the row, and named in the email', async () => {
    const r = recorder();
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(r.calls, [
      'rateLimit',
      'captcha',
      'attachmentLimit',
      'scan',
      'save',
      'store',
      'send',
      'delivered',
    ]);
    assert.deepEqual(r.stored[0].attachment, {
      key: KEY,
      name: 'Διακήρυξη.pdf',
      size: PDF.byteLength,
      type: 'application/pdf',
    });
    assert.equal(r.stored[0].payload.Message, FIELDS.message);
    assert.deepEqual(Buffer.from(r.scanned[0]), Buffer.from(PDF));
    const row = r.sent[0].rows.find(([label]) => label === 'Attachment');
    assert.ok(row, 'the email has an Attachment row');
    assert.match(row[1], /Διακήρυξη\.pdf/);
    assert.match(row[1], /#42/);
  });

  test('the email never carries the file itself', async () => {
    const r = recorder();
    await handleContactRequest(multipart(), r.deps);
    assert.ok(!JSON.stringify(r.sent[0]).includes('%PDF'));
  });

  test('with attachments off, a multipart post is refused and nothing is kept', async () => {
    const r = recorder({ policy: null });
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 400);
    assert.equal(await errorOf(res), 'attachment_disabled');
    assert.deepEqual(r.calls, ['rateLimit']);
  });

  test('a site without the attachment hooks refuses multipart as before', async () => {
    const r = recorder();
    const { attachments: _unused, ...deps } = r.deps;
    void _unused;
    const res = await handleContactRequest(multipart(), deps);
    assert.equal(res.status, 400);
  });

  test('multipart without a file is the plain form', async () => {
    const r = recorder();
    const res = await handleContactRequest(multipart(FIELDS, null), r.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(r.calls, ['rateLimit', 'captcha', 'store', 'send', 'delivered']);
    assert.equal(r.stored[0].attachment ?? null, null);
  });

  test('a body larger than the allowed file is cut off before it is parsed', async () => {
    const r = recorder();
    const big = new Uint8Array(3 * 1024 * 1024);
    big.set(PDF);
    const res = await handleContactRequest(
      multipart(FIELDS, { name: 'a.pdf', bytes: big }),
      r.deps
    );
    assert.equal(res.status, 413);
    assert.deepEqual(r.calls, ['rateLimit']);
  });

  test('a file just over the limit is refused as too large', async () => {
    const r = recorder();
    const over = new Uint8Array(2 * 1024 * 1024 + 10);
    over.set(PDF);
    const res = await handleContactRequest(
      multipart(FIELDS, { name: 'a.pdf', bytes: over }),
      r.deps
    );
    assert.equal(res.status, 413);
    assert.equal(await errorOf(res), 'attachment_too_large');
    assert.ok(!r.calls.includes('save'));
  });

  test('a type the site did not allow is a 415, and nothing is saved', async () => {
    const r = recorder();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await handleContactRequest(
      multipart(FIELDS, { name: 'a.png', bytes: png, type: 'image/png' }),
      r.deps
    );
    assert.equal(res.status, 415);
    assert.equal(await errorOf(res), 'attachment_type');
    assert.ok(!r.calls.includes('scan'));
    assert.ok(!r.calls.includes('save'));
  });

  test('a refused captcha saves nothing and scans nothing', async () => {
    const r = recorder({ captcha: { ok: false, reason: 'x' } });
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 400);
    assert.deepEqual(r.calls, ['rateLimit', 'captcha']);
  });

  test('a honeypot hit saves nothing', async () => {
    const r = recorder();
    const res = await handleContactRequest(multipart({ ...FIELDS, _hp: 'bot' }), r.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(r.calls, ['rateLimit']);
  });

  test('too many files from one address is a 429 before the scan', async () => {
    const r = recorder({ attachmentAllowed: false });
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '600');
    assert.ok(!r.calls.includes('scan'));
  });

  test('an infected file is refused and never saved', async () => {
    const r = recorder({ scan: { status: 'infected', signature: 'Eicar' } });
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 422);
    assert.equal(await errorOf(res), 'attachment_rejected');
    assert.ok(!r.calls.includes('save'));
    assert.ok(!r.calls.includes('store'));
  });

  test('a scanner that cannot answer fails closed', async () => {
    const r = recorder({ scan: { status: 'error', reason: 'ECONNREFUSED' } });
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 503);
    assert.equal(await errorOf(res), 'attachment_unscanned');
    assert.ok(!r.calls.includes('save'));
  });

  test('no scanner configured is not a refusal', async () => {
    const r = recorder({ scan: { status: 'skipped' } });
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 200);
  });

  test('when the row cannot be stored, the saved file is removed and the email says so', async () => {
    const r = recorder({ storeFails: true });
    const res = await handleContactRequest(multipart(), r.deps);
    assert.equal(res.status, 200);
    assert.ok(r.calls.includes(`remove:${KEY}`));
    const row = r.sent[0].rows.find(([label]) => label === 'Attachment');
    assert.ok(row);
    assert.match(row[1], /not kept/i);
  });

  test('a malformed payload part is a 400', async () => {
    const r = recorder();
    const form = new FormData();
    form.set('payload', '{nope');
    const res = await handleContactRequest(
      new Request('http://localhost/api/contact', { method: 'POST', body: form }),
      r.deps
    );
    assert.equal(res.status, 400);
    assert.equal(await errorOf(res), 'invalid_json');
  });
});

describe('a sensitive form type (Settings → Forms)', () => {
  test('the email says where to read it and carries none of the content, nor the file name', async () => {
    const r = recorder();
    const res = await handleContactRequest(multipart(), {
      ...r.deps,
      isSensitive: async () => true,
    });
    assert.equal(res.status, 200);
    const sent = JSON.stringify(r.sent[0].rows);
    assert.doesNotMatch(sent, /Σας στέλνω τη διακήρυξη/);
    assert.doesNotMatch(sent, /Διακήρυξη\.pdf/);
    assert.match(sent, /#42/);
    // The submission itself is stored in full — only the email is reduced.
    assert.equal(r.stored[0].payload.Message, FIELDS.message);
  });

  test('an ordinary form type emails everything, as before', async () => {
    const r = recorder();
    await handleContactRequest(multipart(), { ...r.deps, isSensitive: async () => false });
    assert.match(JSON.stringify(r.sent[0].rows), /Σας στέλνω τη διακήρυξη/);
  });
});
