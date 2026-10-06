'use client';

import { useEffect, useRef } from 'react';

import { track, type TrackOptions } from '@/lib/analytics/runtime';

/**
 * Sends one catalogue event when a page shows — for the events a SERVER page
 * knows to be true by rendering at all: a product page is `view_item`, a list
 * of results is `view_item_list`, a results page for `?q=` is `search`.
 *
 * `params` must be built on the server; `dedupeKey` changes when the event is a
 * new one (another product, another query), so a re-render does not repeat it.
 */
export function TrackEvent({
  id,
  params,
  dedupeKey,
  options,
}: {
  id: string;
  params: Record<string, unknown>;
  dedupeKey: string;
  options?: TrackOptions;
}) {
  // Fresh objects on every render; the event is keyed on `dedupeKey`, not on them.
  const latest = useRef({ params, options });
  useEffect(() => {
    latest.current = { params, options };
  });
  useEffect(() => {
    track(id, latest.current.params, latest.current.options);
  }, [id, dedupeKey]);
  return null;
}
