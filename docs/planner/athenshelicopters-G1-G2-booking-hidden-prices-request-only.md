# G1 / G2 / REQ-1: hidden prices, requests without payment, and a captcha on the booking form

This is the hand-off to the Planner for the athenshelicopters-planner findings v2 (3/10/2026). The site doesn't change `src/cms`. This doc says what the CMS now does and what the site's own files must do.

## 1. What `cms:update` brings, and what it doesn't

**Core files, written by the updater:**

- `src/cms/modules/booking/visibility.ts` (new): the rules, pure.
- `settings-read.ts` → `getBookingPolicy()`.
- Changes to `reservations.ts`, `payments.ts`, `quote.ts` and `emails.ts` (`bookingSummaryHtml`).
- The settings schema (`booking.hidePrices`, `booking.requestOnly`).
- `core/api/handler.ts`: `captcha.when`.
- `core/security/headers.ts`: the booking form's pages get the reCAPTCHA policy.
- The admin `ReservationsTable` and `ReservationPayments`.

**After `cms:update`:**

- **No migration.**
- **No new npm dependencies.**
- **No new env vars.**
- **Nothing changes** until the two switches are turned on.

**Site-owned files the updater does not write.** Port these from the base if the site has its own copies:

| Base file | What changed |
|---|---|
| `src/app/[locale]/booking/page.tsx` | `getBookingPolicy()` → `withoutListingPrices()`, `visibleSort()`, no price sort options |
| `src/app/[locale]/booking/[slug]/page.tsx` | `entryMode()` for the mode; `offerPrice` null when hidden (removes the JSON-LD Offer and the `view_item` price); extras with `price: null`; `hidePrices` and `captchaSiteKey` passed to the form; captcha wording from `contact.form` |
| `src/components/booking/BookingForm.tsx` | `hidePrices` (no breakdown, no quote request); `captchaSiteKey` (the `PublicCaptcha` widget, the `x-captcha-token` header, the `captcha_failed` message) |
| `src/components/booking/booking-form-types.ts` | `BookingFormExtra.price: number \| null`; optional `captcha*` labels |
| `src/components/booking/booking-form-fields.tsx` | An extra with `price == null` shows only its name |
| `src/app/[locale]/booking/lookup/BookingLookupClient.tsx` | `total`/`currency` are optional; no "Total" row without them |

## 2. Settings (Admin → Settings → Booking)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `booking.hidePrices` | boolean | `off` | **G1.** Only exactly `on` hides. No amount reaches a visitor or customer. |
| `booking.requestOnly` | boolean | `off` | **G2.** Accepting a request confirms it. No payment step at all. |

Read them with `getBookingPolicy()`, which returns `{ hidePrices, requestOnly }`. The pure rules in `visibility.ts` can be imported by the admin and by client code.

**Shared rule:** with either switch on, every booking is a request, whatever `booking.mode` or the experience says. An experience **with no price** (empty base price or nightly rate) can then be requested and is stored with `total = 0`. **The internal `basePrice = 1` (D-P01) is no longer needed.** Clear it so the admin doesn't show €1.

## 3. G1: what changes for the customer with `hidePrices` on

| Surface | Before | Now |
|---|---|---|
| `POST /api/cms/booking/quote` | `quote` with `total`, `lines`, plus `currency` | `quote: { ok: true, persons }`, no `currency`. A refusal keeps its `reason` (for example `min_nights`). |
| `POST /api/cms/booking/request` (201) | `total`, `currency` | Only `reference`, `status`, `redirectUrl`, `expiresAt` |
| `POST /api/cms/booking/lookup` | `total`, `amountPaid`, `currency`, `items[].amount` | No amounts. `items` are `{ label, quantity }`. |
| Customer emails (request received, confirmed, cancelled, expired…) | Price breakdown and total | Reference, date, people, and "Your selection" (names of the extras), no amounts |
| Team emails | Price breakdown | **Unchanged.** A booking with no price reads "Price: to be agreed". |
| Listing | "from €X", price sorting | "on request", no price sorting (`?sort=price-*` falls back to the title) |
| Experience page | JSON-LD `Offer`, `view_item` with `value`, extra prices | No Offer, no `value`, extras without prices, no breakdown |
| Pay page | Amount | **Stays.** It only opens if the operator sends a link, and paying needs an amount. With `requestOnly` it doesn't exist at all. |

## 4. G2: what changes with `requestOnly` on

- **Entry:** always `pending` (request).
- **Accept:** `pending → confirmed`. The admin button is "Accept & confirm". The customer gets the confirmation email **without** a payment link or payment instructions.
- **Refused:**
  - `→ awaiting_payment` returns 409.
  - Every payment link (`issuePaymentLink`: accept, resend, instant) returns 409.
  - `GET`/`POST /api/cms/booking/pay` return 404.
- **Admin:**
  - No "Mark paid" as the next step for a confirmed booking.
  - No "Resend payment link".
  - "Record payment" stays, for bookkeeping only.
- **Regardless of the switch:** a booking with `total = 0` can't go to "awaiting payment". Accepting it confirms it.

## 5. REQ-1 to REQ-3: the captcha on the booking form

- Both public forms are driven by the same switch, Settings → Security → "Captcha on public forms", and the same keys (`RECAPTCHA_SITE_KEY`/`RECAPTCHA_SECRET_KEY`).
- `POST /api/cms/booking/request` checks the `x-captcha-token` header **before** the request body is read. A failed check returns `400 captcha_failed`, and nothing is priced or stored. Verification has its own per-IP limit of 30 per minute.
- **Headers:**
  - `/booking/<slug>` and `/<locale>/booking/<slug>` get the third-party policy: no COEP, reCAPTCHA hosts in the CSP.
  - `/booking`, `/booking/lookup` and `/booking/pay/…` keep the strict policy.
- The cookie declaration already lists "Google reCAPTCHA" automatically while the captcha is on.

## 6. How to test it

1. **Both switches on, experience with no price:**
   - The form shows no breakdown, and the request goes through.
   - The 201 response has no `total`.
   - The customer email has no amount; the team email says "to be agreed".
2. **Admin:** "Accept & confirm" sends a confirmation with no payment content.
3. **`curl` checks:**
   - `POST /api/cms/reservations/{id}` with `{"status":"awaiting_payment"}` returns 409.
   - `/api/cms/booking/pay?...` returns 404.
4. **Lookup** with reference and email: no total.
5. **Listing:** no "from €", and no price sorting options.
6. **Experience page source:** no `"@type":"Offer"`.
7. **Captcha:** with it on, `/booking/<slug>` shows the widget on the first focus. A `curl` without a token returns `400 captcha_failed`.

Automated tests: `test/booking/price-visibility.test.ts`, `test/booking/price-visibility-wiring.test.ts`, `test/core/booking-captcha.test.ts`.

## 7. Limits

- The amount is visible at the payment gateway (Stripe, PayPal, Viva, Klarna) if a link is ever sent. That isn't possible with `requestOnly`.
- The admin can't edit a booking's total. An unpriced booking stays at 0, and the price is agreed outside the system.
- `quickInfo` and the experience text are free text. An editor can still write a price there.
