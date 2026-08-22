# Parked designs — approved-pending, build only on the owner's go

The two features the owner requested on 2026-08-21 and deliberately parked. The designs were
written in the (since deleted) `CODEX-DECISION-RESPONSE-2026-08-21.md` Part III and moved here
verbatim when that round closed — these are the only parts of it that were still load-bearing.
Everything else from that document either executed (recorded in `DECISIONS.md`'s history via git)
or expired.

**The owner has already answered the one open sub-question:** the canonical per-project audio URL
is **`/{slug}/audio`** (option א).

## P3-A — Route renames (build on approval)

Grounding, verified 2026-08-21: `RESERVED_SLUGS` already contains `admin`, `podcasts`, `podcast`,
and `project` — so none of the target paths can be shadowed by a creator permalink today, and
adding `edit-podcasts` plus reserving `audio` as a *sub-route* are the only registry changes.

1. **`/admin`.** The management dashboard (admin-web, a separate Next app) moves under
   `flowvidco.com/admin`: `basePath: '/admin'` in `admin-web/next.config`, one nginx
   `location /admin/` block proxying to the admin-web upstream in
   `deploy/nginx/templates/app.conf.template`, auth gate unchanged (path exposure adds discovery,
   not access). Effort S–M; the real work is checking admin-web for absolute-path assumptions
   (`/api`, asset prefixes) that `basePath` surfaces.
2. **`/podcasts` → `/edit-podcasts`.** Rename the route directory, add `edit-podcasts` to
   `RESERVED_SLUGS`, and leave a `permanentRedirect()` shim at the old tree so every deep link
   (`/podcasts/{showId}/episodes/{id}`) 308s to its new home — the `LegacyRedirectResolver`
   pattern at the page level, no middleware cost. `podcasts` STAYS reserved after the move:
   releasing it would let a creator claim the exact URL every old shared link points at. Update
   the sitemap emitters if they enumerate podcast pages. Effort S.
3. **The audio landing.** Canonical per-project surface: **`/{slug}/audio`** — a typed sibling of
   `/{slug}/library` and `/{slug}/{lang}`, riding the same mini-site rails (ISR, share-token
   capability, purge-on-revoke), with `audio` added to the sub-route registry. `/project/audio`
   then exists as the *category landing* — what interactive audio IS, with examples — matching
   its global path shape. This resolves the overlap with P3-B rather than fighting it.

## P3-B — Interactive podcast phase 2 (build on approval)

The owner's reframing governs: **start from the video that already exists.** No new generation
pipeline — the episode is *derived* from the project.

1. **Audio derivation (the foundation, effort S–M).** One ffmpeg pass over the project's existing
   media — the same inputs `buildPlayerConfig` already resolves — mixing narration + guidance
   audio into a single `m4a`; chapters from `timeline_sections`, captions re-emitted from the
   existing VTT (per-language once dubbing ships: a dubbed project's audio edition reuses that
   dub's mix and ITS captions, honouring the caption-provenance ruling). Stored as one derived
   artifact per project+language behind the same idempotency discipline as captions
   (`source_hash`), downloadable by the creator, served publicly via `/{slug}/audio`. A pg-boss
   job on the existing queue — NOT the GPU export path; audio extraction is cheap.
2. **The landing surface.** `/{slug}/audio` rides the Library-share rails: public or tokened
   exactly like `/library`, one player page, zero new storage semantics.
3. **Hands-Busy Mode — the locked-phone answer, a design commitment, not a detail.** The page
   plays through a plain `<audio>` element — **not** WebAudio — because mobile Safari and Chrome
   keep a playing `<audio>` element alive when the screen locks, and kill WebAudio contexts. On
   top: the **Media Session API** (lock-screen title/artwork/seek/skip;
   `navigator.mediaSession.setActionHandler` for prev/next chapter), a **PWA manifest + service
   worker** precaching the episode so a dropped connection mid-drive does not stop playback, and
   interaction points delivered as *audio prompts answered by single tap or voice* — never a
   visual-only affordance, because the screen is assumed dark. Ruled OUT: any interaction that
   requires looking at the screen while driving; those degrade to "saved for later" markers the
   listener reviews when stopped.
4. **The three surfaces, in build order.** *Raise Your Hand* first (typed Q&A → voice barge-in,
   budget-gated like dubbing, $0 while listening). *Hands-Busy Mode* is item 3 plus a
   "long-drive" preset (huge tap targets, auto-resume). *Call It* last — a phone number per show
   via SIP realtime, the most expensive surface; it waits until Raise Your Hand has real
   listener-question data proving demand.
5. **Sequencing.** A2.1 derivation job → A2.2 `/{slug}/audio` landing → A2.3 Media Session/PWA →
   A2.4 Raise Your Hand → A2.5 Call It. Each stage shippable alone. The two features are planned
   together — `/{slug}/audio` is the shared spine.

---

## 🟡 A2.3 — SERVICE WORKER vs KILL-SWITCH: option (2) SHIPPED, (1) still needs a ruling only if wanted

Found while building A2.2, 2026-08-22. The P3-B design says Hands-Busy Mode gets "a **PWA manifest
+ service worker** precaching the episode so a dropped connection mid-drive does not stop playback."
It was written without knowing this exists:

`client-web/app/layout.tsx:40` ships an unconditional kill-switch that runs on EVERY page load and
unregisters EVERY service worker, then deletes every Cache Storage entry. There is exactly one root
layout and no route can opt out, so **any service worker this feature registers is destroyed the
next time the listener opens any page in the app** — silently, with the audio page appearing to
work until the moment the connection drops.

The kill-switch is not incidental. It was added after a stale SW from a prior deploy kept serving
cached `http://localhost:8080/...` URLs to real browsers, and `production-smoke.spec.ts:59` now
asserts zero registrations in production. Both are load-bearing.

**Three ways out, and they are genuinely different bets:**

1. **Narrow the kill-switch to foreign workers** — keep unregistering anything whose `scriptURL` is
   not exactly ours. Cheapest, and it preserves the original intent (the incident was a FOREIGN
   stale worker). The cost is real: the blanket unregister is currently the recovery path for a bad
   SW, and once ours is exempt, a bad version of OURS needs its own kill path — a version check in
   the worker, plus a way to ship a worker that unregisters itself.
2. **No service worker; download the file and play from a blob.** `fetch` the m4a, hold it as an
   object URL. Genuinely offline for the session, no SW, no conflict, no weakening. The cost is
   the wait: a 40-minute lesson at 96 kbps is ~29 MB, and playback cannot start until it lands.
   Acceptable for a "download for the drive" button; not acceptable as the default play path.
3. **Both** — stream normally on tap, offer an explicit "save for offline" that does (2). Most
   work; matches what podcast apps actually do, and asks the listener rather than guessing.

**Recommendation: (3), with (2) as the first shippable half.** It needs no change to the
kill-switch at all, which means A2.3 stops depending on a ruling about a security-adjacent
protection. If offline-by-default later proves necessary, (1) can be taken deliberately, with the
self-kill path designed rather than discovered.

**Not blocking anything else.** Media Session — the other half of A2.3, and the half that actually
answers "the phone is locked" — shipped with A2.2 and needs no service worker: lock-screen title,
chapter skip, seek, and position state all work today. A2.4 (Raise Your Hand) does not depend on
this answer either.

### SHIPPED 2026-08-22 — option (2), which needed no ruling

`lib/offlineAudio.ts` + a "Save for the drive" button. An explicit download into a Blob the
listener ASKS for: genuinely offline for the session, no worker, no exemption from the kill-switch,
nothing weakened. A Blob rather than Cache Storage because the kill-switch clears that too, so
anything written there is gone by the next navigation.

Deliberately NOT offline-by-default: ~29 MB for a forty-minute lesson, and playback cannot start
until it lands, so making it the default would trade an instant start for a wait on every listen.

**What is still open, and only if the owner wants it:** offline-by-DEFAULT needs option (1) —
narrowing the kill-switch to foreign workers. That remains a real ruling about a protection added
after an incident, and it now buys a convenience rather than the feature itself.

