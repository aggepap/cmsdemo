/**
 * Meta Conversions API — the pure half (REQ-5 §6).
 *
 * The server sends Purchase, Lead and CompleteRegistration (and whatever else
 * the admin switches on) at the moment of confirmation, with the SAME event id
 * and name as the browser's Pixel event, so Meta deduplicates them.
 *
 * Customer data: email and phone only as SHA-256 of the normalised value; the
 * `_fbp` / `_fbc` cookies, IP and user agent as they are — and all of it only
 * with Marketing consent. Without consent there is no server event at all
 * (`capiTarget` returns null).
 *
 * Sends go through a queue (`capi-queue.ts`) so a slow or failing Meta never
 * holds up an order; this file holds the rules the queue applies.
 */
import { createHash } from 'node:crypto';

import { CONSENT_COOKIE } from './consent-cookie';
import { scrubUrl } from './scrub';

import { META_CAPI_KEY, readMetaCapi, type MetaCapiSettings } from './meta-capi-settings';

export { META_CAPI_KEY, readMetaCapi };

export const CAPI_GRAPH_VERSION = 'v21.0';
export const CAPI_MAX_ATTEMPTS = 6;
/** Minutes before attempt n+1, by attempts made so far. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];

export { CONSENT_COOKIE };

export function hashed(normalised: string): string {
  return createHash('sha256').update(normalised).digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Digits only, with the country code, no `+` or leading zeros. A number given
 * without a country code (10 digits or fewer) gets `defaultCountryCode`.
 */
export function normalizePhone(phone: string, defaultCountryCode: string): string | null {
  let digits = phone.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 7) return null;
  if (!phone.trim().startsWith('+') && !phone.trim().startsWith('00') && digits.length <= 10) {
    digits = `${defaultCountryCode}${digits}`;
  }
  return digits;
}

export interface CapiUser {
  email?: string | null;
  phone?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CapiEventInput {
  eventName: string;
  eventId: string;
  eventTime: Date;
  sourceUrl: string;
  user: CapiUser;
  customData: Record<string, unknown>;
  phoneCountryCode: string;
}

export interface CapiEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: 'website';
  event_source_url?: string;
  user_data: Record<string, unknown>;
  custom_data: Record<string, unknown>;
}

export function buildCapiEvent(input: CapiEventInput): CapiEvent {
  const user: Record<string, unknown> = {};
  const email = input.user.email?.trim();
  if (email) user.em = [hashed(normalizeEmail(email))];
  const phone = input.user.phone ? normalizePhone(input.user.phone, input.phoneCountryCode) : null;
  if (phone) user.ph = [hashed(phone)];
  if (input.user.fbp) user.fbp = input.user.fbp;
  if (input.user.fbc) user.fbc = input.user.fbc;
  if (input.user.ip) user.client_ip_address = input.user.ip;
  if (input.user.userAgent) user.client_user_agent = input.user.userAgent;
  return {
    event_name: input.eventName,
    event_time: Math.floor(input.eventTime.getTime() / 1000),
    event_id: input.eventId,
    action_source: 'website',
    ...(input.sourceUrl ? { event_source_url: input.sourceUrl } : {}),
    user_data: user,
    custom_data: input.customData,
  };
}

export interface CapiReadiness {
  /** `META_CAPI_ACCESS_TOKEN`. */
  token: string | null;
  pixelId: string | null;
  /** Marketing consent, as the visitor gave it on the site. */
  consent: boolean;
  settings: MetaCapiSettings;
}

/** Where to send `eventName`, or null when it must not be sent from the server. */
export function capiTarget(eventName: string, ready: CapiReadiness): { url: string } | null {
  if (!ready.token || !ready.pixelId || !ready.consent) return null;
  if (!ready.settings.events.includes(eventName)) return null;
  return { url: `https://graph.facebook.com/${CAPI_GRAPH_VERSION}/${ready.pixelId}/events` };
}

export function capiRequestBody(data: unknown[], token: string, testEventCode: string | undefined) {
  return { data, access_token: token, ...(testEventCode ? { test_event_code: testEventCode } : {}) };
}

