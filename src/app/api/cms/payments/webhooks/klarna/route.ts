/**
 * Klarna's HPP status callback.
 *
 * Unsigned — the handler re-reads the session from Klarna and trusts nothing
 * in the body but the session id (see `klarnaWebhookRoute`).
 */
import { NextResponse, type NextRequest } from 'next/server';

import { isModuleEnabled } from '@/cms/core';
import { klarnaWebhookRoute } from '@/cms/core/payments/webhooks';
// Side effect: attaches Stripe, PayPal, Viva and Klarna to the provider registry.
import '@/cms/core/payments/register';
import config from '@/site.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const post = klarnaWebhookRoute();

/** Gated on BOTH modules — this endpoint serves orders and reservations alike. */
async function enabled(): Promise<boolean> {
  const [commerce, booking] = await Promise.all([
    isModuleEnabled(config, 'commerce'),
    isModuleEnabled(config, 'booking'),
  ]);
  return commerce || booking;
}

export async function POST(req: NextRequest) {
  if (!(await enabled()))
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  return post(req);
}
