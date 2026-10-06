'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { Suspense, useEffect, useRef } from 'react';

import type { EventSwitches } from '@/cms/core/analytics/catalog';
import {
  matchCustomClick,
  matchCustomDownload,
  matchCustomSection,
  matchCustomVideo,
  type CustomEvent,
  type CustomHit,
} from '@/cms/core/analytics/custom-events';
import { ANALYTICS_CATEGORY_KEY, MARKETING_CATEGORY_KEY } from '@/cms/core/cookies/defaults';
import type { MarketingLoadPlan } from '@/cms/core/settings/marketing';
import { useCategoryConsent, useConsent } from '@/components/layout/CookieBanner';
import { googleConsentState, metaConsentAction } from '@/lib/analytics/consent';
import {
  clickEventFor,
  configureAnalyticsRuntime,
  track,
  trackCustomHits,
  trackPageView,
} from '@/lib/analytics/runtime';
import { scrubQuery, scrubUrl } from '@/cms/core/analytics/scrub';
import { isProductionHost, tagScripts } from '@/lib/analytics/tags';

export { scrubQuery, scrubUrl };

/**
 * GA4, Google Tag Manager and the Meta Pixel — consent-gated, SPA-aware.
 *
 * What loads is decided by `tagScripts` (see `src/lib/analytics/tags.ts`) from
 * the plan the layout resolves out of Settings → Analytics & Marketing, and from
 * the visitor's answer for the two cookie categories:
 *
 *   Analytics (Στατιστικά) → GA4 and `analytics_storage`
 *   Marketing (Μάρκετινγκ) → the Pixel and `ad_storage`/`ad_user_data`/`ad_personalization`
 *
 * Only in a production build, and only on the production host (the apex or
 * `www` of `siteUrl`) — never on staging, a preview or localhost. Never in the
 * admin: this is rendered by the public layout only.
 *
 * Consent is read through `useCategoryConsent`, backed by `useSyncExternalStore`,
 * so an "Accept" switches tags on without a reload, and a later withdrawal is
 * passed to Consent Mode and to the Pixel at once — without a reload either.
 * A script that has already run cannot be unloaded; it is told to stop instead.
 */

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
    fbq?: (...args: unknown[]) => void;
  }
}

/**
 * `page_view` on the entry page and on every page change without a reload,
 * through the runtime (`trackPageView`): the entry one goes to the dataLayer
 * only — gtag's `config` and the Pixel's init already sent theirs — and later
 * ones go everywhere their switches allow. Reads search params, hence the
 * <Suspense> around it.
 */
function PageViews() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isFirstRun = useRef(true);

  useEffect(() => {
    trackPageView(isFirstRun.current);
    isFirstRun.current = false;
  }, [pathname, searchParams]);

  return null;
}

/** How far up from the clicked node a click trigger is looked for. */
const MAX_CLICK_DEPTH = 8;

/** The custom events a click on `start` triggers: click, download and video triggers. */
function customClickHits(events: readonly CustomEvent[], start: Element): CustomHit[] {
  const hits: CustomHit[] = [];
  let node: Element | null = start;
  for (let depth = 0; node && depth < MAX_CLICK_DEPTH; depth += 1, node = node.parentElement) {
    hits.push(...matchCustomClick(events, node));
  }
  const link = start.closest('a');
  const href = link?.getAttribute('href');
  if (link && href) {
    hits.push(...matchCustomDownload(events, href));
    const videoUrl = link.getAttribute('data-cms-video-url');
    if (videoUrl) {
      hits.push(
        ...matchCustomVideo(events, {
          title: link.getAttribute('data-cms-video-title') ?? '',
          url: videoUrl,
          provider: link.getAttribute('data-cms-video-provider') ?? '',
        }),
      );
    }
  }
  return hits;
}

/**
 * Calls, mail links, downloads and content cards, and the click / download /
 * video custom events — one delegated listener for the page.
 */
