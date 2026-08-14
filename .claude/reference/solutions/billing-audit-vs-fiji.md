# Billing audit — podcast-saas vs fiji (gold-standard reference)

Scope: end-to-end pay-to-unlock (Stripe Checkout) for locked **projects** and **playlists**.
Read-only audit. No `.env` read; webhook secret referenced by name only.

Stack note: fiji = Express/TSOA + MongoDB/Mongoose + a **server-confirmed PaymentIntent** flow.
podcast-saas = Fastify + Drizzle/Postgres + a **hosted Stripe Checkout** flow. The flows differ, so
several fiji mechanisms must be *ported*, not copied. Where fiji itself has a gap, I say so and
recommend podcast-saas do better.

Reference files:
- podcast-saas: `backend-api/src/services/billing/BillingService.ts`,
  `controllers/v1/stripe-webhook.controller.ts`, `controllers/v1/billing.controller.ts`,
  `controllers/v1/{player,playlists,share}.controller.ts`, `services/buildPlayerConfig.ts`,
  `server.ts`, `db/schema.ts`.
- fiji: `fijiserver/src/services/BillingService.ts`, `controllers/v1/StripeWebhookController.ts`,
  `controllers/v1/StorageProxyHandler.ts`, `services/UserPurchaseService.ts`,
  `models/{UserPurchase,BillingTransaction}.ts`, `app.ts`.

---

## P0 — Paywall is cosmetic: paid media is served from public URLs with no entitlement check

**podcast-saas.** The lock only hides the *config JSON*. The media URLs inside the config are
**public, unauthenticated CDN links**, and the segment route has **no billing gate**:
- `services/buildPlayerConfig.ts:79-84,102,134-139,167-172` set `hls_url`/`crop_url` via
  `storage.getPublicUrl(v.hls_master_key)`. `R2StorageAdapter.getPublicUrl()`
  (`services/storage/R2StorageAdapter.ts:196-206`) returns `${R2_PUBLIC_URL}/${path}` — a permanent
  public URL, **not** a short-lived signed URL.
- `server.ts:171-187` `GET /hls-public/*` serves any `hls/...` key from local disk with **no auth and
  no billing check**. `server.ts:191-228` `GET /hls-proxy/*` does the same against the R2 public URL.

Result: anyone who obtains (or guesses) the HLS key plays the full paid video for free. The
`locked:true` stub in `player.controller.ts:35-44`, `share.controller.ts:28-33`,
`playlists.controller.ts:186-191` is trivially bypassed — the entire paywall rests on the client
choosing not to hit the media URL. HLS keys also leak via `buildPlayerConfig` to anyone the owner
previews to, and segment keys are sequential/derivable.

**Fiji's approach.** Fiji never hands out a permanent public media URL for protected content. Two
pillars:
1. **Per-object authorization at serve time.** `StorageProxyHandler.ts` (`GET
   /api/v1/storage/proxy/{filePath}`) resolves the artifact and serves bytes **only if**
   `artifact.isPublic`, owner, admin, valid scoped token, or localhost — else 403
   (`checkArtifactAccess()`). "Public" is a DB flag evaluated per request, not a URL prefix.
2. **Short-lived signed URLs** for everything else: `StorageService.getPresignedUrl(file)` (30-min
   cache under a 1-hour expiry) — the URL dies quickly and is minted only after the caller has
   passed an access check (e.g. `UserPurchaseService.getUserPurchases` mints thumbnail URLs only for
   rows the user owns).

The decisive difference: fiji's media URL is either (a) gated per-object by the same
`hasAccess`-style check the paywall uses, or (b) ephemeral. podcast-saas's is a permanent public URL,
so the paywall and the media have **different, inconsistent** gates.

**Gap.** podcast-saas already has the right primitive — `SupabaseStorageAdapter`/`R2StorageAdapter`
implement `getPresignedDownloadUrl` (`SupabaseStorageAdapter.ts:97`, `R2StorageAdapter.ts:116`). It
just isn't used for HLS in `buildPlayerConfig`, and HLS is multi-file (master + variant playlists +
N segments), which complicates naive presigning.

