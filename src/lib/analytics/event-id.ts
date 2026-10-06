/**
 * An id for one event, shared by the browser send and the server's Meta
 * Conversions API send so Meta counts it once (`eventID` / `event_id`).
 */
export function newEventId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
