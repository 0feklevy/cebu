# NEXT PHASE — plan of record, 2026-09-03 (after v0.3.0)

Built from the owner's post-deploy report and rulings (ledger, "📋 OWNER REPORT 2026-09-03"), and
from a code survey with file:line evidence for every claim below. Owner-completed production work
(backfill, disk cleanup, DB census, bucket census) is treated as fact and not re-derived.

The owner's priority order, verbatim: (1) credential rotation, (2) permanent Docker release
retention + disk guard, (3) listener-question creator inbox, (4) safe storage-orphan reconciliation
tooling, (5) staged R2 readiness/migration, (6) narrow playlist → course publishing.

---

## 0. Sequence at a glance

| # | PR | Branch | Depends on | Owner action | Size |
|---|---|---|---|---|---|
| 0a | #172 hotfix v0.3.1 — layout regression | `hotfix/v0.3.1-layout` | — | none (dispatch delegated) | done, in CI |
| 0b | #173 share library: a banner for every simulation, and a fast first paint | `fix/library-banners` | 0a | none | M — built, in PR |
| 1 | credential rotation | — (owner) | — | **rotate Anam key** | owner |
| 2 | #174 deploy: keep current + one rollback, refuse a low-disk deploy | `ops/image-retention-disk-guard` | — | none | S — built, waiting for #173 to merge |
| 3 | #175 listener inbox: creator reads, replies, listener sees the reply | `feat/listener-inbox` | — | none | L — built, waiting for #174 |
| 4 | #176 storage reconciliation (dry-run) + multipart listing/abort sweep + delete-GC gaps | `ops/storage-reconcile` | — | run the dry-run on the VM, read the report | L — built |
| 5 | #177 R2 readiness: capability probe, adapter parity, dual-read adapter, URL-rewrite dry-run | `feat/r2-readiness` | 4 (stacked) | R2 token with write/list/multipart; run the probe | L — built |
| 6 | #178 playlist → publish as course | `feat/publish-playlist-as-course` | — | none | M — built |

Each PR carries its own tests, a ledger line, and a `release:verify`-green CI. Releases: v0.3.1
(0a) now; v0.3.2 after 0b + 2 (both user-visible or ops-critical); the rest ride the next minor.
One open working branch at a time; the order above is the merge order.

---

## 0b. Share library — a banner for every simulation, and a fast first paint (#173)

**What the owner sees.** Simulation tiles show a gradient with a sparkle, and opening one stares at
"Loading simulation…" for seconds.

**Why (surveyed).** A poster is captured only in the creator's browser, 1.5 s after a section's
preview loads in the editor (`usePosterCapture.ts:75-81` ← `SectionEditor.tsx:812-820` ←
`TimelinePanel.tsx:2422-2426`); the route requires a timeline section with `simulation_id`
(`simulations.controller.ts:188-195`). So a simulation the creator has not re-opened since v0.3.0,
or one in the library but not placed in a section, can never have a poster — and the library lists
every ready simulation (`buildLibraryView.ts:231-247`). Every capture failure is swallowed
(`usePosterCapture.ts:64-67`). The tile renders the gradient whenever `bannerUrl` is null
(`LibraryCard.tsx:86-87`). Identity is NOT the problem: the library filters on `package_revision`
only (`buildLibraryView.ts:156`), a superset of what the capture stores.

Slowness, three independent causes: the `<link rel=prefetch>` names `material.url` while the frame
loads `resolveSimUrl(material.url)` with `?dpr=` appended (`LibraryGrid.tsx:68` vs
`shared/src/sim/simUrl.ts:86-89`) — the prefetch never hits; the 2 500 ms painted-signal fallback
(`usePaintedSignal.ts:34-38`) fires for real on every package published before the rAF gate,
because the gate is baked at publication, not injected at serve time (`SimulationService.ts:499`);
the text LRU is gated on `isRevision` (`sim-public.controller.ts:367,384`), so a legacy package
pays a storage read + sha1 + brotli per file per viewer per open.

**Design.**
1. **A simulation-level poster route** `POST /api/v1/projects/:id/simulations/:simId/poster` —
   same validation and `store → invalidate` pairing as the section route; identity = the
   simulation's default presentation (no section: `variantKey` = the entry URL's `?section=` or the
   sim id, `configHash` of `DEFAULT_PRESENTATION_CONFIG` at quality `high`, the project's aspect).
   The library's lookup is by `package_revision`, so this poster banners the tile; the player keeps
   looking up its section identity as before.