**Ported fix (phased).**

- **Phase 1 (now, cheap, closes the hole): gate the HLS proxy by entitlement and route paid media
  through it.** Add an authenticated HLS endpoint that performs the same billing check as the
  config:
  ```ts
  // server.ts (or a new controllers/v1/media.controller.ts)
  // GET /api/v1/hls/:projectId/* (preHandler: firebaseAuthOptionalMiddleware)
  //   1. load project; requireProjectAccess(project, userId)  // visibility
  //   2. pricing = BillingService.getPricing('project', projectId)
  //      if paid && !await BillingService.hasAccess(userId, 'project', projectId) -> 403
  //   3. key must start with this project's hls/ prefix (reject cross-project keys)
  //   4. stream from storage (presigned GET on R2/Supabase, or local file)
  ```
  Make `buildPlayerConfig` emit `/api/v1/hls/<projectId>/<relativeKey>` for **paid** projects (free
  projects can keep the public CDN path for performance). The `.m3u8` rewrite must point variant +
  segment URLs at the same gated prefix so relative resolution stays inside the gate.
  - Playlist case: when access was granted at **playlist** level, the per-project
    `hasAccess('project', …)` must also accept "owns the containing playlist" — see P1 (entitlement
    bug) below; otherwise gated segments 403 even though the viewer paid.
- **Phase 2 (proper, fiji-parity): signed-cookie or signed-URL CDN.** Issue a short-TTL **signed
  cookie** (CloudFront/Cloudflare signed cookies cover all sub-requests of an HLS ladder with one
  grant) or per-segment presigned URLs, minted only after `hasAccess`. Keep the `getPublicUrl` path
  for free content. This restores direct-to-CDN performance while keeping the gate.

**Trade-offs / risks.** Phase 1 routes paid bytes through Node (bandwidth + the GoDaddy egress/HTTP-
only constraint) — fine for low paid volume, revisit at scale. Don't presign every `.ts` individually
without caching (signing cost + churn). Test: as a non-purchaser, fetch the raw HLS master/segment
URL directly and assert 403; as purchaser, 200.

**Verification.** Integration test: paid project, user without purchase → `player-config` returns
`locked:true` AND direct `GET` of the master playlist + a segment → 403. After a granted purchase →
both 200.

---

## P0 — `payment_intent.payment_failed` never matches a row → failed payments stay `pending` forever

**podcast-saas.** `BillingService.markFailed()` updates
`WHERE stripe_payment_intent_id = paymentIntentId` (`BillingService.ts:196-200`). But in the Checkout
flow the PaymentIntent id is written to the row **only inside `grantFromSession` on success**
(`BillingService.ts:183`). At pending-insert time (`:119-126`) `stripe_payment_intent_id` is NULL.
So when `payment_intent.payment_failed` fires (`stripe-webhook.controller.ts:37-40`), the `WHERE`
matches **zero rows** — the transaction is never marked `failed` and lingers as `pending` forever.
This pollutes the admin "pending" count (`admin/v1/billing.controller.ts:16,29`) and the user's
history.

**Fiji's approach.** Fiji creates the PaymentIntent itself and **immediately persists**
`stripePaymentIntentId` on the transaction (`BillingService.ts:383-385`), so
`handlePaymentFailed` resolves the row by `metadata.transactionId` first
(`BillingService.ts:521-538`) — it keys on the **transactionId carried in PI metadata**, not on a
column that may be unset.

**Gap.** podcast-saas already attaches the transactionId to the PI via
`payment_intent_data.metadata.transactionId` (`BillingService.ts:141`) — it just doesn't read it on
failure.

