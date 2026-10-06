import 'server-only';

import { join } from 'node:path';

import { createStaging, type Staging } from './staging';

/**
 * Where transfers are staged and how large they may get. Outside `public/`:
 * a package may hold customer data, and is only ever served through the
 * owner-checked download route.
 */
const GIB = 1024 * 1024 * 1024;

export const TRANSFER_LIMITS = {
  /** Largest package accepted for import. */
  maxBytes: Number(process.env.CMS_TRANSFER_MAX_BYTES) || 2 * GIB,
  /** Upload chunk size. Below the 10 MB request ceiling a reverse proxy usually allows. */
  chunkBytes: 8 * 1024 * 1024,
  /** How long an untouched job is kept before `transfer-cleanup` removes it. */
  ttlMs: (Number(process.env.CMS_TRANSFER_TTL_HOURS) || 24) * 3600 * 1000,
  /** Work per step request — well inside a proxy's 60 s read timeout. */
  stepBudgetMs: 10_000,
  /** An import lock not refreshed for this long belongs to a run that died. */
  lockStaleMs: 5 * 60 * 1000,
} as const;

let staging: Staging | null = null;

export function getStaging(): Staging {
  if (!staging) {
    staging = createStaging({
      root: process.env.CMS_TRANSFER_DIR || join(process.cwd(), '.data', 'transfers'),
      maxBytes: TRANSFER_LIMITS.maxBytes,
      ttlMs: TRANSFER_LIMITS.ttlMs,
    });
  }
  return staging;
}

/** The `transfer-cleanup` cron job: remove every job untouched for longer than the TTL. */
export async function cleanupTransfers(): Promise<{ removed: number }> {
  return { removed: await getStaging().cleanupExpired(Date.now()) };
}