2. **A banner sweep in the editor.** `useBannerSweep(projectId, simulations, aspect)`: on editor
   open, for each ready simulation whose listing says `poster_url: null` (the sims listing gains
   `poster_url` from `loadSimBannerUrls`), mount ONE hidden authoring frame at a time, wait for
   load + 1.5 s, `connectSimAuthoring → snapshot → renderPosterRenditions → upload`, then the next.
   Concurrency 1, at most 12 per session, never while a section editor's own preview is capturing.
   Failures are counted and shown: the Simulations panel header gets a one-line status ("Banners:
   4 of 5 · 1 could not draw itself") and a "Capture banners" button that forces a pass.
3. **Library fallback to a retired revision's poster.** `loadSimBannerUrls`: when no row matches
   the served revision, accept the newest poster whose `package_revision` belongs to a revision
   with `status = 'retired'` (previously served — never a candidate that was not activated, which is
   what the 2026-08-30 ruling protects). A stale banner beats a gradient; the sweep replaces it.
4. **Prefetch the URL the frame will actually request** — `resolveSimUrl(material.url, { hideSelectors: [] })`.
5. **Serve-time painted fallback.** The boot snippet (already injected at serve time,
   `sim-public.controller.ts:53-57`) posts `{type:'SIM_PAINTED', fallback:1}` on the second
   animation frame after `load` when `window.__SIM_RAF_GATE__` is absent — the pre-gate packages.
   Client fallback timer 2 500 → 1 200 ms.
6. **Legacy text cached too**, in a second `SimTextCache` with a 30 s TTL, evicted by prefix on the
   writers that rewrite a legacy package in place (`SimulationService.ts:2361,2491`,
   `SimulationImportService.ts:155`, `GuidanceService.ts:530,700,736`).

**Files.** `backend-api/src/controllers/v1/simulations.controller.ts`, `services/library/buildLibraryView.ts`,
`controllers/sim-public.controller.ts`, `services/simulation/simTextCache.ts`, the three writers;
`shared/src/generated/client-v1.ts` (`uploadSimulationPoster`, `Simulation.poster_url`);
`client-web/components/useBannerSweep.ts` (new), `VideoEditor.tsx`, `library/LibraryGrid.tsx`,
`library/usePaintedSignal.ts`.

**Acceptance.** A project whose creator opens the editor once has a banner for every ready
simulation within a minute, without opening any section (test: sweep hook with a fake authoring
session). A library whose served revision was never captured shows the retired revision's poster
(test: `loadSimBannerUrls` with an active + a retired row). The prefetch `href` equals the frame's
`src` (test). A document without the gate posts `SIM_PAINTED` from the snippet (jsdom test of the
snippet source). The second request for a legacy text asset costs no storage read; a rewrite of
that package serves the new bytes on the next request (tests).

---

## 1. Credential rotation (owner)

Not a PR. The exposed Anam key is rotated by issuing a new credential in Anam and entering it in
Admin → API Keys → Anam, then invalidating the old one at Anam. The read path is the admin key
store (ledger "CLOSED IN CODE — every API token visible in admin"), so no deploy is needed; verify
by starting one avatar session after the swap. The memory `key-rotation-needs-a-reader` is the
rule: rotate where the code reads. **Also from the owner's list:** the three smoke variables — set
from the real public playlist/test URLs created during the earlier production work (GitHub →
Settings → Secrets and variables → Actions → Variables); the demo avatar's "Max session length";
the paid dubbing probe only with explicit approval.

---

## 2. Deploy: keep current + one rollback, refuse a low-disk deploy (#174)

**Facts.** The only cleanup is `docker image prune -f` — dangling layers — at
`deploy/scripts/deploy-images.sh:161` and `deploy.sh:172-174`; every
`podcast-saas/{backend,client-web,admin-web}:vX.Y.Z` tag ever deployed stays. The only guard
block on the image path (`deploy-images.sh:39-44`) has no disk check; `deploy.sh:131-135` warns
below 5 GB and does not block; the release engine's `vm.disk-low` is WARNING severity
(`ops/release/src/commands.ts:275-277`). Versions on the VM: `deploy/.deploy-state`
(`PREVIOUS_VERSION`, `CURRENT_VERSION`) and `deploy/.env` (`APP_VERSION`); `rollback.sh:24-34`
hard-fails if the target version's three images are absent locally; `rollback.sh:80` does not
update `PREVIOUS_VERSION`. Compose services share exactly three app images
(`worker` reuses `backend`); `nginx` and `certbot` are upstream images outside the namespace.

**Design.**
- `_lib.sh`: `retain_app_images KEEP_A KEEP_B` — lists `podcast-saas/{backend,client-web,admin-web}`
  tags, removes every tag not in the keep set with `docker image rm` (never `-f`: an image in use
  by a container refuses, and that refusal is correct), never touches other namespaces, volumes,
  nginx, certbot, or the digest-pinned GHCR references of the kept versions; prints what it removed
  and what it kept. Called from `deploy-images.sh`'s success block (after the health gate, before
  `prune -f`) with `VERSION` and `OLD_VERSION`, and from `deploy.sh`'s equivalent. `rollback.sh` is
  left alone on purpose: after a rollback, `APP_VERSION` is the target, and the NEXT successful
  deploy's `OLD_VERSION` is that target — so the failed release is what gets pruned then, and
  `rollback.sh` without an argument keeps pointing where it did. Also `retain-images.sh`, the
  by-hand version of the same policy (the 2026-09-03 cleanup was by hand).
