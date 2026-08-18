# Performance & Scalability Review — FlowVid

Scope: backend hot paths (`podcast-saas/backend-api/src/{services,controllers,jobs,queue}/**`) and
frontend cost (`client-web/**`, `admin-web/**`). Production host is 2 vCPU; headless capture is
already ~10x too slow there, so the concurrency/cost model matters more than usual here.

Method: swept the five named hot paths (upload → storage write, export → ffmpeg assembly,
transcode job, project list, podcast render), grepped the sink patterns
(`readFileSync`, `arrayBuffer(`, `toBuffer(`, `spawn(`, loop-`await`, `.map(async`), and confirmed
every finding by reading the whole function plus its caller chain. Two findings below were
originally raised by `backend-reviewer` as cross-domain signals (`simulations.controller.ts:641`,
`admin/v1/billing.controller.ts:14`); I independently verified both and they are reported here
under my column, with their own ids.

---

### [P1] Audio upload buffers the entire file into the Node heap with no size cap
- id: performance-001
- location: podcast-saas/backend-api/src/controllers/v1/audio.controller.ts:67
- category: perf
- confidence: high
- status: confirmed
- what: `POST /api/v1/projects/:id/audio` calls `await data.toBuffer()` on the multipart file, then
  writes that buffer to a tmp file for ffprobe, then hands the *same* buffer to `uploadWithFallback`
  (which calls the storage adapter's buffer-based `uploadFile`, not `uploadStream`). The route
  registers no per-route `fileSize` override, so it inherits the global multipart limit at
  `server.ts:199` — 10 GB.
- why: **Cost model: memory is O(file size) per concurrent upload, with no ceiling below 10 GB.**
  Podcast/video audio is exactly the content this app is built to ingest — a raw multi-hour
  recording can legitimately be several hundred MB to low GB. Two or three such uploads landing
  concurrently on the 2-vCPU production host (stack.md's own stated constraint) will hold multiple
  full-file buffers in the heap simultaneously and can OOM-kill the API process, taking down every
  other request it is serving. The codebase already has the fix pattern next to this file:
  `video.controller.ts:161` streams `part.file` straight into `uploadStreamWithFallback` and never
  materializes the file in memory (see `services/storage/uploadStreamWithFallback.ts`'s own
  docstring: "the stream is piped straight to the shared object store so the bytes never touch
  local disk"). Audio just didn't get the same treatment.
- evidence: Read `audio.controller.ts:50-84` in full. `data.toBuffer()` at line 67, `uploadWithFallback(key, buf, …)` at line 70 — `uploadWithFallback` (`services/storage/uploadWithFallback.ts:17`) takes a `Buffer` parameter, not a stream. `server.ts:198-199`: `await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 * 1024 } })` with no override in this file (grepped `fileSize|limits` in `audio.controller.ts` — no hits). Contrast: `avatar.controller.ts:578-579` sets `limits: { fileSize: AVATAR_LIBRARY_UPLOAD_MAX_BYTES }` (250 MB) on its own multipart registration, and `video.controller.ts:161` streams. Both patterns exist in this codebase; audio uses neither.
- fix: Switch to `uploadStreamWithFallback(key, part.file, mime, fileSize)` the way `video.controller.ts` does, and probe duration from the streamed-to-disk tmp file (which the route already creates for ffprobe) instead of from an in-memory buffer. If a buffer-based path must stay for now, at minimum add a per-route `{ limits: { fileSize: N } }` (e.g. 500 MB–1 GB) on `request.file()` so a single upload cannot claim unbounded memory.
- effort: M
- cross: (none)

### [P2] Corpus source upload buffers the whole file (audio/video allowed) with no size cap
- id: performance-002
- location: podcast-saas/backend-api/src/controllers/v1/corpus.controller.ts:69
- category: perf
- confidence: high
- status: confirmed
- what: `POST /api/v1/projects/:id/corpus` reads the multipart file with `await data.toBuffer()`
  then uploads the buffer via `getStorageAdapter().uploadFile(storagePath, buffer, mime)`.
  `detectSourceType` (same file, line ~42) explicitly classifies `audio/*` and `video/*` mimetypes
  as valid corpus sources — this is not an images-only route. No per-route `fileSize` override.
- why: **Cost model: memory is O(file size) per concurrent corpus upload**, same shape as
  performance-001. Corpus ingestion is meant to take source audio/video/PDF; a user uploading a
  lecture recording as ingestion material buffers the whole thing before the storage write even
  starts, and again inside `CorpusBuilder.ingest` (`services/ingestion/CorpusBuilder.ts:83`,
  `Buffer.from(await resp.arrayBuffer())`) when the async ingestion job re-downloads it to
  transcribe/caption/extract.
- evidence: Read `corpus.controller.ts:55-90`. `detectSourceType` at the top of the file maps
  `mime.startsWith('audio/') || mime.startsWith('video/')` to `'audio'` (source type). Grepped
  `fileSize|limits` in the file — no hits, same as performance-001.
- fix: Same remedy as performance-001 — stream through `uploadStreamWithFallback` and add an
  explicit per-route size cap (corpus source files are ingestion inputs, not raw masters, so a cap
  well under the video-raw ceiling, e.g. 500 MB, is defensible and should be enforced server-side
  regardless of streaming).
- effort: M
- cross: (none)

### [P2] Podcast episode source upload has the same unbounded buffer-upload shape
- id: performance-003
- location: podcast-saas/backend-api/src/controllers/v1/podcast.controller.ts:397
- category: perf
- confidence: high
- status: confirmed
- what: `POST /api/v1/podcasts/:showId/episodes/:epId/sources/upload` does
  `const buffer = await data.toBuffer()` then `getStorageAdapter().uploadFile(storageKey, buffer, mime)`.
  No mimetype allowlist restricts this to small files, and no per-route `fileSize` limit is set.
- why: Same cost model as performance-001/002 — podcast episode sources are exactly the kind of
  content (recorded audio, video) that can be large, and this route inherits the 10 GB global
  default with nothing streaming.
- evidence: Read `podcast.controller.ts:387-410`. `data.toBuffer()` at line 397,
  `uploadFile(storageKey, buffer, mime)` at line 403.
- fix: Same as performance-001/002 — stream to storage, add an explicit route-level size cap.
- effort: M
- cross: (none)

### [P1] Production sim-capture's frame→clip ffmpeg encode bypasses the shared concurrency limiter
- id: performance-004
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:156
- category: perf
- confidence: high
- status: confirmed
- what: `encodeFramesToClip` — called from `captureSection` (line 372) whenever the container
  worker returns frames instead of a pre-encoded clip — spawns `ffmpeg` directly:
  `const proc = spawn('ffmpeg', args, { stdio: [...] })`. This file never imports
  `runFfmpegLimited` from `services/ffmpegLimit.ts` (grepped the whole file — zero hits). The
  file's own header docstring identifies it as **"The PRODUCTION capture provider"**
  (`containerCaptureProvider.ts:2`), gated on `EXPORT_CAPTURE_IMAGE`, not a dev-only path.
- why: **Cost model: every concurrent export whose capture backend returns frames spawns an
  unlimited, uncoordinated ffmpeg process on top of whatever HLS transcode / caption / crop /
  LinearAssembler ffmpeg work is already running under the shared cap.** `ffmpegLimit.ts`'s own
  docstring states the exact intent this violates: "Every subsystem (HLS transcode, captions, crop,
  frame-preview, waveform) spawns ffmpeg independently. Without a shared cap, a burst of uploads or
  timeline scrubs can spawn many simultaneous ffmpeg processes and saturate a single-node host."
  Capture is explicitly named in stack.md §6.2 as one of the paths whose concurrency "is bounded by
  `services/ffmpegLimit.ts`; verify every spawn path honours it" — this one does not. On the
  2-vCPU host, where capture is already measured ~10x too slow, two or three concurrent exports
  each spawning their own unbounded encode on top of the existing FFMPEG_CONCURRENCY=2 traffic
  makes the throughput problem worse, not better, and risks CPU starvation for the ffmpeg jobs that
  *are* correctly queued.
- evidence: Read the whole file. `import { spawn } from 'node:child_process'` (line 27) is the only
  process-spawning import; no `ffmpegLimit` import anywhere. Compare
  `services/export/LinearAssembler.ts:32` (`import { runFfmpegLimited } from '../ffmpegLimit.js'`)
  and `services/video/HLSTranscoder.ts:7` / `services/podcast/audio/ffmpegAudio.ts:16`, which all
  wrap every spawn. `captureSection` calls `encodeFramesToClip` unwrapped at line 372-378.
- fix: Wrap the `encodeFramesToClip` call (or the `spawn` inside it) in
  `runFfmpegLimited(() => encodeFramesToClip(...))`, matching every other ffmpeg call site in the
  export pipeline.
- effort: S
- cross: @media-pipeline (this is the same file that owns capture correctness; flagging the
  concurrency gap only)

### [P1] `download.zip` buffers an entire simulation package (up to ~500 MB) into the heap
- id: performance-005
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:641
- category: perf
- confidence: high
- status: confirmed
- what: `GET /api/v1/projects/:id/simulations/:simId/download.zip` lists every object under the
  simulation's storage prefix, then for each key does `const buf = await storage.readObject(key)`
  and `zip.addFile(relativePath, buf)` (lines 641-655), and finally `.send(zip.toBuffer())`
  (line 661) — building the whole zip in memory rather than streaming it to the response.
- why: **Cost model: peak memory is O(package size) × ~2 (the read buffers plus AdmZip's own
  internal buffer for `toBuffer()`), with no bound other than the 250 MB upload cap
  (`SIMULATION_UPLOAD_MAX_BYTES`, `simulations.controller.ts:61`).** A single request can hold up
  to ~500 MB in the Node heap; two users downloading concurrently (or one user with two tabs) can
  double that again on a 2-vCPU host with no per-request memory ceiling of its own.
- evidence: Read `simulations.controller.ts:627-663` in full. `storage.listObjects` then a
  synchronous-per-key `readObject` loop with no streaming, `AdmZip` accumulates all files in
  memory, `zip.toBuffer()` materializes the complete archive before `.send()`.
- fix: Stream the zip response instead of buffering it — either switch to a streaming zip library
  (e.g. `archiver`) piped directly into `reply.raw`, or at minimum stream each `readObject` result
  into the zip writer instead of buffering the whole package plus the whole zip simultaneously.
- effort: M
- cross: (raised by backend-reviewer as a signal; independently verified and filed here)

### [P2] Admin billing overview does an unbounded table scan and aggregates in JS instead of SQL
- id: performance-006
- location: podcast-saas/backend-api/src/controllers/admin/v1/billing.controller.ts:14
- category: perf
- confidence: high
- status: confirmed
- what: `GET /api/admin/v1/billing/overview` does `const all = await db.query.billing_transactions.findMany()`
  with no `where`/`limit`, then does two `.filter()` passes, two `.reduce()` passes, and two
  `new Set(...).size` passes over the full result in JS to compute totals/counts that are exactly
  `SUM`/`COUNT`/`COUNT(DISTINCT …)` in SQL.
- why: **Cost model: this endpoint transfers and holds every row `billing_transactions` has ever
  had, forever, growing linearly with the business's total transaction count** — it does not scale
  with time-window or page size, only with total history. The codebase already fixed this exact
  pattern once: `controllers/admin/v1/users.controller.ts:62-76` (`GET /api/admin/v1/usage`) has an
  explicit comment — "Aggregate in Postgres (GROUP BY) instead of streaming every token_usage row
  to Node and summing in JS — that transferred tens of thousands of rows for a 30-day window to
  compute a handful of totals (perf-004)" — and `controllers/admin/v1/pipeline-stats.controller.ts`
  does the same (all `sql<number>\`count(*)\`` / `sum(...)` aggregates, one `Promise.all` of typed
  queries). `billing/overview` is the one admin aggregate endpoint that regressed to the pattern
  perf-004 already fixed elsewhere.
- evidence: Read `billing.controller.ts:8-34` in full and compared against
  `users.controller.ts:54-89` and `pipeline-stats.controller.ts:8-55` in the same directory, both
  of which use `sql<number>` aggregate selects.
- fix: Replace the `findMany()` + JS reduce with grouped/aggregate SQL, mirroring
  `pipeline-stats.controller.ts`'s shape: one `select({ count: sql\`count(*)::int\`, volume:
  sql\`coalesce(sum(amount_cents),0)::int\`, … }).where(eq(status,'succeeded'))`, a second for
  `pending`, and `select({ n: sql\`count(distinct creator_user_id)::int\` })` for the two active-user
  counts — five small aggregate queries (or one `Promise.all` of them) instead of one unbounded
  `findMany()`.
- effort: S
- cross: (raised by backend-reviewer as a signal; independently verified and filed here)

### [P2] Per-turn clip loop does a DB round trip per turn instead of one batched query
- id: performance-007
- location: podcast-saas/backend-api/src/services/podcast/audio/runPodcastClips.ts:100
- category: perf
- confidence: high
- status: confirmed
- what: `buildClips` loops over `turnsWithClips` (one entry per script turn) and, inside the loop,
  runs `await applyTempo(...)` (ffmpeg, correctly limited), then
  `await db.query.podcast_clips.findFirst({ where: and(eq(episode_id,…), eq(turn_id,…), eq(take_hash,…)) })`
  to check whether an identical clip already exists (content-addressed dedup), before optionally
  inserting a new row.
- why: **Cost model: DB round trips scale 1:1 with turn count.** A podcast episode with N turns
  (tens to low hundreds for a real episode) does N sequential `findFirst` queries where one batched
  query would do. This runs inside a claimed background job (not blocking the API event loop), so
  the cost is job latency and DB connection churn rather than a live-request stall, but it is a
  clean N+1 with an easy batch fix and the loop already has everything (`episodeId` +
  `turnsWithClips` + their computed `take_hash`es) it needs to do it in one shot if hashing is
  reordered to happen before the loop.
- evidence: Read `runPodcastClips.ts:88-123` in full. The `existing` lookup at lines 100-102 is
  inside the `for (const turn of turnsWithClips)` loop and depends only on values already known
  before the loop starts (episode id, turn id, and — if `applyTempo`+hash were hoisted out of the
  per-turn body — the take_hash).
- fix: Two options depending on how invasive the team wants the change: (a) simplest — after
  computing all `takeHash`es (which requires `applyTempo` to have run, so this still needs one pass
  first), issue a single
  `db.query.podcast_clips.findMany({ where: and(eq(episode_id,…), inArray(take_hash, allHashes)) })`
  and build a `Map` keyed by `(turn_id, take_hash)` before the second pass that does the
  probe/upload/insert; or (b) add a unique index on `(episode_id, turn_id, take_hash)` and use
  `onConflictDoNothing().returning()` to fold the existence check into the insert itself.
- effort: M
- cross: (none)

### [P2] Anam session-token cache is a module-level Map with no eviction — grows for the life of the process
- id: performance-008
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:153
- category: perf
- confidence: high
- status: confirmed
- what: `tokenCache` (`const tokenCache = new Map<string, CachedToken>()`) is keyed by
  `sha1(apiKeySuffix + JSON.stringify(personaConfig))` (line 498) — a hash of the *entire persona
  config*, which varies per character/video/avatar/voice combination. Entries are written at line
  542 (`tokenCache.set(...)`) and read at line 499, but there is no expiry sweep, no `.delete()`
  call, and no `.clear()` reachable from any runtime code path (the only `.clear()` in the file,
  `invalidateAnamLlmCache` at line 297, clears `_llmIdCache` and `_defaultAvatarCache`, not
  `tokenCache`). The cached value is only ever *useful* for `TOKEN_REUSE_MS` = 6 seconds (the
  StrictMode double-mount dedupe the comment describes), but the entry itself lives forever.
- why: **Cost model: memory grows monotonically with the number of distinct (API key, persona
  config) combinations ever seen by the process, not with active usage** — every video's avatar
  session start (and every edit to a video's avatar persona config, which changes the JSON and
  therefore the cache key) adds one permanent entry holding a real Anam JWT. This is small per
  entry (~1-2 KB) but has zero bound and zero decay, so on a long-lived process it is a slow, silent
  leak that only a restart (deploy) clears — worth fixing cheaply since the fix is one line, and
  the pattern (bounded-with-eviction Map cache) already exists correctly elsewhere in this same
  codebase (`services/simulation/revisionIdentity.ts:65-66`, `MAX_ENTRIES = 5_000` with
  oldest-first eviction).
- evidence: Read the whole file (`anamService.ts`, 544 lines). Grepped `tokenCache` — three hits
  total (declare/get/set), no delete/clear/sweep. Contrast: `_llmIdCache` and
  `_defaultAvatarCache` in the same file are bounded in *cardinality* (keyed only by API-key
  suffix, a small fixed set) even though they also lack a sweep — `tokenCache`'s key space is
  unbounded because it includes the full persona JSON.
- fix: Either (a) reuse the `revisionIdentity.ts` bounded-Map pattern (cap size, evict
  oldest-insertion-first) since `Map` preserves insertion order, or (b) simplest given the 6-second
  TTL is the only thing that matters — replace the Map with a single `{ key, token, issuedAt }`
  slot (or a tiny fixed-size LRU) instead of an ever-growing keyed cache, since only the *most
  recent* call for a given persona within 6 seconds needs deduping.
- effort: S
- cross: (none)

### [P2] The public video viewer statically bundles katex + chart.js + the Anam avatar SDK for every page view
- id: performance-009
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:5
- category: perf
- confidence: medium
- status: suspected
- what: `AvatarConversation.tsx` statically imports `@anam-ai/js-sdk` (`createClient, AnamEvent`).
  It is imported by `AvatarPopup.tsx`, which is statically imported (no `next/dynamic`, confirmed
  by grep — zero `dynamic(` calls anywhere under `components/avatar/**` or `components/viewer/**`)
  into four PUBLIC viewer entry points: `components/viewer/ViewerPage.tsx`,
  `components/viewer/SharedViewerPage.tsx`, `components/viewer/playlist/PlaylistViewer.tsx`, and
  `components/viewer/LessonPlayer.tsx`. `AvatarConversation.tsx` also imports `VisualPanel.tsx`,
  which statically imports `EquationRenderer.tsx` (`import katex from 'katex'` +
  `katex/dist/katex.min.css`) and `ChartRenderer.tsx` (`import { Chart as ChartJS, ... } from
  'chart.js'`, registering 12 chart.js modules at import time).
- why: **Cost model: initial JS payload for the viewer scales with "features the app has," not
  "features this video uses."** The viewer pages are the highest-traffic, most latency-sensitive
  surface in the app (every anonymous visitor watching any video hits one of these four
  components), and every one of them now pays the download/parse/execute cost of a WebRTC-style
  avatar SDK plus a full math-typesetting library plus a full charting library, even for the
  (presumably common) case of a video with no avatar feature enabled. None of these three
  dependencies are used anywhere outside the avatar subtree.
- evidence: Grepped `dynamic(` under `components/avatar` and `components/viewer` — no hits.
  Traced the static import chain by reading each file's top-of-file imports:
  `ViewerPage.tsx:11`/`SharedViewerPage.tsx:11`/`PlaylistViewer.tsx:14`/`LessonPlayer.tsx:15` →
  `import { AvatarPopup } from '../avatar/AvatarPopup'` → `AvatarPopup.tsx:6`
  `import { AvatarConversation } from './AvatarConversation'` → `AvatarConversation.tsx:5`
  `import { createClient, AnamEvent } from '@anam-ai/js-sdk'` and `AvatarConversation.tsx:11`
  `import { VisualPanel } from './VisualPanel'` → `VisualPanel.tsx:5-6` imports both
  `EquationRenderer` and `ChartRenderer`. I did not run a production build to measure the resulting
  chunk size (not available in this review — no installs/builds allowed), hence `confidence:
  medium` per the review's own guidance on unmeasured bundle claims; the import chain itself is
  fully confirmed by direct reads.
- fix: Wrap `AvatarPopup` (or at minimum `AvatarConversation`) in `next/dynamic(() =>
  import('../avatar/AvatarPopup'), { ssr: false })` at each of the four viewer call sites, so the
  avatar/katex/chart.js/anam-sdk chunk is only fetched when a viewer actually opens the avatar
  popup, not on every video page load.
- effort: S
- cross: @frontend (React/Next correctness of the four viewer components is their column; this is
  the bundle-cost angle only)

### [P3] Global multipart file-size default is 10 GB, applied silently to every route without an explicit override
- id: performance-010
- location: podcast-saas/backend-api/src/server.ts:198
- category: perf
- confidence: high
- status: confirmed
- what: `await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 * 1024 } })` sets a
  10 GB ceiling that every `request.file()` call in the app inherits unless the route explicitly
  overrides it. Two routes do override it (`avatar.controller.ts` at 250 MB,
  `simulations.controller.ts` at 250 MB); the audio/corpus/podcast-source upload routes
  (performance-001/002/003) do not, and silently accept anything up to 10 GB.
- why: This is the shared root cause behind performance-001/002/003 — the default is permissive
  enough that "forgetting" a per-route cap is invisible until a large upload actually arrives. The
  fix for each individual route also fixes the specific instance, but the default itself is the
  kind of thing that will recreate this bug class on the next upload route someone adds.
- evidence: Read `server.ts:198-200`, comment: `// 10 GB (overridden per-route where needed)` — an
  explicit acknowledgment that override is opt-in, not opt-out.
- fix: Lower the global default to something a legitimate route would never exceed by accident
  (e.g. 1 GB), and require the genuinely-large routes (raw video upload, which already streams) to
  opt into a higher explicit limit, inverting the current opt-in-to-safety default.
- effort: S
- cross: (none — root-cause note for performance-001/002/003)

---

## Scope covered, clean

Swept and read in full but found no new performance defect (noted so this isn't re-litigated):

- **`services/video/runVideoTranscode.ts`** — streams the source download via
  `pipeline(response.body, createWriteStream(...))` rather than buffering; every ffmpeg call goes
  through `runFfmpegLimited` (via `HLSTranscoder.ts`); HLS tiers are versioned trees with a proper
  retire-then-sweep GC. A model of the pattern the buffer-based upload routes above should follow.
- **`services/crop/ffmpegExtract.ts`** — its own docstring documents a prior fix (perf-001/perf-009:
  removed a whole-file-buffering frame extractor in favor of `streamRgbFrames`, which holds at most
  one decoded frame). All three of its exported functions are called from `cropProcessor.ts` already
  wrapped in `runFfmpegLimited` — not a bypass.
- **`services/storage/s3Copy.ts` / `services/project/ProjectDuplicationService.ts`** — project
  duplication's storage copy is deliberately sequential (documented rationale: predictable beats
  fast for a background job) and deliberately never buffers bytes through the Node process for
  large objects (ranged multipart server-side copy). Good design, not a finding.
- **`controllers/v1/projects.controller.ts` `GET /api/v1/projects`** — the fire-and-forget thumbnail
  backfill (`backfillMissingThumbnails`) is bounded (`.slice(0, 8)`) and uses one batched `inArray`
  query, not one query per project.
- **`controllers/admin/v1/pipeline-stats.controller.ts` and `.../users.controller.ts` `/usage`** —
  both aggregate correctly in SQL (the pattern `billing.controller.ts` should have followed).
- **`lib/rateLimit.ts` and `services/simulation/revisionIdentity.ts`** — both in-process caches are
  correctly bounded (a 60s sweep and a 5,000-entry oldest-first eviction, respectively).
- **`lib/sse.ts` and `controllers/v1/sections.controller.ts`'s SSE generation stream** — keep-alive
  intervals and the `activeSimGenerations` lock Set are both cleared in a `finally` plus a
  `request.raw.on('close')` handler; no leak.
- **`services/crop/cropProcessor.ts`, `services/captions/CaptionService.ts`,
  `services/generateVideoMetadata.ts`, `services/podcast/audio/ffmpegAudio.ts`,
  `services/export/LinearAssembler.ts`** — every ffmpeg/ffprobe spawn in these files is wrapped in
  `runFfmpegLimited`.

## Architecture notes

1. **The buffer-vs-stream split in the upload surface is inconsistent, not absent.** The codebase
   clearly *knows* the streaming pattern (`uploadStreamWithFallback`, used correctly by raw video
   upload) and the size-cap pattern (`avatar.controller.ts`, `simulations.controller.ts`). Six other
   upload routes (audio, corpus, podcast sources, images, playlists, avatar-visual single-file) use
   `request.file()` → `toBuffer()` → buffer-based `uploadFile()` instead. Worth a single pass across
   every multipart route to standardize on stream-through-to-storage as the default and buffer-based
   as the documented exception (small, known-bounded content like images), rather than the current
   ad hoc split.
2. **The ffmpeg concurrency cap has one confirmed bypass in the exact subsystem stack.md calls out as
   sensitive.** `services/ffmpegLimit.ts` is a good, simple, well-documented primitive, and every
   *other* spawn site in the repo correctly wraps itself in it — which makes
   `containerCaptureProvider.ts`'s bare `spawn('ffmpeg', ...)` (performance-004) look like an
   oversight in an otherwise-disciplined pattern rather than a design gap. Worth a repo-wide grep
   for `spawn('ffmpeg'` / `spawn('ffprobe'` with a lint rule or code-review checklist item, since
   this exact class of bug (a new call site added without the wrapper) will recur as capture grows.
3. **In-process caches in this codebase are bimodal: either carefully bounded (rate limiter,
   revision-identity cache) or unbounded (Anam token cache).** There's no shared "bounded cache"
   utility, so each author re-derives the eviction strategy from scratch and sometimes skips it.
   A small shared `BoundedMap<K, V>(maxEntries, ttlMs)` helper next to `ffmpegLimit.ts` would let
   the next cache default to bounded instead of opting into it.
4. **The viewer bundle has no code-splitting boundary between "core playback" and "avatar
   feature."** The avatar popup, and everything it pulls in (Anam SDK, katex, chart.js), is wired
   into the same static import graph as the base video player across all four viewer surfaces. As
   more optional viewer features get added (the pattern this feature establishes), each one will
   compound the base bundle cost unless a `next/dynamic` boundary is established now, while there's
   only one offender to fix.
