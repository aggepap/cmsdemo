# REQ-5 · Analytics & Marketing — hand-off to the Planner

What the CMS now does for GA4, Google Tag Manager, the Meta Pixel, the Meta
Conversions API and Google Ads, and what a site has to do (or must not do) to
use it. Written for applying the feature to existing and new sites.

## 1. Version, and what `cms:update` brings

| Commit | What |
|---|---|
| `db749c5` | REQ-1/2/3 — captcha on public forms, per-route headers, launch notes (prerequisite: the header module the CSP below builds on) |
| `001c4c3` | 5a — settings, loaders, Consent Mode v2, per-request CSP |
| `9f8b476` | 5b — event catalogue, profiles, switches, core events |
| `e129b38` | 5c — custom events + in-admin guide |
| `bed27ff` | 5d — GTM container export, Google Ads |
| `9914157` | 5e — Meta Conversions API (queue), GA4 refunds |
| `468eda0` | 5f — status panel, docs |

`npm run cms:update` then, on each site:

- **Migration:** `0026_deep_blue_shield` creates `analytics_capi_queue`. Run
  `npm run db:migrate` before the new build serves traffic.
- **No new npm dependencies.**
- **New env vars** (server `.env`, all optional — blank = that part is off):
  `META_CAPI_ACCESS_TOKEN`, `META_CAPI_PHONE_COUNTRY_CODE` (default `30`),
  `GA4_MP_API_SECRET`. `.env.example` lists them; the updater reports the diff.
- **New cron job:** `analytics-capi-flush`, every 5–15 minutes, only needed with
  the Conversions API in use (`POST /api/cms/cron/analytics-capi-flush`,
  `x-cron-secret`).
- **Files the updater does not write** and a site must port by hand if it has its
  own copy: `src/app/[locale]/layout.tsx` (new `AnalyticsLoader` props and the
  Meta verification meta tag — compare with the base or with
  `.claude/skills/new-site/templates/base/locale-layout.tsx.tpl`), `.env.example`.

## 2. Settings

All under **Admin → Settings → Analytics & Marketing**. The first sub-tab
("General") holds the plain fields; the others are their own screens.

| Key | Type / values | Default | Where |
|---|---|---|---|
| `analytics.gaMeasurementId` | `G-…` (existing) | — (falls back to `NEXT_PUBLIC_GA_MEASUREMENT_ID`) | General |
| `analytics.gtmContainerId` | `GTM-…` | — | General |
| `analytics.ga4ViaGtm` | `on` / `off` | `off` | General |
| `marketing.metaPixelId` | digits | — | General |
| `marketing.metaPixelViaGtm` | `on` / `off` | `off` | General |
| `marketing.metaDomainVerification` | letters/digits | — | General |
| `analytics.tracking` | `{ profiles?: ('website'\|'eshop'\|'booking')[], events?: { [eventId]: { ga4?: bool, meta?: bool } } }` | profiles suggested from the modules; no overrides | Events |
| `analytics.customEvents` | list (see §3) | `[]` | Custom events |
| `marketing.googleAds` | `{ conversionId?: 'AW-…', labels: { [eventId]: label } }` | `{ labels: {} }` | GTM export |
| `marketing.metaCapi` | `{ events: MetaStandardEvent[], testEventCode?: string }` | `Purchase, Lead, CompleteRegistration` | Status |
| `security.publicFormsCaptcha` | `off` / `recaptcha_v2` | `off` | Settings → Security (REQ-1) |

Machine state, never set by hand and never transferred: `analytics.gtmLastExport`.

Setting them from a seed/script (new or existing site): write the same keys with
`setSetting(key, value)` (`src/cms/core/settings`), or `PATCH /api/cms/settings`
with an admin session. Values are validated at the write boundary; an ID in the
wrong shape is refused, and a stored malformed ID reads as unset.

The secrets are **not** settings: `META_CAPI_ACCESS_TOKEN` and
`GA4_MP_API_SECRET` live only in the server `.env`.

## 3. What site code does

### Sending an event from a site's own component

```ts
import { track } from '@/lib/analytics/runtime';

track(eventId, params, { eventId?: string, once?: string });
```

