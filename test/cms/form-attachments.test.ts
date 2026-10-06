/**
 * A file attached to the public contact form (G-V2-01).
 *
 * The policy is per site (Settings → Forms) and off until someone switches it on.
 * What a visitor sends is checked on the server against that policy by its
 * bytes, not by what the browser claims: the stored content type is the one the
 * allowlist names, and the stored name has no path, no control characters and
 * no quote that could break the download header.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  attachmentAccept,
  attachmentClientProblem,
  attachmentDownloadHeaders,
  checkAttachment,
  cleanAttachmentName,
  readAttachmentPolicy,
  type AttachmentPolicy,
} from '@/cms/core/forms/attachments';

const MB = 1024 * 1024;
const enc = new TextEncoder();
const bytes = (...parts: Array<string | number[]>) => {
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

const PDF = bytes('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'rest');
const JPG = bytes([0xff, 0xd8, 0xff, 0xe0], 'rest');
const DOCX = bytes([0x50, 0x4b, 0x03, 0x04], '....[Content_Types].xml....word/document.xml....');
const XLSX = bytes([0x50, 0x4b, 0x03, 0x04], '....[Content_Types].xml....xl/workbook.xml....');

const pdfOnly = readAttachmentPolicy('on', 'pdf', '10') as AttachmentPolicy;

describe('readAttachmentPolicy', () => {
  test('off unless the switch is exactly on — an unsaved setting never turns it on', () => {
    assert.equal(readAttachmentPolicy(null, 'pdf', '10'), null);
    assert.equal(readAttachmentPolicy('off', 'pdf', '10'), null);
    assert.equal(readAttachmentPolicy('yes', 'pdf', '10'), null);
  });

  test('on with the types never saved: PDF, the default the form showed', () => {
    assert.deepEqual(readAttachmentPolicy('on', null, null)?.types, ['pdf']);
  });

  test('on with every type unticked: nothing to accept, so off', () => {
    assert.equal(readAttachmentPolicy('on', '', '10'), null);
  });

  test('unknown types are ignored, and only unknown types is still off', () => {
    assert.equal(readAttachmentPolicy('on', 'exe,html', '10'), null);
    assert.deepEqual(readAttachmentPolicy('on', 'exe,pdf', '10')?.types, ['pdf']);
  });

  test('the size is one of the offered sizes, 10 MB when unset or anything else', () => {
    assert.equal(readAttachmentPolicy('on', 'pdf', '2')?.maxBytes, 2 * MB);
    assert.equal(readAttachmentPolicy('on', 'pdf', '20')?.maxBytes, 20 * MB);
    assert.equal(readAttachmentPolicy('on', 'pdf', null)?.maxBytes, 10 * MB);
    assert.equal(readAttachmentPolicy('on', 'pdf', '500')?.maxBytes, 10 * MB);
  });
});

describe('checkAttachment', () => {
  test('a real PDF within the size is accepted with the allowlisted type', () => {
    const r = checkAttachment({ name: 'Διακήρυξη 2026.pdf', bytes: PDF }, pdfOnly);
    assert.deepEqual(r, { ok: true, name: 'Διακήρυξη 2026.pdf', type: 'application/pdf' });
  });

  test('an empty file is refused', () => {
    assert.deepEqual(checkAttachment({ name: 'a.pdf', bytes: new Uint8Array() }, pdfOnly), {
      ok: false,
      error: 'attachment_empty',
    });
  });

  test('a file over the size is refused', () => {
    const policy = readAttachmentPolicy('on', 'pdf', '2') as AttachmentPolicy;
    const big = new Uint8Array(2 * MB + 1);
    big.set(PDF);
    assert.deepEqual(checkAttachment({ name: 'a.pdf', bytes: big }, policy), {
      ok: false,
      error: 'attachment_too_large',
    });
  });

  test('an extension the site did not allow is refused', () => {
    assert.deepEqual(checkAttachment({ name: 'photo.png', bytes: PNG }, pdfOnly), {
      ok: false,
      error: 'attachment_type',
    });
  });

  test('a page renamed to .pdf is refused by its bytes', () => {
    const html = bytes('<html><script>alert(1)</script></html>');
    assert.deepEqual(checkAttachment({ name: 'tender.pdf', bytes: html }, pdfOnly), {
      ok: false,
      error: 'attachment_type',
    });
  });

  test('every offered type is recognised by its own signature', () => {
    const all = readAttachmentPolicy('on', 'pdf,docx,xlsx,jpg,png', '10') as AttachmentPolicy;
    assert.equal(checkAttachment({ name: 'a.png', bytes: PNG }, all).ok, true);
    assert.equal(checkAttachment({ name: 'a.jpeg', bytes: JPG }, all).ok, true);
    assert.equal(checkAttachment({ name: 'a.JPG', bytes: JPG }, all).ok, true);
    assert.equal(checkAttachment({ name: 'a.docx', bytes: DOCX }, all).ok, true);
    assert.equal(checkAttachment({ name: 'a.xlsx', bytes: XLSX }, all).ok, true);
  });

  test('a spreadsheet renamed to .docx is refused', () => {
    const all = readAttachmentPolicy('on', 'docx,xlsx', '10') as AttachmentPolicy;
    assert.equal(checkAttachment({ name: 'a.docx', bytes: XLSX }, all).ok, false);
  });

  test('the stored type is the allowlist’s, never the browser’s', () => {
    const r = checkAttachment(
      { name: 'a.jpg', bytes: JPG },
      readAttachmentPolicy('on', 'jpg', '10')!
    );
    assert.equal(r.ok && r.type, 'image/jpeg');
  });
});

describe('cleanAttachmentName', () => {
  test('keeps only the last path segment', () => {
    assert.equal(cleanAttachmentName('../../etc/passwd.pdf'), 'passwd.pdf');
    assert.equal(cleanAttachmentName('C:\\Users\\me\\tender.pdf'), 'tender.pdf');
  });

  test('drops control characters and quotes, keeps Greek', () => {
    assert.equal(cleanAttachmentName('a\r\nb"c\u0000.pdf'), 'abc.pdf');
    assert.equal(cleanAttachmentName('Προσφορά.pdf'), 'Προσφορά.pdf');
  });

  test('drops the invisible direction marks used to disguise a name', () => {
    assert.equal(cleanAttachmentName('invoice\u202Efdp.pdf'), 'invoicefdp.pdf');
    assert.equal(cleanAttachmentName('a\u200Fb\u2066c\u2069.pdf'), 'abc.pdf');
  });

  test('caps the length but keeps the extension', () => {
    const name = cleanAttachmentName(`${'x'.repeat(300)}.pdf`);
    assert.ok(name.length <= 120);
    assert.ok(name.endsWith('.pdf'));
  });

  test('nothing left becomes a neutral name', () => {
    assert.equal(cleanAttachmentName('...'), 'attachment');
  });
});

describe('browser-side helpers', () => {
  test('accept lists the extensions and the types', () => {
    const accept = attachmentAccept(readAttachmentPolicy('on', 'pdf,jpg', '10')!);
    assert.equal(accept, '.pdf,application/pdf,.jpg,.jpeg,image/jpeg');
  });

  test('the form warns before sending a file that will be refused', () => {
    assert.equal(attachmentClientProblem({ name: 'a.pdf', size: 1000 }, pdfOnly), null);
    assert.equal(attachmentClientProblem({ name: 'a.png', size: 1000 }, pdfOnly), 'attachmentType');
    assert.equal(
      attachmentClientProblem({ name: 'a.pdf', size: 11 * MB }, pdfOnly),
      'attachmentTooLarge'
    );
  });
});

describe('attachmentDownloadHeaders', () => {
  const headers = attachmentDownloadHeaders({
    name: 'Διακήρυξη "τελική".pdf',
    type: 'application/pdf',
    size: 1234,
  });

  test('always a download, never rendered in the admin origin', () => {
    assert.match(headers['Content-Disposition'], /^attachment;/);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Content-Security-Policy'], "sandbox; default-src 'none'");
    assert.equal(headers['Cache-Control'], 'no-store');
  });

  test('the name survives in UTF-8 and the plain fallback has no quotes to break out of', () => {
    assert.match(headers['Content-Disposition'], /filename\*=UTF-8''/);
    assert.ok(headers['Content-Disposition'].includes(encodeURIComponent('Διακήρυξη')));
    const plain = /filename="([^"]*)"/.exec(headers['Content-Disposition']);
    assert.ok(plain);
    assert.match(plain[1], /^[\x20-\x7e]+$/);
  });

  test('the UTF-8 name escapes every character RFC 5987 does not allow bare', () => {
    const h = attachmentDownloadHeaders({
      name: "it's (final)*.pdf",
      type: 'application/pdf',
      size: 1,
    });
    const star = /filename\*=UTF-8''(\S+)$/.exec(h['Content-Disposition']);
    assert.ok(star);
    assert.doesNotMatch(star[1], /['()*]/);
    assert.equal(decodeURIComponent(star[1]), "it's (final)*.pdf");
  });

  test('type and length come from the stored record', () => {
    assert.equal(headers['Content-Type'], 'application/pdf');
    assert.equal(headers['Content-Length'], '1234');
  });
});
