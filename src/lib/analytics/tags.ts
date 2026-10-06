/**
 * Which tag scripts a page gets, in what order — as data.
 *
 * The loader (`AnalyticsLoader`) renders these with `next/script`; keeping the
 * decision here makes it testable without a browser, and keeps the rules in one
 * readable place:
 *
 *   - nothing before consent — no script, no request, no cookie;
 *   - the Consent Mode v2 default is the first thing any Google tag sees, then
 *     the visitor's actual answer as an update, then the IDs GTM should read;
 *   - GTM with Analytics OR Marketing consent (Consent Mode tells its tags what
 *     they may do); gtag.js with Analytics; the Pixel with Marketing;
 *   - no `<noscript>` iframe or tracking image, ever.
 *
 * Every ID goes in through `scriptLiteral`, whatever the settings validated:
 * a row written before the guards existed must not be able to execute.
 */
import type { MarketingLoadPlan } from '@/cms/core/settings/marketing';

import { CONSENT_DEFAULT, googleConsentState, metaConsentAction, type MarketingConsent } from './consent';
import { SCRUB_FUNCTION_JS } from '@/cms/core/analytics/scrub';

export interface TagScript {
  /** Stable id: `next/script` runs a given id once per page life. */
  id: string;
  src?: string;
  inline?: string;
}

/** A JS literal safe inside a `<script>` element: quoted, escaped, and no `</script`. */
export function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const GTAG_STUB = 'window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}';

export interface TagScriptOptions {
  /**
   * The `page_view` event's switches. gtag's `config` and the Pixel's init send
   * the entry page view themselves; with a switch off they are told not to.
   */
  pageView?: { ga4: boolean; meta: boolean };
}

export function tagScripts(
  plan: MarketingLoadPlan,
  consent: MarketingConsent,
  { pageView = { ga4: true, meta: true } }: TagScriptOptions = {},
): TagScript[] {
  const scripts: TagScript[] = [];
  const any = consent.analytics || consent.marketing;
  const gtm = plan.gtmId && any ? plan.gtmId : null;
  const gtag = plan.gtagId && consent.analytics ? plan.gtagId : null;
  const pixel = plan.pixelId && consent.marketing ? plan.pixelId : null;

  if (gtm || gtag) {
    const ids = Object.keys(plan.dataLayerIds).length > 0 ? `\ndataLayer.push(${scriptLiteral(plan.dataLayerIds)});` : '';
    scripts.push({
      id: 'cms-consent',
      inline:
        `${GTAG_STUB}\n` +
        `gtag('consent', 'default', ${scriptLiteral(CONSENT_DEFAULT)});\n` +
        `gtag('consent', 'update', ${scriptLiteral(googleConsentState(consent))});` +
        ids,
    });
  }

  if (gtm) {
    scripts.push({
      id: 'cms-gtm',
      inline:
        "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});" +
        'var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;' +
        "j.src='https://www.googletagmanager.com/gtm.js?id='+encodeURIComponent(i);f.parentNode.insertBefore(j,f);" +
        `})(window,document,'script','dataLayer',${scriptLiteral(gtm)});`,
    });
  }

  if (gtag) {
    /*
     * The `config` command sends the entry page_view itself, built from
     * `location.href` unless told otherwise — so `page_location` is passed
     * explicitly, scrubbed (see `scrub.ts`).
     */
    scripts.push({
      id: 'cms-gtag-config',
      inline:
        `${SCRUB_FUNCTION_JS}\n` +
        "gtag('js', new Date());\n" +
        `gtag('config', ${scriptLiteral(gtag)}, { page_location: cmsScrub(location.href)${pageView.ga4 ? '' : ', send_page_view: false'} });`,
    });
    scripts.push({ id: 'cms-gtag', src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gtag)}` });
  }

  if (pixel) {
    scripts.push({
      id: 'cms-pixel',
      inline:
        '!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?' +
        'n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;' +
        "n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;" +
        't.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}' +
        "(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');\n" +
        `fbq('consent', '${metaConsentAction(true)}');\n` +
        `fbq('init', ${scriptLiteral(pixel)});` +
        (pageView.meta ? "\nfbq('track', 'PageView');" : ''),
    });
  }

  return scripts;
}

/**
 * Whether this is the production site — the apex or `www` of `siteUrl`. Tags
 * never load on staging, previews or localhost, whatever the settings say.
 */
export function isProductionHost(hostname: string, siteUrl: string): boolean {
  let host: string;
  try {
    host = new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.replace(/^www\./, '');
  const current = hostname.toLowerCase();
  return current === bare || current === `www.${bare}`;
}
