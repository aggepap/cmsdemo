/**
 * The public contact endpoint's pipeline (REQ-1).
 *
 * Order is the point: rate limit → size → schema → honeypot → captcha → store →
 * send. A rejected captcha must leave nothing stored and nothing sent, the token
 * travels in `x-captcha-token`, and the cheap refusals happen before Google is
 * asked anything — otherwise a flood of junk becomes a flood of verify calls.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { CaptchaResult } from '@/cms/core/security/captcha';
import { handleContactRequest, type ContactDeps } from '@/lib/contact-handler';

const VALID = {
  kind: 'contact',
  locale: 'el',
  name: 'Μαρία',
  email: 'maria@example.com',
  phone: '',
  message: 'Γεια σας',
  _hp: '',
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9', ...headers },
    body: text,
  });
}

interface Recorder {
  deps: ContactDeps;
  calls: string[];
  tokens: Array<string | null>;
}

function recorder(over: {
  allowed?: boolean;
  captchaRequired?: boolean;
  captcha?: CaptchaResult;
  sendFails?: boolean;
} = {}): Recorder {
  const calls: string[] = [];
  const tokens: Array<string | null> = [];
  const deps: ContactDeps = {
    originAllowed: () => true,
    rateLimit: () => {
      calls.push('rateLimit');
      return over.allowed === false
        ? { allowed: false, retryAfterSeconds: 30, resetAt: Date.now() + 30_000, max: 5 }
        : { allowed: true, retryAfterSeconds: 0, resetAt: Date.now() + 60_000, max: 5 };
    },
    captchaRequired: async () => over.captchaRequired ?? true,
    verifyCaptcha: async (token) => {
      calls.push('captcha');
      tokens.push(token);
      return over.captcha ?? { ok: true };
    },
    store: async () => {
      calls.push('store');
      return 42;
    },
    send: async () => {
      calls.push('send');
      if (over.sendFails) throw new Error('graph down');
    },
    markDelivered: async () => {
      calls.push('delivered');
    },
    markUndelivered: async () => {
      calls.push('undelivered');
    },
    afterAccepted: async ({ submissionId }) => {
      calls.push(`accepted:${submissionId}`);
    },
  };
  return { deps, calls, tokens };
}

describe('handleContactRequest', () => {
  test('a valid submission with a verified token is stored, then sent', async () => {
    const r = recorder();
    const res = await handleContactRequest(request(VALID, { 'x-captcha-token': 'tok' }), r.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(r.calls, ['rateLimit', 'captcha', 'store', 'send', 'delivered', 'accepted:42']);
  });

  test('the server-side lead (Conversions API) follows only an accepted submission', async () => {
    const refused = recorder({ captcha: { ok: false, reason: 'x' } });
    await handleContactRequest(request(VALID), refused.deps);
    assert.ok(!refused.calls.some((c) => c.startsWith('accepted')));
    const failed = recorder({ sendFails: true });
    await handleContactRequest(request(VALID, { 'x-captcha-token': 't' }), failed.deps);
    assert.ok(!failed.calls.some((c) => c.startsWith('accepted')));
  });

  test('a failing server-side lead never fails the submission', async () => {
    const r = recorder();
    const res = await handleContactRequest(request(VALID, { 'x-captcha-token': 't' }), {
      ...r.deps,
      afterAccepted: async () => {
        throw new Error('meta down');
      },
    });
    assert.equal(res.status, 200);
  });

  test('the token is read from the x-captcha-token header', async () => {
    const r = recorder();
    await handleContactRequest(request(VALID, { 'x-captcha-token': 'the-token' }), r.deps);
    assert.deepEqual(r.tokens, ['the-token']);
  });

  test('a failed captcha answers 400 captcha_failed and stores nothing', async () => {
    const r = recorder({ captcha: { ok: false, reason: 'timeout-or-duplicate' } });
    const res = await handleContactRequest(request(VALID, { 'x-captcha-token': 'spent' }), r.deps);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'captcha_failed' });
    assert.ok(!r.calls.includes('store'), 'nothing may be stored');
    assert.ok(!r.calls.includes('send'), 'nothing may be sent');
  });

  test('a missing token is handed to verification as null and fails the same way', async () => {
    const r = recorder({ captcha: { ok: false, reason: 'missing-token' } });
    const res = await handleContactRequest(request(VALID), r.deps);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'captcha_failed');
    assert.deepEqual(r.tokens, [null]);
  });

  test('with the captcha switched off, nothing is verified', async () => {
    const r = recorder({ captchaRequired: false });
    const res = await handleContactRequest(request(VALID), r.deps);
    assert.equal(res.status, 200);
    assert.ok(!r.calls.includes('captcha'));
  });

  test('rate limiting comes first — even before the size check', async () => {
    const r = recorder({ allowed: false });
    const huge = { ...VALID, message: 'x'.repeat(20_000) };
    const res = await handleContactRequest(request(huge), r.deps);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.deepEqual(r.calls, ['rateLimit']);
  });

  test('an oversized body is refused before it is parsed or verified', async () => {
    const r = recorder();
    const huge = { ...VALID, message: 'x'.repeat(20_000) };
    const res = await handleContactRequest(request(huge), r.deps);
    assert.equal(res.status, 413);
    assert.deepEqual(r.calls, ['rateLimit']);
  });

  test('an oversized body is refused even when content-length understates it', async () => {
    const r = recorder();
    const huge = JSON.stringify({ ...VALID, message: 'x'.repeat(20_000) });
    const res = await handleContactRequest(request(huge, { 'content-length': '10' }), r.deps);
    assert.equal(res.status, 413);
  });

  test('a streamed body with no length is cut off at the cap, not read to the end', async () => {
    const r = recorder();
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request('http://localhost/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: endless,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const res = await handleContactRequest(req, r.deps);
    assert.equal(res.status, 413);
    assert.ok(pulled < 20, `read ${pulled} chunks; it should stop just past 16 KiB`);
  });

  test('an invalid payload is a 400 and Google is never asked', async () => {
    const r = recorder();
    const res = await handleContactRequest(request({ ...VALID, email: 'nope' }), r.deps);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_payload');
    assert.ok(!r.calls.includes('captcha'));
  });

  test('malformed JSON is a 400', async () => {
    const r = recorder();
    const res = await handleContactRequest(request('{not json'), r.deps);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_json');
  });

  test('a filled honeypot is accepted and dropped without asking Google', async () => {
    const r = recorder();
    const res = await handleContactRequest(request({ ...VALID, _hp: 'bot' }), r.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(r.calls, ['rateLimit']);
  });

  test('a send failure keeps the stored row, marks it undelivered and answers 502', async () => {
    const r = recorder({ sendFails: true });
    const res = await handleContactRequest(request(VALID, { 'x-captcha-token': 'tok' }), r.deps);
    assert.equal(res.status, 502);
    assert.deepEqual(r.calls, ['rateLimit', 'captcha', 'store', 'send', 'undelivered']);
  });

  test('a cross-origin post is refused before anything else', async () => {
    const r = recorder();
    const res = await handleContactRequest(request(VALID), { ...r.deps, originAllowed: () => false });
    assert.equal(res.status, 403);
    assert.deepEqual(r.calls, []);
  });

  test('a non-JSON content type is refused', async () => {
    const r = recorder();
    const res = await handleContactRequest(
      request(VALID, { 'content-type': 'text/plain' }),
      r.deps,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_request');
  });
});
