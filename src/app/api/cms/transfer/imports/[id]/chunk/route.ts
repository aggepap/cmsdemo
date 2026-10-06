import { NextResponse, type NextRequest } from 'next/server';

import { isSameOrigin } from '@/cms/core/api/same-origin';
import { checkRateLimit, getClientIp } from '@/cms/core/rate-limit';
import { getStaging, TRANSFER_LIMITS } from '@/cms/core/transfer/runtime';
import { stagingToApiError } from '@/cms/core/transfer/routes';
import { StagingError } from '@/cms/core/transfer/staging';
import { PERMISSIONS, requireApiPerm } from '@/cms/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /api/cms/transfer/imports/:id/chunk?offset=N — one piece of an uploaded
 * package, as raw bytes.
 *
 * Hand-written rather than built with `createRoute()`, which parses JSON; like
 * the media upload route, it therefore applies the same-origin check, the rate
 * limit and the permission itself, in that order, and refuses an oversized body
 * from its declared length before reading it.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) {
    return NextResponse.json(
      { ok: false, error: 'forbidden', message: 'Cross-origin request rejected.' },
      { status: 403 }
    );
  }

  const limit = checkRateLimit('cms-transfer-chunk', getClientIp(req), {
    max: 600,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited', message: 'Too many requests.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  const auth = await requireApiPerm(PERMISSIONS.transferImport);
  if (auth instanceof NextResponse) return auth;

  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0 || declared > TRANSFER_LIMITS.chunkBytes) {
    return NextResponse.json(
      {
        ok: false,
        error: 'too_large',
        message: `Send the package in pieces of at most ${TRANSFER_LIMITS.chunkBytes} bytes.`,
      },
      { status: 413 }
    );
  }
  const offset = Number(new URL(req.url).searchParams.get('offset'));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json(
      { ok: false, error: 'invalid_input', message: 'Invalid offset.' },
      { status: 422 }
    );
  }

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length !== declared) {
    return NextResponse.json(
      { ok: false, error: 'invalid_input', message: 'Incomplete chunk.' },
      { status: 422 }
    );
  }

  const { id } = await ctx.params;
  try {
    const size = await getStaging().appendChunk(id, auth.userId, offset, body);
    return NextResponse.json({ ok: true, data: { offset: size } });
  } catch (err) {
    if (!(err instanceof StagingError)) throw err;
    const e = stagingToApiError(err);
    return NextResponse.json(
      {
        ok: false,
        error: e.code,
        message: e.message,
        ...(e.issues !== undefined ? { issues: e.issues } : {}),
      },
      { status: e.status }
    );
  }
}
