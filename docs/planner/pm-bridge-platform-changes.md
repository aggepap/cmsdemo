# PM bridge: changes needed on the platform (leadsconcetrator)

**For:** the praion.ai / Product Manager team
**From:** CMS (iWebforyou base)
**Date:** 2026-10-05
**Wire spec:** `docs/PM_BRIDGE_SPEC.md` (in this repo; same as `praion/docs/PM_BRIDGE_SPEC.md`, plus the amendments listed at its top)

The CMS side of the bridge has been brought up to date with what the platform sends. Several things still can't work until the platform changes too. They are listed below, most damaging first. File references are to `leadsconcetrator/backend/`.

---

## 1. `PATCH /payload` sends the WordPress shape: every compiled payload is lost (blocker)

`PagePushService` (around `:331-348`) builds this body, and `PraionAdapter::pushPagePayload` sends it unchanged:

```json
{ "translation": {...}, "override": true,
  "payloads": { "head_meta": "<title>…</title><meta …>", "jsonld": "{\"@context\"…}", "alternates": "[…]" } }
```

The CMS (and the spec, §7.6) expects:

```json
{ "remote_type": "product", "remote_id": "doc:42", "path": "/shop/foo",
  "head_meta": { "title": "…", "description": "…", "robots": "index, follow", "canonical": "…",
                 "og_title": "…", "og_description": "…", "og_image": "…", "twitter_card": "…" },
  "jsonld": [ { "@type": "…" } ],          // or { "@context": …, "@graph": [ … ] }
  "alternates": [ { "hreflang": "en", "href": "…" } ],
  "seo_override": true,
  "compiled_at": "2026-10-05T09:00:00Z" }
```

Today the CMS finds no `remote_id` or `path`, answers **404 `not_found`**, and `interpret()` logs it as `failure: "HTTP 404"`. **No compiled head or JSON-LD has ever reached a Praion site.**

What to change, in `PraionAdapter::pushPagePayload` (Praion only; WordPress keeps its shape):

- `remote_type` and `remote_id` come from the translation's `remote_type` and `remote_id`. `path` comes from its `slug`, as a path starting with `/`. When `remote_id` resolves, the CMS uses its own path, so `path` is only a fallback.
- **`head_meta` must be an object of strings**, at most 40 keys, each value at most 5000 characters. Build it from the same inputs `PageCompilerService` uses, not by parsing the HTML string.
- **`jsonld` must be decoded JSON**, not a string. That means an array of nodes, or an object with `@graph`.
  - Every node needs an `@type`.
  - At most 100 nodes.
  - No string may contain `</script`.
  - No `__proto__`, `constructor` or `prototype` keys.
- `alternates` must be an array. It is stored but not rendered (`capabilities.alternates: false`).
- `seo_override` must be a boolean, and `compiled_at` an ISO timestamp.
- Pass `?locale=` for archive refs. A document's locale comes from the document itself.
- **Surface the response's `errors.payload`.** A validation failure is HTTP **200** with `{written:0, errors:{payload:"…"}}`, and `collect()` currently only logs it.

## 2. Page `image_alts` ids are cast to int (blocker for page alt text)

`PagePushService::imageAltsForPush` (`:287`) does `'image_id' => (int) $id`. On Praion, `images[].id` is a **media UUID**, so `"5c1e…"` becomes `5`.

- The CMS now treats a numeric id as an id that matches nothing, and reports it in `errors.image_alts`. It does **not** read it as a position, because that would put one image's alt on another.
- Fix: keep the id as a string for Praion. In `PmDefaultFieldDefinitionSeeder`, the `image_alts.image_id` subfield is typed `number` with `min: 1`; it needs to allow strings.

Products already pass ids through unchanged, so product alt text works once the scope below is granted.

## 3. Credential scopes

`image_alts` inside `values` (pages and products) is now accepted by the CMS (spec §6.1, "routed to §8"). It requires the **`pm:media`** scope **in addition to** `pm:write`; otherwise it returns `errors.image_alts = "This credential lacks the pm:media scope…"`.

- The setup flow should tell admins to import the credential with `pm:read pm:write pm:payload pm:media`, or with `pm:*`.
- `/payload` needs `pm:payload`.

## 4. `POST /products` now exists on the CMS: please check the integration

Implemented as the `createProduct()` docblock describes, with these site-side rules:

- The product is **always created as a draft.** `status` is ignored, because publishing stays a person's decision in the CMS admin.
- **Idempotent by `idempotency_key`:**
  - A repeat returns **200** with the existing product.
  - A concurrent repeat while the first is still running gets **409 `duplicate`**, with the message "still in progress".