- `_lib.sh`: `require_free_disk_gb PATH MIN` — `df -PBG`; in `deploy-images.sh`'s guard block with
  `DEPLOY_MIN_FREE_GB` (default 8) for `/var/lib/docker`, refusing before any pull; overridable with
  `DEPLOY_ALLOW_LOW_DISK=1` for an emergency. NOT in the git-only sync script of
  `remote-deploy.ts`: its tested contract is that it never mentions docker (`remote-sync.test.ts`),
  and the VM script's refusal is streamed into the CI log anyway, before any pull. `vm.disk-low` in
  `commands.ts` becomes HIGH below 3 GB and a WARNING below 8 (post-deploy: a rollback frees nothing,
  so the pre-deploy refusal is the gate; the audit finding is the alarm).
- `deploy/README.md`: the retention policy in one paragraph; the owner's manual cleanup of
  2026-09-03 recorded as the reason.

**Tests.** A shell test under `deploy/scripts/__tests__/` (bash, a `docker` shim on `PATH` that
records calls) for `retain_app_images` (keeps two, removes the rest, ignores nginx/certbot, tolerates
an in-use refusal) and `require_free_disk_gb` (refuses below, passes above, override honoured);
run by the existing CI static-audit step. `deployTopology.test.ts` unchanged.

**Acceptance.** After a successful deploy the VM holds exactly two app versions; a rollback still
works; a VM with < 8 GB free refuses to deploy with a clear message before pulling anything.

---

## 3. Listener inbox — creator reads, replies, listener sees the reply (#175)

**Facts.** `listener_questions` (migration 072; `schema.ts:1884-1901`): `question`, the MODEL's
`answer`, `status` saved|answered|failed, `position_ms`, `language`, `asked_by` (null when
anonymous), `answered_at`, `cost_cents`. Routes: the two public ask routes; a creator list
`GET /api/v1/projects/:id/questions` (`audioEdition.controller.ts:362-391`, editable-project auth,
newest 200) with **zero clients**. No column for a creator's reply, no write route, no
notification. The voice path stores through the same service, so a spoken question is a text row
already (its transcript).

**Design (V1, kept simple).**
- Migration 083 `listener_question_replies`: add to `listener_questions` — `source text NOT NULL
  DEFAULT 'text'` (`text` | `voice`; the voice route sets it), `creator_reply text`,
  `creator_replied_at timestamptz`, `seen_at timestamptz`. Additive; rollback file; registered in
  `migrate.ts` and `check-db.ts`.
- Routes: `GET /api/v1/projects/:id/questions?status=unanswered|answered|all&limit=&cursor=` returns
  rows with the new fields plus the edition's chapter title at `position_ms` (lesson context);
  `GET …/questions/summary` → `{ unanswered, total }` for the badge; `PATCH …/questions/:qid`
  `{ creator_reply }` (editable-project; empty string clears; sets `creator_replied_at`);
  `POST …/questions/seen` marks all seen. **Listener side:** `GET /api/v1/public/audio/:slug/replies?language=`
  returns questions WITH a creator reply (question, reply, position_ms, replied_at) — public-only
  project, per-IP limited like the other public reads — so the audio page can show "The creator
  answered" at the matching chapter, and a listener who asked gets the reply by returning to the
  episode (anonymous listeners have no other channel; `asked_by` users get the same view).