**Ported fix.** Resolve by transactionId, mirroring fiji:
```ts
case 'payment_intent.payment_failed': {
  const pi = event.data.object as Stripe.PaymentIntent;
  const txId = pi.metadata?.transactionId;          // set via payment_intent_data.metadata
  await BillingService.markFailed({ transactionId: txId, paymentIntentId: pi.id,
                                    message: pi.last_payment_error?.message });
  break;
}
```
`markFailed` should prefer `transactionId` and fall back to `stripe_payment_intent_id`. Also add a
`checkout.session.expired` handler to mark abandoned sessions `failed`/`expired` so they don't sit
`pending`.

**Verification.** Use a Stripe test card that fails (`4000000000000002`) through Checkout; assert the
transaction row flips to `failed` with the error message.

---

## P0 — No refund / chargeback handling: refunded buyers keep access; disputes are invisible

**podcast-saas.** The webhook handles only `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `payment_intent.payment_failed`
(`stripe-webhook.controller.ts:32-44`). There is **no** `charge.refunded`,
`charge.dispute.created`, or `refund.*`. So after a Stripe-dashboard refund the buyer **keeps the
`user_purchases` row and full access**, and `hasAccess` still returns true
(`BillingService.ts:74-81`). Disputes/chargebacks are entirely invisible to the app.

**Fiji's approach.** Fiji's `handleWebhook` switch routes `charge.refunded` → `handleChargeRefunded`
and `charge.dispute.created` → `handleDisputeCreated` (`BillingService.ts:583-589`), setting
transaction `status` to `refunded`/`disputed` (`:671-714`).

**Gap & where podcast-saas should EXCEED fiji.** Fiji marks the transaction `refunded` **but does not
revoke the `UserPurchase`** (`handleChargeRefunded` only sets status) — so even fiji leaves a
"refunded yet still has access" hole. Since podcast-saas's entire access model is "row in
`user_purchases` ⇒ access," podcast-saas should go further and **delete (or soft-revoke) the
`user_purchases` row** on refund, not just stamp the transaction.

**Ported fix.**
```ts
// stripe-webhook.controller.ts
case 'charge.refunded':          await BillingService.handleRefund(event.data.object as Stripe.Charge); break;
case 'charge.dispute.created':   await BillingService.handleDispute(event.data.object as Stripe.Dispute); break;