function useClickTracking(customEvents: readonly CustomEvent[]) {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest('a, [data-cms-content-type]');
      const hit = target ? clickEventFor(target) : null;
      if (hit) track(hit.id, hit.params);
      if (customEvents.length > 0) trackCustomHits(customClickHits(customEvents, event.target));
    }
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, [customEvents]);
}

/** "Section shown" custom events: once per page view, when the section scrolls into view. */
function SectionViews({ customEvents }: { customEvents: readonly CustomEvent[] }) {
  const pathname = usePathname();
  useEffect(() => {
    const ids = customEvents.flatMap((e) => (e.trigger.type === 'view' && e.trigger.sectionId ? [e.trigger.sectionId] : []));
    if (ids.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        trackCustomHits(matchCustomSection(customEvents, entry.target.id, pathname));
      }
    }, { threshold: 0.5 });
    for (const id of new Set(ids)) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [customEvents, pathname]);
  return null;
}

export interface AnalyticsLoaderProps {
  plan: MarketingLoadPlan;
  /** Every catalogue event's GA4 / Meta switch (Settings → Analytics & Marketing → Events). */
  switches: EventSwitches;
  /** Settings → Analytics & Marketing → Custom events. */
  customEvents?: readonly CustomEvent[];
  /** The production origin (`NEXT_PUBLIC_SITE_URL`). Tags load only on its host. */
  siteUrl: string;
  locales: readonly string[];
  /** A signed-in administrator: every event is logged to the console. */
  debug?: boolean;
}

const NO_CUSTOM_EVENTS: readonly CustomEvent[] = [];

export function AnalyticsLoader({
  plan,
  switches,
  customEvents = NO_CUSTOM_EVENTS,
  siteUrl,
  locales,
  debug = false,
}: AnalyticsLoaderProps) {
  const analytics = useCategoryConsent(ANALYTICS_CATEGORY_KEY);
  const marketing = useCategoryConsent(MARKETING_CATEGORY_KEY);
  const snapshot = useConsent();
  const decided = snapshot !== 'loading' && snapshot !== 'undecided';
  const live = process.env.NODE_ENV === 'production' && typeof window !== 'undefined' && isProductionHost(window.location.hostname, siteUrl);
  const scripts = live && decided ? tagScripts(plan, { analytics, marketing }, { pageView: switches.page_view }) : [];
  const loaded = new Set(scripts.map((s) => s.id));

  useClickTracking(customEvents);

  /*
   * After the tag scripts above have run (child effects run first), so the
   * consent default is already in the dataLayer when queued events flush.
   */
  const gtm = loaded.has('cms-gtm');
  const gtag = loaded.has('cms-gtag');
  const pixel = loaded.has('cms-pixel');
  useEffect(() => {
    configureAnalyticsRuntime({
      switches,
      customEvents,
      gtm,
      gtag,
      pixel,
      consent: { analytics, marketing },
      decided,
      locales,
      debug,
    });
  }, [switches, customEvents, gtm, gtag, pixel, analytics, marketing, decided, locales, debug]);

  /*
   * A change of mind after the tags loaded. The scripts' own inline setup covers
   * the state they load with; this covers every change after it — including a
   * withdrawal, which unmounting a <Script> could never undo.
   */
  useEffect(() => {
    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'update', googleConsentState({ analytics, marketing }));
    }
    if (typeof window.fbq === 'function') {
      window.fbq('consent', metaConsentAction(marketing));
    }
  }, [analytics, marketing]);

  return (
    <>
      {scripts.map((s) =>
        s.src ? (
          <Script key={s.id} id={s.id} src={s.src} strategy="afterInteractive" />
        ) : (
          <Script key={s.id} id={s.id} strategy="afterInteractive">
            {s.inline}
          </Script>
        ),
      )}
      <Suspense fallback={null}>
        <PageViews />
      </Suspense>
      <SectionViews customEvents={customEvents} />
    </>
  );
}
