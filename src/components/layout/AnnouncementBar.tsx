'use client';

import { X } from 'lucide-react';
import { useCallback, useSyncExternalStore } from 'react';

import type { ResolvedAnnouncement } from '@/cms/core/settings/announcement';
import { Link } from '@/lib/i18n/routing';
import { STORAGE_KEYS } from '@/lib/storage-keys';

/**
 * The one-line announcement above the header (Settings → Announcement bar).
 *
 * The layout resolves the message on the server and passes it in, so a site
 * with the bar off ships nothing at all. Dismissal is remembered in this
 * browser against the message's content id — a new message shows again.
 *
 * It renders on the server as visible and hides after hydration for a visitor
 * who dismissed it: the other order would hide it from everyone until the
 * script ran, and from everyone without JavaScript for good.
 */

const DISMISSED_KEY = STORAGE_KEYS.announcementDismissed;
/** Same-tab notification: the `storage` event only fires in other tabs. */
const CHANGE_EVENT = `${DISMISSED_KEY}-changed`;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Storage can be missing or throw (private mode, blocked site data). Either
 *  way the answer is "not dismissed". */
export function isAnnouncementDismissed(storage: StorageLike | null, id: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DISMISSED_KEY) === id;
  } catch {
    return false;
  }
}

export function rememberAnnouncementDismissed(storage: StorageLike | null, id: string): void {
  if (!storage) return;
  try {
    storage.setItem(DISMISSED_KEY, id);
  } catch {
    // Blocked storage: the bar closes for this page view and comes back on the next.
  }
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

const linkClass =
  'underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-soft-pearl rounded-sm';

export function AnnouncementBar({
  announcement,
  labels,
}: {
  announcement: ResolvedAnnouncement | null;
  labels: { region: string; dismiss: string; newTab: string };
}) {
  const id = announcement?.id ?? '';
  const dismissed = useSyncExternalStore(
    subscribe,
    useCallback(() => (id ? isAnnouncementDismissed(browserStorage(), id) : false), [id]),
    () => false
  );

  if (!announcement || dismissed) return null;

  const dismiss = () => {
    rememberAnnouncementDismissed(browserStorage(), announcement.id);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  const { text, href, external } = announcement;
  const content = !href ? (
    text
  ) : external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {text}
      <span className="sr-only"> ({labels.newTab})</span>
    </a>
  ) : (
    <Link href={href} className={linkClass}>
      {text}
    </Link>
  );

  return (
    <section aria-label={labels.region} className="bg-midnight-navy text-soft-pearl">
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-3 px-6 py-2 text-center text-sm">
        <p className="flex-1">{content}</p>
        {announcement.dismissible ? (
          <button
            type="button"
            onClick={dismiss}
            aria-label={labels.dismiss}
            className="focus-visible:ring-soft-pearl -m-1 shrink-0 rounded-sm p-1 focus:outline-none focus-visible:ring-2"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </section>
  );
}