- Client: `ListenerInboxDialog.tsx` opened from the project header (a button "Questions" with the
  unanswered count, beside Share), listing newest first with the unanswered filter default: the
  question, 🎤 for voice, the position as `mm:ss` (click seeks the podcast preview), the language,
  the model's answer (collapsed), a reply box, and the reply once sent. On the public audio page: a
  compact "Creator replies" sheet reachable from the transcript/timeline, and a marker on the
  progress bar at each replied position.
- `lib/api.ts` / `client-v1.ts`: `listListenerQuestions`, `listenerQuestionSummary`,
  `replyListenerQuestion`, `markListenerQuestionsSeen`; `audioEditionApi.ts`: `listCreatorReplies`.

**Tests.** Route tests in the fake-app style of `audioEditionAccess.test.ts` (filter, cursor, the
PATCH's auth and clearing, the public replies route hiding unreplied rows and private projects);
`ListenerInboxDialog.test.tsx` (filter, reply round-trip, seek callback); the car-mode player test
gains the replies marker. Contract test `clientV1RouteContract` updated.

**Acceptance.** A creator opens the inbox from the header, sees every question with its context,
replies in one box; a listener returning to the episode sees the reply at that position. The
unanswered count is visible without opening anything.

---

## 4. Storage reconciliation (dry-run), multipart sweep, delete-GC gaps (#176)

**Facts.** No tool lists a bucket prefix and diffs it against DB columns; `storage-census.sql`
section G (`:305-315`) is the specification of the nine diffs that do not exist. `listObjects` and
`headObject` exist on every adapter (`StorageService.ts:88,102`); `abortMultipartUpload` exists
(`:37`) but **no adapter can list multipart uploads** — an abandoned upload's id is lost and the
parts are unreachable (census G9). The blob sweeper covers `blobs/` only (`blobSweeper.ts:66-76`);
`hlsRetention.ts` covers retired HLS runs. The project-delete GC (`projects.controller.ts:475-515`)
collects videos, HLS, sims, audio, images, crop, avatar visuals, thumbnails, captions, corpus,
exports, avatar-circles — and **not `dubs/`, `editions/`, `podcasts/`**; `video_dubs` and
`project_audio_editions` rows cascade with their bytes left behind. The owner's census: 18 terminal
exports without `output_key`, 7 ready exports with a possibly-redundant `sections/`, 3 failed
duplications with a plan, 4 videos with both inline and stored captions, avatar references that
leak on delete, 4 unfinished multipart uploads with 81 parts.

**Design.**
- `StorageService`: `listMultipartUploads(prefix?) → { key, uploadId, initiated }[]` on all three
  adapters (S3 `ListMultipartUploadsCommand`; local: none).
- `backend-api/src/scripts/storage-reconcile.ts` (`pnpm --filter backend-api storage:reconcile`),
  **dry-run by default**, one family per `--family=`: `thumbnails`, `playlist-banners`, `captions`,
  `crop`, `exports`, `videos`, `podcasts`, `avatar`, `dubs`, `editions`, `multipart`. For each: the
  DB reference set (the columns in the survey's table E), the bucket listing under the prefix,
  `headObject` for size + last-modified, then three lists — orphan (bucket, no row), dangling (row,
  no object), redundant (rule-specific: `exports/*/sections/` under a ready export with
  `output_key`; `captions/` object for a row whose `captions_vtt` is inline). Output: a table and
  `--json=<path>`; totals in bytes. Nothing is deleted without `--apply --delete=<family>` AND
  `--older-than=7d` (by last-modified), and never for `blobs/` (the sweeper's), `videos/`, `hls/`,
  `editions/`, or any object younger than the grace. Refuses a transaction-pooler URL like the
  census runner. Reads only through the adapter; never a raw S3 client in the script.
- Multipart: `--family=multipart` lists uploads with age; `--apply --abort-older-than=7d` aborts.
  A periodic sweep `startMultipartAbortSweep()` (daily, age 7 d, logged, `MULTIPART_ABORT_SWEEP=0`
  to disable) beside the blob sweep — the owner's "age-based sweep rather than a one-off".
- Project-delete GC gains `dubs/{videoId}` and `editions/{projectId}`; podcast episodes keep their
  own delete path. Recorded in the ledger as the fix for the census's "no delete path" finding.

**Tests.** Reconcile core as pure functions (`reconcileFamily(refs, objects, rule)`) with table
tests per family; adapter `listMultipartUploads` against the existing S3 mock; the GC's prefix list
asserted in `projects.controller` tests; the sweep's age rule.

**As shipped (#176), two names differ from the text above:** the multipart family uses the same
`--older-than=<age>` flag as every family (there is no separate `--abort-older-than`), and the
probe's scratch prefix is `_probe/<ts>/` (underscored, so it sorts first in a listing).

**Owner steps.** Run `storage:reconcile --family=multipart` first (the 4 uploads: keys and dates),
then each family dry-run, read the JSON, decide per family; only then `--apply`. Nothing runs
against production from the dev machine.

---

## 5. R2 readiness — probe, parity, dual-read, URL rewrite (#177)

**Facts.** `getStorageAdapter.ts:45-46,92-93`: Supabase is the writable provider because the R2
token was read-only; `forceLocalStorage` exists for the R2 write-probe denial (`:23-30`).
Resolution order `:55-109` with the production fail-closed guard first. `verify:storage`
(`scripts/verify-storage.ts`) is PUT → read → list → presigned GET → public fetch → delete against
the RESOLVED adapter. Parity gaps found: `R2StorageAdapter.getSimPublicUrl` has no poster branch
(`R2:326-330`, Supabase `:432-447`), `keyFromPublicUrl` reverses one vendor's shape; the
`/hls-proxy` detour exists because r2.dev CORS was unverified. URL-bearing columns (survey E):
`corpora.storage_url`, `simulations.entry_file`, `image_files.original_url`, `audio_files.url`,
`playlists.banner_url`, `projects.thumbnail_url`, `avatar_visuals.image_url/sim_entry_url`,
guidance `mdUrl`/`audioUrl` in JSONB. Bucket: ~10.3 GiB, 3,200 objects (owner census) — the copy
window is hours, not days.

**Design (staged, exactly the owner's sequence).**
1. `scripts/storage-probe.ts` (`storage:probe --backend=r2|supabase`): builds the NAMED adapter
   from its env (never the resolved one), runs a capability matrix — put, get, head, list, copy,
   multipart create + part + complete, multipart abort, list-multipart, delete, delete-prefix,
   presigned GET, public URL fetch with the app origins' CORS preflight, cache headers observed —
   under a `probe/<ts>/` prefix it deletes after. Prints PASS/FAIL per capability; exits non-zero on
   any FAIL. **The owner runs it** with the R2 token (step 1–3 of the ruling).
2. Parity: R2 poster branch, `keyFromPublicUrl` for both shapes, `R2_PUBLIC_BASE_URL`
   (custom domain) honoured by `getPublicUrl`/`getSimPublicUrl`, `ensureBucketCors` for the app
   origins.
3. `MigratingStorageAdapter` (writes → primary; reads/head/exists → primary, then secondary;
   delete → both; presigned/public URLs → primary) selected by `STORAGE_BACKEND=migrating` with
   `STORAGE_PRIMARY`/`STORAGE_SECONDARY`. This is what keeps rollback and read compatibility while
   objects move (steps 4–5).
4. `scripts/storage-rewrite-urls.ts` — dry-run first; rewrites the URL-bearing columns from the
   Supabase public base to the R2 base only where the object exists on R2 (`headObject`); resumable;
   reports counts.
5. Runbook (in this plan, §5 of the night-run doc updated): `rclone sync` public prefixes → R2,
   probe, flip to `migrating` (primary R2) in a release, run the rewrite, watch a week, flip to `r2`,
   keep Supabase read-only 30 days.

**Tests.** Probe matrix against the S3 mock; adapter parity tests (`getSimPublicUrl` poster branch,
`keyFromPublicUrl` both shapes); `MigratingStorageAdapter` read-through and delete-both; the
rewrite script's pure planner.

**Owner steps.** Cloudflare account, R2 bucket, custom domain, a token with write/list/multipart;
run `storage:probe --backend=r2` and paste the matrix.

---

## 6. Playlist → publish as course (#178)

**Facts.** `courses` (migration 030/032; `schema.ts:1111-1175`) and `course_lessons` (`:1177-1210`)
exist with no live rows; `courses.controller.ts` has the full authoring API (create, content, seo,
slug, lessons add/patch/delete/reorder, readiness, publish/unpublish/unlist/archive/restore) with
**zero clients**; the public pages `/c/[courseSlug]` and `/c/[courseSlug]/[lessonSlug]` render
through `courseApi.ts`. The only playlist↔course link is `courses.legacy_playlist_id`
(backfill provenance, unique per playlist, `:1151,1161`); nothing keeps `playlist_items` and
`course_lessons` in sync. `PlaylistEditorDialog.tsx` edits title, description, flags, items, banner,
share — no course concept.

**Design (narrow, the owner's V1).**
- Backend: `POST /api/v1/playlists/:id/course` — creates the course if none (kind `playlist`,
  `legacy_playlist_id` = the playlist — from now on the LIVE link, documented as such; title,
  description, cover from the playlist banner; slug from the title, unique-checked), then syncs
  `course_lessons` from `playlist_items` (upsert by `project_id`, positions, lesson slug from the
  project title), runs readiness, and publishes when `{ publish: true }`. `GET /api/v1/playlists/:id/course`
  returns the course state + public URL + readiness; `DELETE …/course` unpublishes. `PUT /playlists/:id/items`
  re-syncs lessons when a course exists (so the course follows the playlist, which is the whole
  point of "publish a playlist").
- Client: a "Course" section at the bottom of `PlaylistEditorDialog`: state line (not published /
  published at `/c/<slug>` with a copy button), slug field with availability, buttons "Publish as
  course" / "Update" / "Unpublish", the readiness reasons when it cannot publish. Nothing else: no
  course list page, no SEO panel (the API exists for later).
- The home tour's playlists step already says "a course of lessons"; the step gains the button's name.

**Tests.** Route tests (create-then-sync idempotent, sync on items change, publish refusal with
readiness reasons, unpublish); dialog test (publish round-trip, slug availability).

**Acceptance.** A playlist of public projects becomes a course at `/c/<slug>` in one click from the
playlist editor; reordering the playlist reorders the course; unpublish takes it down.

---

## 7. Ledger and memory

Each PR adds one line to the ledger's PR index under the OWNER REPORT section. The open 🔴 for the
share library closes with #173; the 🟡 for courses closes with #178; the ops 🔴 for retention closes
with #174. The next-phase's own outcome table is appended here as §8 when the sequence is done.

---

## 8. Outcome (2026-09-03, end of the sequence)

| # | PR | State | Delivered |
|---|---|---|---|
| 0a | #172 | merged | the layout regression of v0.3.0 (every `min-[…]:`/`max-[…]:` variant disabled by a raw screen; the import gallery trapped in the rail) — the owner dispatches v0.3.1 |
| 0b | #173 | merged | a banner for every simulation (editor sweep + simulation-level poster route + retired-revision fallback) and a first paint that does not wait for a timer (resolved prefetch, serve-time `SIM_PAINTED_FALLBACK`, legacy text cache) |
| 1 | — | owner | credential rotation (Anam), the smoke variables, the demo avatar's session length — owner actions, see §1 |
| 2 | #174 | merged | release retention (current + one rollback) and the 8 GB disk guard in the deploy; shell-tested with a docker/df shim |
| 3 | #175 | merged | the listener-question creator inbox: migration 083, five routes, the dialog, the header badge, the car-mode replies |
| 4 | #176 | merged | `storage:reconcile` (dry-run), the multipart listing + weekly abort sweep, project delete sweeps dubs/ and editions/ |
| 5 | #177 | merged | `storage:probe` per named provider, the migrating adapter, `R2_PUBLIC_BASE_URL`, `storage:rewrite-urls` (dry-run) |
| 6 | #178 | merged | playlist → publish as course, with the address field and availability check |

**What the owner does next (in order):** rotate the Anam key; dispatch the releases (one `bump=patch`
after #172/#173 if not yet done, then `bump=minor` once #174–#178 are in); on the VM run
`storage:reconcile --family=multipart` then `--family=all --json`; with the R2 token run
`storage:probe -- --backend=r2`; decide the R2 window from the probe; set the three smoke variables.

**Audits.** Every PR was audited by the task-tracker against this plan before merge; the one gap it
found (§6's slug field) was built before the PR opened. Deviations from the text are recorded
inline (§4, §5) or in the ledger.