// BillingService.handleRefund(charge):
//   pi = charge.payment_intent
//   tx = find billing_transactions where stripe_payment_intent_id = pi  (now reliably set, see P0-#2 via grant)
//   if !tx return
//   set tx.status = charge.amount_refunded >= charge.amount ? 'refunded' : 'partially_refunded'
//   if fully refunded: DELETE from user_purchases where transaction_id = tx.id   // <-- revoke access
//   (record a 'refund' ledger row — see P2 money-handling)
```
Add `'disputed' | 'partially_refunded'` to the `status` set the schema comment documents
(`schema.ts:557`); no DDL needed (it's a free-text column) but update the comment + any TS union.

**Verification.** Refund a test charge in the Stripe dashboard; assert the `user_purchases` row is
gone and `hasAccess` → false; assert `billing_transactions.status='refunded'`.

---

## P1 — Webhook events are not deduplicated by `event.id` (retry-safety relies on row status only)

**podcast-saas.** `grantFromSession` is idempotent **for the grant** (status short-circuit at
`BillingService.ts:179`; `user_purchases.onConflictDoNothing()` at `:191` backed by the
`uniq_user_content` unique index `schema.ts:586`). Good. But there is **no event-level dedup**: Stripe
delivers each event **at least once** and retries on any non-2xx. Because the webhook returns **500**
on a handler error (`stripe-webhook.controller.ts:47`), Stripe will redeliver, and future
non-idempotent handlers (refund ledger inserts, dispute side-effects, emails) would double-apply.

**Fiji's approach.** Fiji is in the same boat — it also relies on transaction status + the
`UserPurchase` unique index (`models/UserPurchase.ts:125-127`) and does **not** persist processed
`event.id`s. So this is a place to **improve on fiji**, not copy it.

**Ported fix.** Add a tiny processed-events table and short-circuit:
```ts
// schema.ts
export const stripe_webhook_events = pgTable('stripe_webhook_events', {
  id: text('id').primaryKey(),                 // Stripe event.id (evt_...)
  type: text('type').notNull(),
  received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
// webhook handler, before dispatch:
const [ins] = await db.insert(stripe_webhook_events)
  .values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
if (!ins) return reply.send({ received: true });   // already processed
```
Also: only return **5xx for transient/unknown errors**; for permanent ones (malformed event, missing
metadata) return **2xx** so Stripe stops retrying a poison event.

**Verification.** Replay the same event id twice via `stripe trigger`/CLI; assert exactly one grant
and one ledger effect.

---

## P1 — Entitlement bug: playlist-level purchase does not unlock independently-paid items; free playlist silently drops paid items

**podcast-saas.** `buildPlaylistPlayConfig` decides each item's inclusion using **only project-level
access** (`playlists.controller.ts:612-613`):
```ts
const pricing = await BillingService.getPricing('project', i.project_id);
if (pricing?.accessType === 'paid' && !(await BillingService.hasAccess(viewerUserId, 'project', i.project_id))) continue;
```
Two failure modes:
1. **Buyer paid for the playlist** (the bundle) but an item is an independently-`paid` project → the
   buyer **owns the playlist, not the project**, so `hasAccess('project', …)` is false and the item
   is **silently dropped** (`continue`). The customer paid and still can't see part of what they
   bought.
2. **Free playlist containing a paid project** → the paid item is silently dropped with **no paywall
   affordance**. The viewer sees a playlist that's quietly missing videos, instead of an "unlock this
   item" prompt.

**Fiji's approach.** Fiji separates the two concepts explicitly:
`UserPurchaseService.checkContentAccess` first checks **owns-the-whole-artifact**
(`UserPurchaseService.ts:99-114`) and only then falls back to the specific content key — i.e. a
broader purchase grants the narrower content. The "do I own the container?" check precedes the
"do I own this exact item?" check.

**Gap.** podcast-saas has no notion of "playlist purchase implies access to member projects," and no
"locked item" representation in the playlist config — items are binary include/drop.

**Ported fix (needs a product decision first — see Open Questions).** Two coherent options:
- **(A) Playlist is the unit of sale (recommended, simplest).** A `paid` playlist is purchased as a
  bundle; its member projects are delivered as part of it regardless of their own `access_type`.
  Implement: in `buildPlaylistPlayConfig`, compute `ownsPlaylist = await
  BillingService.hasAccess(viewerUserId, 'playlist', playlist.id)` once; an item is accessible if
  `ownsPlaylist || requireProjectAccess(...) && projectLevelAccessOK`. Then extend
  `BillingService.hasAccess('project', …)` (and the P0-#1 HLS gate) to also return true when the
  viewer owns a playlist that contains the project (mirror fiji's "owns container ⇒ access").
- **(B) Per-item upsell.** Keep items independently saleable; replace `continue` with a **locked
  placeholder** in the config (`{ project_id, title, thumbnail_url, locked:true, price_cents }`) so
  the viewer can unlock individual items. More UI work.

**Verification.** Seed a paid playlist with a paid member project; buyer purchases the playlist;
assert the member project appears in the playlist config AND its HLS is reachable. Seed a free
playlist with a paid member; assert the member shows as locked (option B) or is intentionally
excluded with a documented rule (option A).

---

## P1 — No reconciliation fallback when the webhook is missed/delayed (buyer pays, never gets access)

**podcast-saas.** The **only** code path that writes `user_purchases` is the webhook
(`grantFromSession`). The Checkout `success_url` returns the buyer to `/unlock?...&session_id=...`
(`BillingService.ts:129,143`), but there is **no backend `/unlock` or session-reconcile endpoint** —
grep finds none. If the webhook is delayed, dropped, or the secret is misconfigured, the buyer is
charged and bounced back to a video that still says `locked`, with no recovery short of an admin.

**Fiji's approach.** Fiji confirms payment **synchronously inside the request** (`createCharge` →
`paymentIntent.status === 'succeeded'` → `handlePaymentSucceeded` immediately,
`BillingService.ts:390-392`); the webhook is a backstop, not the sole grant path. podcast-saas's
hosted-Checkout flow can't confirm inline, so it needs an explicit reconcile-on-return.

**Ported fix.** Add an authenticated reconcile endpoint the `/unlock` page calls on return:
```ts
// POST /api/v1/billing/checkout/reconcile { session_id }   (firebaseAuthMiddleware)
//   session = await stripe.checkout.sessions.retrieve(session_id)
//   verify session.metadata.buyerUserId === request.dbUser.id   // don't grant on someone else's session
//   if session.payment_status === 'paid' -> BillingService.grantFromSession(session)  // idempotent
//   return { hasAccess: await BillingService.hasAccess(...) }
```
This reuses the idempotent `grantFromSession`, so it races safely with the webhook (whichever wins,
the unique index + status check dedup). Optionally add a periodic sweep that retrieves still-`pending`
sessions older than N minutes.

**Verification.** Disable the webhook locally; complete a Checkout; assert the `/unlock` reconcile
call grants access and the viewer unlocks.

---

## P1 — Currency is per-content and unvalidated; earnings hardcode `usd` while summing mixed currencies

**podcast-saas.** Pricing currency is set per project/playlist
(`billing.controller.ts:167,178`, default `usd`) and Checkout honors it
(`BillingService.ts:46,137`). But:
- The **earnings** endpoint hardcodes `currency: 'usd'` in the response while summing
  `amount_cents`/`creator_payout_cents` **across all of a creator's sales regardless of currency**
  (`billing.controller.ts:140-151`). If any content is ever priced non-USD, gross/net totals are
  silently wrong (adding JPY cents to USD cents).
- Pricing accepts any 3-char string (`z.string().length(3)`, `:167`) with no allow-list and no
  zero-decimal-currency handling (JPY/KRW have no minor unit; `unit_amount` semantics differ).

**Fiji's approach.** Fiji stamps `currency` on each transaction/purchase and surfaces it per-row
rather than asserting a single platform currency in aggregates (`UserPurchaseService.ts` summaries
carry `currency` per item; creator stats sum within a single-currency assumption that fiji enforces
operationally).

**Ported fix.** Either (a) **constrain to a single platform currency** now (validate
`currency === 'usd'` on pricing PATCH; simplest, matches current reality), or (b) **group earnings by
currency** (`GROUP BY currency`, return an array of `{currency, grossCents, netCents}`) and add a
zero-decimal-currency table if you truly go multi-currency. Recommendation: do (a) until there's a
real multi-currency requirement — deliberately do *less* than a full multi-currency ledger.

**Verification.** Unit-test the earnings aggregate with mixed-currency rows; assert it either rejects
non-USD at write time (option a) or buckets correctly (option b).

---

## P2 — Refund/partial-refund money is never written to the `type: charge|refund` ledger

**podcast-saas.** `billing_transactions.type` already models `charge | refund` (`schema.ts:556`) and
status models `refunded` (`:557`), but nothing ever **inserts a `refund` row** or records
`amount_refunded`. After P0-#3 adds refund handling, the refund should be a first-class ledger entry,
not just a status flip on the original charge — otherwise creator-earnings/clawback math can't be
reconstructed.

**Fiji's approach.** Fiji likewise only flips status (`BillingService.ts:686`) — another spot to
exceed fiji. Stripe's `charge.amount_refunded` gives the exact figure.

**Ported fix.** In `handleRefund`, after flipping the charge status, insert a paired ledger row:
```ts
await db.insert(billing_transactions).values({
  type: 'refund', status: 'succeeded',
  amount_cents: -charge.amount_refunded,                 // negative = money out
  currency: tx.currency,
  platform_fee_cents: -Math.round(tx.platform_fee_cents * (charge.amount_refunded / tx.amount_cents)),
  creator_payout_cents: -(/* proportional clawback */),
  payer_user_id: tx.payer_user_id, creator_user_id: tx.creator_user_id,
  content_type: tx.content_type, content_id: tx.content_id,
  stripe_payment_intent_id: tx.stripe_payment_intent_id,
  description: `Refund of ${tx.id}`, completed_at: new Date(),
});
```
Make the earnings/admin aggregates **sum** charges + refunds (refunds negative) so net revenue is
correct after clawbacks.

**Verification.** Partial-refund a charge; assert a negative-amount `refund` row exists and creator
net drops by the proportional payout.

---

## P2 — Webhook returns 5xx on permanent errors, causing endless Stripe retries (poison events)

**podcast-saas.** Any throw in the dispatch returns **500** (`stripe-webhook.controller.ts:45-48`).
Stripe retries non-2xx for up to ~3 days. A permanently-bad event (missing `transactionId`, deleted
content) becomes a poison message hammering the endpoint and filling logs.

**Fiji's approach.** Fiji's controller returns **200** for "billing not enabled" and only **400** for
signature/parse failures, but it does **`return { received: true }`** in the happy path and lets
handler internals swallow/log rather than re-throwing 5xx for known-permanent conditions
(`StripeWebhookController.ts:51-72`).

**Ported fix.** Classify: signature failure → 400 (already correct, `:28`); **transient** (DB down) →
5xx (let Stripe retry); **permanent/known** (missing metadata, content gone) → **log + 2xx** so
Stripe stops. Combine with the P1 event-dedup table.

**Verification.** Send a syntactically valid event with no `transactionId`; assert 200 + a warning
log, and that Stripe does not redeliver.

---

## P2 — Webhook raw-body parser correctness (verify, do not assume)

**podcast-saas.** Signature verification needs the **exact raw bytes**. The webhook registers a
scoped `application/json` buffer parser (`stripe-webhook.controller.ts:13-17`) inside its own
encapsulated plugin, and the route is registered (`server.ts:455`) **after** `registerBillingRoutes`.
This is the right Fastify pattern (encapsulated content-type parser), and I found **no global
`addContentTypeParser`** that would shadow it. But two things must hold and should be asserted:
1. No upstream `onRequest`/`preParsing` hook consumes the stream before the scoped parser.
2. The `helmet`/`cors`/`multipart` plugins (`server.ts:109-122`) don't interpose a body parser on
   this path.

**Fiji's approach.** Fiji mounts `bodyParser.raw({ type: 'application/json' })` **specifically** on
`/api/v1/webhooks/stripe` and stashes `req.rawBody` (`app.ts:44-45`), then verifies against it — a
narrowly-scoped raw body, same intent as podcast-saas's encapsulated parser.

**Ported fix.** Likely already correct — but add a test that posts a body with a **valid** signature
computed over the raw bytes and asserts `constructEvent` succeeds, plus a tampered-body test
asserting 400. Confirm `STRIPE_WEBHOOK_SECRET` is configured in the deploy env (referenced in
`.env.example:104-106`; **do not** print it). If the secret is unset, `verifyWebhook` throws and the
endpoint 400s every event — a silent "no purchases ever grant" outage.

**Verification.** `stripe listen --forward-to localhost:PORT/api/v1/stripe/webhook` + `stripe trigger
checkout.session.completed`; assert 200 and a granted purchase.

---

## P2 — No authorization/price re-check between Checkout creation and grant (Checkout integrity)

**podcast-saas.** `createCheckoutSession` builds `price_data` from server-side pricing
(`BillingService.ts:130-145`) — **good**, the client can't set the price (no `client_reference`-driven
amount). The pending transaction stores the amount at creation. One residual risk: if the owner
**changes the price** between session creation and completion, `grantFromSession` grants based on the
stored transaction, which is fine; but there's no re-assertion that the content is still `paid`/still
exists at grant time. Low severity (you generally honor what the buyer paid), noted for completeness.

**Fiji's approach.** Fiji re-derives fees server-side per charge (`BillingService.ts:341,313-317`)
and the artifact is re-loaded at charge time (`:326`). podcast-saas already constructs amounts
server-side; the only missing bit is a "content still saleable" assertion, which is optional.

**Ported fix (optional).** In `grantFromSession`, log a warning if the content no longer exists or
flipped to `free`, but still honor the paid session. No hard change required.

---

## Things podcast-saas already gets RIGHT (don't regress)

- **Server-side amounts in Checkout** (`BillingService.ts:130-145`) — no client-supplied price.
- **Grant idempotency** via status short-circuit + `user_purchases` unique index + `onConflictDoNothing`
  (`BillingService.ts:179,191`; `schema.ts:586`) — matches fiji's unique-index protection.
- **Encapsulated raw-body parser** for the webhook (correct Fastify pattern).
- **Owner & free short-circuits** in `hasAccess` (`BillingService.ts:71-73`) — mirror fiji.
- **Visibility gate layered before billing** in player/share/captions
  (`player.controller.ts:25,60,97`) — fiji-style defense in depth.
- **Min price floor** ($0.50) enforced at pricing and checkout
  (`billing.controller.ts:170-172`, `BillingService.ts:107`).

---

## Ranked summary

| # | Sev | Problem | podcast-saas | fiji mechanism |
|---|-----|---------|--------------|----------------|
| 1 | P0 | Paid media served from public URLs; paywall cosmetic | `buildPlayerConfig.ts:79-84`, `server.ts:171-187` | `StorageProxyHandler.ts` per-object auth + `StorageService.getPresignedUrl` |
| 2 | P0 | `payment_intent.payment_failed` matches 0 rows → stuck `pending` | `BillingService.ts:196-200,183` | fiji stores PI id at create + keys on `metadata.transactionId` `BillingService.ts:383,521` |
| 3 | P0 | No refund/dispute handling → refunded buyers keep access | `stripe-webhook.controller.ts:32-44` | `BillingService.ts:583-589,671-714` (and exceed it: revoke purchase) |
| 4 | P1 | No `event.id` dedup (retry-safety) | `stripe-webhook.controller.ts:32-51` | improve on fiji (add processed-events table) |
| 5 | P1 | Playlist purchase doesn't unlock paid items; free playlist drops paid items silently | `playlists.controller.ts:612-613` | `UserPurchaseService.ts:99-117` owns-container-first |
| 6 | P1 | No reconcile fallback if webhook missed (paid, no access) | no `/unlock` backend; `BillingService.ts:129` | fiji confirms inline `BillingService.ts:390` |
| 7 | P1 | Earnings hardcode `usd` over mixed-currency sums; no currency allow-list | `billing.controller.ts:140-151,167` | per-row currency; enforce single currency |
| 8 | P2 | Refund money never written to `charge|refund` ledger | schema has `type` but unused | exceed fiji |
| 9 | P2 | 5xx on permanent webhook errors → retry storms | `stripe-webhook.controller.ts:45-48` | fiji returns 2xx for known conditions |
| 10 | P2 | Raw-body parser correctness + webhook-secret presence (verify) | `stripe-webhook.controller.ts:13-17`, `server.ts:455` | `app.ts:44-45` scoped raw body |

## Open questions for the human / product
- **Playlist sale model (blocks P1-#5):** Is a paid playlist a **bundle** (option A — playlist
  purchase grants all member projects) or do items remain **independently saleable** with per-item
  upsell (option B)? Pick one before fixing the gate; they imply different `hasAccess` semantics.
- **Multi-currency:** is non-USD pricing ever needed? If not, lock to USD now (simpler, correct).
- **Refund policy:** full revoke vs grace period; partial-refund → keep or revoke access?
- **Payouts/Connect:** `platform_fee_cents`/`creator_payout_cents` are computed and stored, but there
  is **no Stripe Connect / transfer** path — creators are never actually paid out (admin "pendingPayout"
  is informational). Decide if/when to add Connect; out of scope for these fixes but a known gap.
