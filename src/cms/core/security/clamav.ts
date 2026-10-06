/**
 * Virus scanning through clamd's INSTREAM command (G-V2-01).
 *
 * Optional, configured by the server's `.env`: `CLAMD_SOCKET` (a Unix socket)
 * or `CLAMD_HOST` [+ `CLAMD_PORT`, default 3310]. Unset means no scanner and
 * the verdict is `skipped`. Once one is configured it fails closed: a timeout,
 * a refused connection or an answer that is not exactly "OK" is an `error`,
 * which the caller treats as a refusal — never as clean.
 *
 * No dependency: the protocol is a command, length-prefixed chunks, a zero
 * terminator, and one line back.
 */
import { connect } from 'node:net';

export type ClamdTarget = { path: string } | { host: string; port: number };

export type ClamdVerdict =
  | { status: 'clean' }
  | { status: 'skipped' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; reason: string };

const DEFAULT_PORT = 3310;
const CHUNK = 64 * 1024;

/** The scanner named in the environment, or `null` when there is none. */
export function clamdTarget(
  env: Record<string, string | undefined> = process.env
): ClamdTarget | null {
  const socket = env.CLAMD_SOCKET?.trim();
  if (socket) return { path: socket };
  const host = env.CLAMD_HOST?.trim();
  if (!host) return null;
  const port = Number(env.CLAMD_PORT);
  return { host, port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT };
}

export function scanWithClamd(
  bytes: Uint8Array,
  target: ClamdTarget,
  timeoutMs = 15_000
): Promise<ClamdVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (verdict: ClamdVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };

    const socket = connect(target);
    socket.setTimeout(timeoutMs, () => done({ status: 'error', reason: 'timeout' }));
    socket.on('error', (err) => done({ status: 'error', reason: err.message }));

    let reply = '';
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const line = reply.replace(/\0/g, '').trim();
      const found = /^stream: (.+) FOUND$/.exec(line);
      if (line === 'stream: OK') done({ status: 'clean' });
      else if (found) done({ status: 'infected', signature: found[1] });
      else done({ status: 'error', reason: line.slice(0, 200) || 'empty reply' });
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let at = 0; at < bytes.byteLength; at += CHUNK) {
        const part = bytes.subarray(at, at + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.byteLength);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