- **Client side only**, and **only after the server confirmed the action**
  (after the `res.ok` of your own fetch) — never on the button click.
- `eventId` is a catalogue id (table in §4) or a custom event name.
- `params`: the event's own parameters. The common four (`page_location`,
  `page_title`, `page_type`, `language`) are added for you. Never put email,
  name, phone or address in — they are stripped anyway.
- `{ eventId }` when the server also sends the event to Meta (see below), so
  Meta deduplicates; `{ once: 'purchase:<ref>' }` to send at most once per
  browser (thank-you pages).
- Safe to call any time: before consent it waits; refused consent drops it.

A server page that knows an event is true by rendering (a product page, a
results page) uses `<TrackEvent id params dedupeKey />`
(`@/components/analytics/TrackEvent`).

**A new form** (e.g. eyelike's prescription form):

1. Pick a stable `form_id` in snake_case (`prescription_request`).
2. After its POST answers 2xx: `track('generate_lead', { form_id: 'prescription_request', form_name: 'Prescription' }, { eventId })`,
   where `eventId = newEventId()` (`@/lib/analytics/event-id`) is also sent to
   the server as the `x-cms-event-id` header.
3. For a server-side Lead too, in the route after the work succeeded:
   ```ts
   const context = requestAnalyticsContext(req.headers);           // @/cms/core/analytics/meta-capi
   await queueCapiEvent({ eventName: 'Lead', eventId: context.eventId ?? `prescription-${id}`,
     user: { email, phone }, customData: { form_id: 'prescription_request' }, context });  // @/cms/core/analytics/capi-queue
   ```
   It sends nothing without Marketing consent and never throws.
4. Custom events with trigger "Form sent" fire on the same `form_id` automatically.

**A site's own checkout or product cards:** use `cartItemsPayload` /
`productListPayload` / `productLinkAttributes` from `@/lib/analytics/items`; for
`purchase` use the server-built `analytics` object the checkout API returns
(`createOrder(...).analytics`) — do not compute amounts in the browser.

### Already sent by core components — do not re-implement

Contact form (`generate_lead`), newsletter band (`newsletter_sign_up`), account
login (`login`) and email confirmation (`account_sign_up`), shop list/category/tag
pages (`view_item_list`, `search`), `ProductCard` with `listId` (`select_item`),
product page and booking page (`view_item`), `CartProvider` (`add_to_cart`,
`remove_from_cart`, `view_cart`), `WishlistProvider` (`add_to_wishlist`),
`CheckoutClient` (`begin_checkout`, `add_shipping_info`, `add_payment_info`,
`add_coupon`, `purchase`), `BookingForm` (lead / `begin_checkout` / `purchase`),
`BookingPayClient` (`purchase` on card success), `ContentCard`
(`select_content`), page views, and — via one delegated listener — `tel:`
(`click_to_call`), `mailto:` (`click_to_email`, domain only), document links
(`file_download`).

A site that replaces one of these components takes over its event.

### Marking elements for custom events

- Click trigger: `data-track="virtual-tour"` on the element (or use its `#id` /
  `.class` in the admin).
- Section trigger: give the section an `id`.
- Video trigger: `[video]` blocks carry `data-cms-video-*` already.
- A page that is not what its URL suggests can set `data-cms-page-type="…"` on
  any element to override `page_type`.

## 4. The event list, as built

Common parameters on every event: `page_location` (sensitive query values
redacted), `page_title`, `page_type`, `language`. W = Website, E = E-shop, B = Booking.

| id | GA4 | Meta | W | E | B | Parameters |
|---|---|---|---|---|---|---|
| `page_view` | page_view | PageView | ✔ | ✔ | ✔ | — |
| `search` | search | Search | ✔ | ✔ | ✔ | search_term |
| `select_content` | select_content | custom (off) | ✔ | ✔ | ✔ | content_type, content_id |
| `generate_lead` | generate_lead | Lead | ✔ | ✔ | ✔ | form_id, form_name |
| `click_to_call` | click_to_call | Contact | ✔ | ✔ | ✔ | link_url |
| `click_to_email` | click_to_email | Contact | ✔ | ✔ | ✔ | link_url (`mailto:`), link_domain |
| `file_download` | file_download | custom (off) | ✔ | ✔ | ✔ | file_name, file_extension, link_url |
| `newsletter_sign_up` | sign_up (method=newsletter) | Lead (lead_type=newsletter) | ✔ | ✔ | ✔ | method, form_id |
| `account_sign_up` | sign_up (method=email) | CompleteRegistration | | ✔ | | method |
| `login` | login | — | | ✔ | | method |
| `view_item_list` | view_item_list | — | | ✔ | | item_list_id, items |
| `select_item` | select_item | custom (off) | | ✔ | | item_list_id, items |
| `view_item` | view_item | ViewContent | | ✔ | ✔ | items, value, currency |
| `add_to_wishlist` | add_to_wishlist | AddToWishlist | | ✔ | | items |
| `add_to_cart` / `remove_from_cart` / `view_cart` | same | AddToCart / — / — | | ✔ | | items, value, currency |
| `begin_checkout` | begin_checkout | InitiateCheckout | | ✔ | ✔ | items, value, currency |
| `add_shipping_info` | add_shipping_info | — | | ✔ | | shipping_tier |
| `add_payment_info` | add_payment_info | AddPaymentInfo | | ✔ | | payment_type |
| `add_coupon` | add_coupon | custom (off) | | ✔ | | coupon |
| `purchase` | purchase | Purchase | | ✔ | ✔ | transaction_id, value, tax, shipping, currency, coupon, items |
| `refund` | refund (server, Measurement Protocol) | — | | ✔ | ✔ | transaction_id, value, currency |

Differences from REQ-5, with reasons:

- **Two catalogue ids for `sign_up`** (`newsletter_sign_up`, `account_sign_up`):
  they need different Meta events and switches; GA4 still sees `sign_up` with
  `method`.
- **`click_to_email` sends `mailto:` and `link_domain`, not the address** — an
  email address in `link_url` would be personal data.
- **`account_sign_up` fires when the confirmation link is used**, not on the
  register form: registration answers the same whether or not the email already
  existed, so the form's success is not proof of a new account.
- **Gift cards** appear in `purchase` as items with `item_category: gift_card`,
  named by the product (their label carries the recipient).
- **`tax`** is the VAT inside the (VAT-inclusive) total: per line at its rate,
  reduced pro rata by a coupon, plus VAT on shipping at the shop's default rate.
- **Product cards identify a product by slug**, the cart and the server
  `purchase` by SKU when there is one (cards have no SKU). Map them in GA4 if needed.
- **Meta parameters** are mapped by the CMS (`content_ids`, `contents`,
  `content_type`, `num_items`, `search_string`) and pushed to the dataLayer as
  `cms_meta` for the GTM Meta tags.

Custom events (§4 of REQ-5): name snake_case ≤ 40 (GA4-reserved names/prefixes
and catalogue names refused), trigger click / download / video / view / form
with the standard parameters (`element_id, element_text, link_url` ·
`file_name, file_extension, link_url` · `video_title, video_url, video_provider`
· `page_path, section_id` · `form_id, form_name`), up to 5 fixed parameters,
GA4 / Meta switches; Meta always `trackCustom`.

## 5. Consent and cookies

- Nothing loads, no event is sent and no Google/Meta request is made before
  the visitor answers the banner. Consent Mode v2 default: all four signals
  `denied`, `wait_for_update: 500`; "Analytics" grants `analytics_storage`,
  "Marketing" grants `ad_storage`, `ad_user_data`, `ad_personalization` and the
  Pixel (`fbq('consent','grant')`). Changes apply without a reload, withdrawal
  included.
- Declared automatically in the cookie declaration while the provider is on:
  Google Analytics (`_ga`, `_ga_*`, `_gid`) under Analytics; Meta Pixel (`_fbp`,
  `_fbc`) and Google Ads (`_gcl_*`, when a conversion ID is set and GTM is used)
  under Marketing; Google reCAPTCHA under Necessary (REQ-1).
- The banner also writes a first-party cookie `cms_consent`
  (`analytics,marketing`) so the server knows; it falls under the existing
  "Session & consent" necessary entry.
- **The site must add** to its privacy policy the Conversions API paragraph
  shown under Settings → Analytics & Marketing → Status (Greek and English
  provided) when the Conversions API is used.

## 6. CSP / headers

- The proxy sends each page's `Content-Security-Policy`. Google hosts
  (`www.googletagmanager.com`, `www.google-analytics.com`,
  `*.google-analytics.com`, `*.analytics.google.com`,
  `googleads.g.doubleclick.net`, `www.googleadservices.com`, `www.google.com`
  for img/connect) are added only while a GA4 or GTM ID is set; Meta hosts
  (`connect.facebook.net`, `www.facebook.com`) only while a Pixel ID is set.
  No tracking host ever gets `frame-src`; no `<noscript>` iframe or image is
  rendered.
- Pages that may carry a form (`/`, `/<page>`, `/<locale>/<page>`) also allow
  reCAPTCHA and drop COEP (REQ-2); fixed routes keep the strict policy.
- **The site does nothing** — unless Nginx adds its own CSP: then it must allow
  the same hosts, or the tags are blocked.

## 7. How to check it on a site

CMS tests covering it: `test/core/marketing-config.test.ts`,
`page-csp.test.ts`, `analytics-events.test.ts`, `analytics-runtime.test.ts`,
`custom-events.test.ts`, `gtm-export.test.ts`, `meta-capi.test.ts`,
`test/commerce/purchase-analytics.test.ts`, `order-capi.test.ts`,
`test/lib/analytics-items.test.ts`, `consent-cookie.test.ts`,
`contact-handler.test.ts`, `test/cms/marketing-declaration.test.ts`,
`analytics-events-admin.test.tsx`, `custom-events-admin.test.tsx`,
`gtm-export-admin.test.tsx`, `analytics-status.test.tsx`.

QA scenario (production build on the real domain):

1. Settings → Analytics & Marketing: set the IDs; Status shows each provider
   as "Loads after consent" / "Loads through GTM".
2. Open the site in a private window: Network shows no request to Google or
   Meta, Application → Cookies shows no `_ga`/`_fbp`. Reject → still none.
3. Accept all: tags load without a reload; GA4 Realtime shows the visit.
4. Signed in as admin, the console shows `[cms analytics] …` for each event.
5. Send the contact form: `generate_lead` once. With a wrong captcha: none.
6. E-shop: add to cart, checkout with bank transfer: `purchase` with the
   order's amounts; reload the thank-you state — no second purchase. With the
   Test Event Code set, Meta Test events shows the browser and server Purchase
   merged (same event id).
7. GTM: Settings → GTM export → Download, import (Merge → Overwrite), Preview
   with Tag Assistant: the `CMS · …` tags fire on the events. Import a second
   time: no duplicates.
8. Withdraw consent from the cookie settings: no further events.

## 8. Limitations / not done — record as CMS findings, do not build in the site

- **GA4 `purchase` for hosted-redirect payments** (PayPal, Viva, Klarna hosted
  pages): the customer returns to the order-lookup page, not a thank-you page,
  so the browser sends no `purchase`. Meta still gets it server-side (Conversions
  API at payment capture). GA4 would need a thank-you page on the return URL or
  a Measurement Protocol purchase — CMS work, not site work.
- **The GTM import itself was not run against a real GTM account** in this
  work. The JSON's structure is tested (references, ids, consent, names), and
  the Meta tag template is our own ("CMS · Meta Pixel"), not Meta's gallery
  template. First real import should be checked on a test container.
- **Tag Assistant and COOP:** the site sends `Cross-Origin-Opener-Policy:
  same-origin`, which can stop Tag Assistant's window from connecting. Use the
  Tag Assistant Companion extension, or report it if it blocks QA.
- **Refunds to GA4** need `GA4_MP_API_SECRET`; without the shopper's `_ga` id
  (no Analytics consent at checkout) a stand-in client id is used — the refund
  still matches its purchase by `transaction_id`.
- **The captcha's COEP relaxation** applies to all CMS page routes even while
  the captcha is off (the static headers are built at build time).
- **Contact endpoint order**: origin and content-type checks run before the rate
  limit (they are cheaper than it); otherwise rate limit → size → schema →
  honeypot → captcha → store → send as asked.
- Google Ads tags exist only through GTM (no direct Ads loader).