/** The banner's mirror cookie (`analytics,marketing`) as two flags. */
export function consentFromCookie(raw: string | undefined | null): { analytics: boolean; marketing: boolean } {
  const parts = new Set((raw ?? '').split(',').map((p) => p.trim()));
  return { analytics: parts.has('analytics'), marketing: parts.has('marketing') };
}

export function nextAttemptAt(attemptsMade: number, now: Date): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attemptsMade, BACKOFF_MINUTES.length) - 1] ?? BACKOFF_MINUTES[0];
  return new Date(now.getTime() + minutes * 60_000);
}

export type QueueStatus = 'pending' | 'sent' | 'failed';

export interface QueueOutcome {
  status: QueueStatus;
  attempts: number;
  sentAt?: Date;
  nextAttemptAt?: Date;
  lastError: string | null;
}

/** What a queue row becomes after one attempt. */
export function queueOutcome(result: { ok: true } | { ok: false; error: string }, attemptsBefore: number, now: Date): QueueOutcome {
  const attempts = attemptsBefore + 1;
  if (result.ok) return { status: 'sent', attempts, sentAt: now, lastError: null };
  if (attempts >= CAPI_MAX_ATTEMPTS) return { status: 'failed', attempts, lastError: result.error.slice(0, 500) };
  return { status: 'pending', attempts, nextAttemptAt: nextAttemptAt(attempts, now), lastError: result.error.slice(0, 500) };
}

export interface RequestAnalyticsContext {
  analytics: boolean;
  marketing: boolean;
  /** Marketing consent only: Meta's browser cookies, IP, user agent, page, browser event id. */
  fbp: string | null;
  fbc: string | null;
  ip: string | null;
  userAgent: string | null;
  sourceUrl: string | null;
  eventId: string | null;
  /** Analytics consent only: GA4's client id (`_ga`), for Measurement Protocol sends. */
  gaClientId: string | null;
}

const EVENT_ID = /^[A-Za-z0-9_-]{8,128}$/;

function cookieMap(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep it as sent */
    }
    out.set(name, value);
  }
  return out;
}

/** `GA1.1.123456789.1690000000` → `123456789.1690000000`. */
function gaClientIdFrom(cookie: string | undefined): string | null {
  const m = cookie?.match(/^GA\d\.\d+\.(\d+\.\d+)$/);
  return m ? m[1] : null;
}

/**
 * What a public request may contribute to server-side measurement — and only
 * what the visitor consented to. Read where the request is (a form post, the
 * checkout), stored with an order when payment confirms later.
 */
export function requestAnalyticsContext(headers: Headers): RequestAnalyticsContext {
  const cookies = cookieMap(headers.get('cookie'));
  const consent = consentFromCookie(cookies.get(CONSENT_COOKIE));
  const m = consent.marketing;
  const referer = headers.get('referer');
  const eventId = headers.get('x-cms-event-id');
  return {
    analytics: consent.analytics,
    marketing: m,
    fbp: m ? (cookies.get('_fbp') ?? null) : null,
    fbc: m ? (cookies.get('_fbc') ?? null) : null,
    ip: m ? (headers.get('x-real-ip')?.trim() || null) : null,
    userAgent: m ? (headers.get('user-agent')?.slice(0, 512) ?? null) : null,
    sourceUrl: m && referer ? scrubUrl(referer) || null : null,
    eventId: m && eventId && EVENT_ID.test(eventId) ? eventId : null,
    gaClientId: consent.analytics ? gaClientIdFrom(cookies.get('_ga')) : null,
  };
}

/**
 * The consented part of a request's context, as stored with an order for a
 * payment that confirms later (a webhook has no visitor to ask). `null` when the
 * visitor consented to nothing — then nothing is stored at all.
 */
export function toStoredAnalyticsContext(ctx: RequestAnalyticsContext): Record<string, unknown> | null {
  if (!ctx.analytics && !ctx.marketing) return null;
  return { ...ctx, eventId: null };
}

/** Read it back; anything malformed means no consent. */
export function storedAnalyticsContext(raw: unknown): RequestAnalyticsContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    analytics: r.analytics === true,
    marketing: r.marketing === true,
    fbp: str(r.fbp),
    fbc: str(r.fbc),
    ip: str(r.ip),
    userAgent: str(r.userAgent),
    sourceUrl: str(r.sourceUrl),
    eventId: null,
    gaClientId: str(r.gaClientId),
  };
}
