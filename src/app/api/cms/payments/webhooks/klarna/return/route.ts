/**
 * Where Klarna sends the customer after paying: reconcile, then redirect to the
 * return URL stored when the payment started (see `klarnaReturnRoute`).
 */
import { NextResponse, type NextRequest } from 'next/server';

import { isModuleEnabled } from '@/cms/core';
import { klarnaReturnRoute } from '@/cms/core/payments/webhooks';
// Side effect: attaches Stripe, PayPal, Viva and Klarna to the provider registry.
import '@/cms/core/payments/register';
import config from '@/site.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const get = klarnaReturnRoute();

/** Gated on BOTH modules — a Klarna payment can belong to an order or a reservation. */
async function enabled(): Promise<boolean> {
  const [commerce, booking] = await Promise.all([
    isModuleEnabled(config, 'commerce'),
    isModuleEnabled(config, 'booking'),
  ]);
  return commerce || booking;
}

export async function GET(req: NextRequest) {
  if (!(await enabled()))
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  return get(req);
}
