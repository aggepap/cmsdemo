/**
 * Virus scanning of visitor uploads through clamd (G-V2-01).
 *
 * Optional: a host without ClamAV leaves `CLAMD_HOST`/`CLAMD_SOCKET` unset and
 * nothing is scanned. Once it is configured, the scan fails closed — a scanner
 * that cannot be reached is an error, never "clean".
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { after, describe, test } from 'node:test';

import { clamdTarget, scanWithClamd } from '@/cms/core/security/clamav';

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

/** A fake clamd: reads one INSTREAM request, then answers with `reply(bytes)`. */
async function fakeClamd(reply: (received: Buffer) => string): Promise<number> {
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const command = 'zINSTREAM\0';
      if (buf.length < command.length) return;
      assert.equal(buf.subarray(0, command.length).toString(), command);
      // Walk the length-prefixed chunks until the zero terminator.
      let at = command.length;
      const data: Buffer[] = [];
      while (at + 4 <= buf.length) {
        const size = buf.readUInt32BE(at);
        if (size === 0) {
          socket.end(`${reply(Buffer.concat(data))}\0`);
          return;
        }
        if (at + 4 + size > buf.length) return;
        data.push(buf.subarray(at + 4, at + 4 + size));
        at += 4 + size;
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('clamdTarget', () => {
  test('unset means no scanner', () => {
    assert.equal(clamdTarget({}), null);
  });

  test('a socket path wins over a host', () => {
    assert.deepEqual(clamdTarget({ CLAMD_SOCKET: '/run/clamd.sock', CLAMD_HOST: 'x' }), {
      path: '/run/clamd.sock',
    });
  });

  test('a host gets the standard port unless one is given', () => {
    assert.deepEqual(clamdTarget({ CLAMD_HOST: '127.0.0.1' }), { host: '127.0.0.1', port: 3310 });
    assert.deepEqual(clamdTarget({ CLAMD_HOST: 'av', CLAMD_PORT: '9999' }), {
      host: 'av',
      port: 9999,
    });
  });
});

describe('scanWithClamd', () => {
  test('streams the bytes and reports a clean file', async () => {
    let seen = '';
    const port = await fakeClamd((data) => {
      seen = data.toString();
      return 'stream: OK';
    });
    const verdict = await scanWithClamd(new TextEncoder().encode('%PDF-1.7 hello'), {
      host: '127.0.0.1',
      port,
    });
    assert.deepEqual(verdict, { status: 'clean' });
    assert.equal(seen, '%PDF-1.7 hello');
  });

  test('reports the signature of an infected file', async () => {
    const port = await fakeClamd(() => 'stream: Eicar-Test-Signature FOUND');
    const verdict = await scanWithClamd(new Uint8Array([1]), { host: '127.0.0.1', port });
    assert.deepEqual(verdict, { status: 'infected', signature: 'Eicar-Test-Signature' });
  });

  test('a scanner error is an error, not clean', async () => {
    const port = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    const verdict = await scanWithClamd(new Uint8Array([1]), { host: '127.0.0.1', port });
    assert.equal(verdict.status, 'error');
  });

  test('an unreachable scanner is an error, not clean', async () => {
    const verdict = await scanWithClamd(new Uint8Array([1]), { host: '127.0.0.1', port: 1 }, 500);
    assert.equal(verdict.status, 'error');
  });

  test('a large file goes in several chunks', async () => {
    let length = 0;
    const port = await fakeClamd((data) => {
      length = data.length;
      return 'stream: OK';
    });
    const big = new Uint8Array(200 * 1024).fill(7);
    assert.deepEqual(await scanWithClamd(big, { host: '127.0.0.1', port }), { status: 'clean' });
    assert.equal(length, big.length);
  });
});