- **409 `duplicate`** when the slug or SKU already exists in that language.
- **Response:** `201 {data:{id:int, remote_id:"doc:N", type:"simple", slug, permalink, status:"draft", images:[{local_id, id:uuid, src, alt}]}}`.
- **Images are fetched by the site**, only from hosts in the site's env var `CMS_PM_IMAGE_HOSTS` (comma list), over **HTTPS** only, with redirects refused, max 15 MB, max 20 images.
  - A failed image is **non-fatal**: the response is still 201, with `warnings.image_fetch_failed: [local_id…]` (and `warnings.image_hosts` when the env var isn't set).
  - **Please treat `warnings` as a user-visible notice.** The platform currently only expects `image_fetch_failed` as a 422.
  - The platform's image route (`/api/v1/product-images/{tenant}/{ulid}`) must be reachable over https at a stable host, which the site admin lists in `CMS_PM_IMAGE_HOSTS`.
- **`description` is ignored** when the product body is rich text (the default product collection), and is listed in `ignored: ["description"]`. `short_description` goes to the tagline.
- No price is set. The draft is completed in the admin before publishing.
- `/ping` now reports `capabilities.product_create: true`.

## 5. Product sync: optional cleanup

`ProductSyncService` reads products in the WooCommerce shape and doesn't normalise them as `normalizePage()` does for pages. The CMS now **also** emits, on product items:

- `type: "simple"`
- `regular_price`
- `pm: {…}`, the same keys as `seo{}`

So current SEO/AEO values import without platform changes. A `PraionAdapter::normalizeProduct()` would still be the cleaner fix.

## 6. Translations aren't synced

Each language version is its own document on the CMS, with its own `remote_id`. Today the platform:

- calls `/pages` and `/products` without `?locale=`, so only the **default** language is listed;
- imports every item into the project's default language, ignoring `item.locale`;
- pushes only the source translation (`PagePushService` `:93`, `:113-114`, `:183`).

Every item now carries `translation_group` (shared by all versions) and `translations: [{locale, remote_id}]`. Suggested flow:

1. Sync once per locale in `capabilities.locales`, passing `?locale=<code>`.
2. Import each item into its own `locale`, and link the versions by `translation_group`.
3. Push each translation to **its own** `remote_id` (`PATCH /pages/{type}/{id}`). A translation must never be pushed onto the source document.

Until this lands, consider declaring `translations: false` for Praion in `CmsCapabilities`, so the UI doesn't promise it.

## 7. Respect `editable` for products

Pages already show only the fields listed in the site's `editable`. `ProductPushService::push` sends every key that has a value, so an AI-suggested `description` reaches a rich-text product body and comes back as a per-field error on every push. Filter product pushes by the item's `editable` too.

## 8. Error mapping and wording

- `PageSyncController::push` and `ProductEnrichmentController` match only `rest_no_route`. Praion answers **`no_route`** (404) when the bridge module is off. Match both.
- The user-facing messages say "WordPress" and "plugin outdated". Make them platform-neutral for Praion connections.
- A page `PATCH` returns `{written, errors, skipped}`. `skipped` (unchanged, or nothing to do) is currently dropped. Show it, or at least don't count those keys as written.

## 9. Things the platform can now rely on

These already worked or were fixed on the CMS side. No platform change is needed.

- **AEO repeaters:**
  - `focus_keywords` and `key_facts` are accepted as strings, as `{keyword}`/`{fact}` rows, or wrapped in `{rows:[…]}`.
  - `faqs` and `pros_cons` are accepted bare or wrapped.
  - A non-empty list in an unrecognised shape now returns a per-field error instead of **wiping** the stored rows, which is what happened before.
- **HTML fields:** `faqs[].answer`, `faqs[].question` and `answer_summary` are stored as plain text. Tags are stripped and paragraph breaks kept, because the site renders them as text.
- **`seo_override`** inside product/page `values`: a boolean.
  - It is applied to the document's existing compiled-payload rows.
  - It is `skipped` when there is none; the next `/payload` push carries it anyway.
- **Pages:** the site's `page` collection is now exposed as `wp_page`. On new sites, blog, FAQ and case-study collections are exposed as `wp_post`. Their bodies are rich text, so `description` is refused there, by design.
- **Module gating:** collections of a module that is switched off (shop, bookings) are no longer listed, read or written.
- **Bookings** are `wp_post`, with content type `booking`. Writable: title, slug, SEO/AEO keys and gallery alt text. Bodies are rich text and are refused.
