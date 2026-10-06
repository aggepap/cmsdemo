/**
 * Settings for the Meta Conversions API: which events also go from the server,
 * and Meta's Test Event Code. Client-safe (the settings schema imports it).
 *
 * The access token is NOT here: it is a server secret (`META_CAPI_ACCESS_TOKEN`
 * in `.env`, like the payment keys) — never in the database, the browser or an
 * export.
 */
import { z } from 'zod';

export const META_CAPI_KEY = 'marketing.metaCapi';

/** Meta's standard events a server send makes sense for. */
export const CAPI_EVENT_OPTIONS = [
  'Purchase',
  'Lead',
  'CompleteRegistration',
  'Contact',
  'InitiateCheckout',
  'AddPaymentInfo',
  'AddToCart',
  'AddToWishlist',
  'Search',
  'ViewContent',
] as const;

export const DEFAULT_CAPI_EVENTS: readonly string[] = ['Purchase', 'Lead', 'CompleteRegistration'];

export const metaCapiSchema = z
  .object({
    events: z.array(z.enum(CAPI_EVENT_OPTIONS)).max(CAPI_EVENT_OPTIONS.length),
    testEventCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{4,32}$/, 'is the code Meta shows under Test events (letters and digits)')
      .optional(),
  })
  .strict();

export interface MetaCapiSettings {
  events: string[];
  testEventCode?: string;
}

export function readMetaCapi(raw: unknown): MetaCapiSettings {
  const parsed = metaCapiSchema.safeParse(raw);
  return parsed.success ? parsed.data : { events: [...DEFAULT_CAPI_EVENTS] };
}
