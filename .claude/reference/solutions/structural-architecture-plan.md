# FlowVid — Deep Architectural Improvement Plan (5 structural problems)

> **mode: unverified — fiji source not present; grounded in `.claude/reference/fiji.md`, not confirmed
> against the code.**
> Probed `./fiji`, `../fiji`, `~/cebu/fiji`, `~/fiji` — none exist. Every fiji claim below is marked
> `(from KB, unverified)`. No fiji file paths or line numbers are invented; the KB contains none for
> most of what follows, so most of this plan is derived from FlowVid's own source, which I did read.
> To upgrade to `mode: verified`: `git clone https://gitlab.com/lliansky-group/fiji.git ~/cebu/fiji`.
>
> **Every FlowVid claim below is cited `file:line` and was read.** Paths are relative to repo root
> `/Users/ofeklevy/cebu`.
>
> Author: `fiji-advisor`. Date: 2026-08-16. Scope: structural only — no defect list (16 other agents
> own that). Read-only: this document proposes, it does not apply.

---

## 0. Two corrections to the brief, up front

Both matter because they change what the right fix is.

**(a) There is no 600-second synchronous cap.** The export API is *already* async-with-polling:
`podcast-saas/backend-api/src/controllers/v1/export.controller.ts:63` registers
`POST /api/v1/projects/:id/export`, whose header comment states "ASYNC, and POST returns the EXPORT
id, not a file", and the client polls `GET .../exports/:exportId`
(`podcast-saas/shared/src/generated/client-v1.ts:891,898`). The "600s" is
`wallClockCapSec()` at
`podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:252-254`:

```ts
export function wallClockCapSec(durationSec: number): number {
  return Math.min(600, Math.ceil(90 + durationSec * 6));
}
```

That is a **per-section container kill timer**, not a request deadline. It only reaches 600 when
`durationSec >= 85`. Therefore **"change the product contract to async delivery" is already done and
buys nothing** — I rank it last and recommend no work there.

**(b) "Deterministic offscreen rendering instead of real-time playback" is also already done.**
`beginFrameBackend.ts` drives `HeadlessExperimental.beginFrame` against a virtual clock with
`--deterministic-mode` (`capture/beginFrameBackend.ts:63-70,127-138,400-412`), and `driver.ts:226-237`
steps exactly `round(dur × fps)` frames. The untracked `capture/localCaptureProvider.ts` is the
*opposite* — a real-time CDP screencast path — and it is explicitly dev-only, gated behind
`EXPORT_CAPTURE_LOCAL=1` (`localCaptureProvider.ts:326-330`) and documented as such in
`LOCAL-CAPTURE-README.md:62-69`. **It is not the production path and must not be treated as the
throughput problem.** Production is the Linux container beginFrame path.

So the levers that are actually left are: **pixels, readback count, cache, placement**. That is what
Problem 1 below is about.

**(c) A stale-KB correction.** `.claude/reference/fiji.md:96-104` describes FlowVid as having raw
`path.join` traversal (P0-2) and a hand-rolled `startsWith('hls/')` public check. **That is no longer
true.** `server.ts:267` rejects traversal *before* the public-prefix branch, `server.ts:272-277`
routes `videos/`, `hls/`, `exports/` through `authorizeMediaRequest`, and `safeLocalPath` is applied
at `server.ts:284,305,375`. The KB entry should be corrected by `fleet-maintainer`. Problem 3 below
is therefore a much smaller job than the KB implies.

---

# Problem 1 — Headless capture throughput (the live blocker)

## (a) Current state, with evidence

**The cost model, derived entirely from source:**

| Quantity | Value | Evidence |
|---|---|---|
| Capture grid | **1920×1080 @ 30 fps** | `services/export/types.ts:33` — `EXPORT_GRID = { w: 1920, h: 1080, fps: 30 }`, passed as the capture grid at `ProjectExportService.ts:365-366` |
| Frames per section | `round(dur × 30)` | `capture/captureTypes.ts:29-31` `frameCountFor` |
| Warmup frames (discarded) | **30** | `capture/captureTypes.ts:27` `DEFAULT_WARMUP_FRAMES` |
| Per-section wall clock | `min(600, 90 + 6·dur)` s | `capture/isolation/containerCaptureProvider.ts:253` |
| Sections | **strictly sequential** | `ProjectExportService.ts:338` `for (const w of plan.timeline)` … `:362` `await backend.captureSection(...)` |
| GL backend | **SwiftShader (software)** | `capture/beginFrameBackend.ts:91` `GL_SWITCHES = ['--use-angle=swiftshader', …]`; `'--disable-gpu'` is forbidden at `:101-110` |
| Container CPU quota | **`--cpus 2`** default | `containerCaptureProvider.ts:226` `cpus: env.EXPORT_CAPTURE_CPUS?.trim() || '2'` |

**The arithmetic.** A 15-second section is 450 kept frames + 30 warmup. Its budget is
`90 + 6×15 = 180 s`. Net of the ~90 s handshake/warmup slack the formula reserves, the capture loop
gets **~90 s for 450 frames = 0.2 s/frame**. "Roughly 10× too slow" therefore means the host is
achieving **≈ 2 s/frame**, i.e. ~900 s of work against a 180 s kill timer. Every such section is
SIGKILLed at `captureJobBoundary.ts:488` (`setTimeout(hardKill, wallClockTimeoutSec * 1000)`) and
degrades to a poster still (`ProjectExportService.ts:369-384`).

**Where the 2 s/frame goes.** Per *kept* frame the pipeline does, at 1920×1080 = 2.07 Mpx:

1. `Runtime.evaluate` round-trip to advance the virtual clock — `beginFrameBackend.ts:471-479`
2. **SwiftShader software rasterization** of the WebGL scene — the dominant term, linear in pixels
3. `HeadlessExperimental.beginFrame` with `screenshot` — `beginFrameBackend.ts:400-412`
4. **JPEG encode** of 2.07 Mpx (q80, `optimizeForSpeed`) — `beginFrameBackend.ts:177-179`
5. **base64 of ~200–400 KB over the CDP pipe** + `JSON.parse` — `cdpPipeTransport.ts`
6. `writeFile` of the decoded buffer — `beginFrameBackend.ts:487`

Items 2–5 are all **linear in pixel count**. Item 1 is per-frame regardless. The in-code measurement
note at `beginFrameBackend.ts:177-178` ("24 ms/frame vs 267 ms for default PNG — the single biggest
lever") is a *readback-only* number and does not include SwiftShader rasterization of a real WebGL
sim at 1080p on a contended 2-vCPU box.

**And there is a feedback loop.** `EXPORT_CAPTURE_CPUS` defaults to `2` on a **2-vCPU host**, so the
capture container is granted the entire machine while the worker, the backend, two Next.js servers
and nginx keep running (`podcast-saas/deploy/docker-compose.yml`). The box is over-committed ~3×
during capture, which inflates the measured s/frame further. The capture compose overlay even warns
"Chrome ≈1–2 GB per section run … Do not enable this on a sub-4 GB host — the 908 MB instance
OOM-killed plain assembly" (`deploy/docker-compose.capture.yml`, CAPACITY note).

**And nothing is cached.** The captured clip is written to
`exports/{projectId}/{exportId}/sections/{sectionId}.mp4` (`ProjectExportService.ts:390`) — **keyed by
`exportId`**. Re-exporting an unchanged project re-captures every section from scratch. Meanwhile the
immutable identity that would make caching correct **already exists and is already computed**:
`exportPlan.ts:264-285` computes `configHash` and resolves a poster by it, and
`podcast-saas/shared/src/sim/posterIdentity.ts:14-21` defines the five-axis key
(`packageRevision + variantKey + configHash + aspectProfile + qualityProfile`) with the note that
"`configHash` already folds in Minimal-UI, hidden controls, auto-script, transparency and initial
state". `configHash` is plumbed all the way into the capture spec (`ProjectExportService.ts:366`) —
and then used **only as a PRNG seed** (`capture/injection.ts:53,297`). The cache key is sitting
right there, unused.

## (b) Fiji's approach

*(from KB, unverified)* `fijicapture` is a **separate service** (ports 3091/8092) with a pre-warmed
**Playwright BrowserPool**, health checks, idle recycling, and a **single poll-loop `JobDispatcher`
with fairness** (`.claude/reference/fiji.md:46,138-140`). Two structural properties matter:
capture does not live on the API host, and the pool — not each caller — is the sole limiter. Fiji
also caches derived artifacts behind presigned URLs (`fiji.md:141`, "presigned/cached artifacts").
I have no fiji `file:line` for any of this and cannot confirm the pool sizing, the dispatcher's
fairness policy, or whether fijicapture does anything analogous to content-addressed clip caching.

## (c) Gap analysis

FlowVid's isolation architecture is **already better than the fiji pattern in one dimension**
(`--network none`, cap-drop ALL, read-only rootfs, per-section ephemeral container —
`containerRunArgs.ts:132-176`) and **worse in another**: a cold container per section instead of a
warm pool, and no off-host placement. A warm pool is *incompatible* with the ephemeral-container
security model as written, so a 1:1 port of fiji's BrowserPool would require giving up the isolation
boundary. **Do not do that.** The container start cost is not the bottleneck anyway — 450 frames ×
2 s dwarfs one `docker run`.

## (d) The ported solution — ranked levers

### Rank 1 — Decouple capture resolution from export resolution. *(biggest win, smallest diff)*

Capture at **960×540**, upscale to 1920×1080 during the frames→clip encode. Pixel count drops
**4×**, and items 2–5 above all fall roughly 4×.

**The plumbing already exists.** `containerCaptureProvider.ts:372-378` calls
`encodeFramesToClip(framesDir, pattern, fps, { width: spec.width, height: spec.height }, clipPath)`
and that function's filter chain is already `-vf scale=${dims.width}:${dims.height}:out_range=tv,…`
(`:150`). Today `spec.width/height` are used for *both* the browser viewport and the scale target, so
the scale is a no-op. Split them.

Files to change:
- `services/export/types.ts` — add `EXPORT_CAPTURE_GRID` beside `EXPORT_GRID:33`, defaulting to
  `{ w: 960, h: 540 }`, overridable by `EXPORT_CAPTURE_WIDTH` / `EXPORT_CAPTURE_HEIGHT`.
- `services/export/capture/captureTypes.ts` — add `outWidth`/`outHeight` to `CaptureSpec` beside the
  existing `width`/`height` (`:56` onward).
- `ProjectExportService.ts:365-366` — pass the capture grid as `width/height`, the export grid as
  `outWidth/outHeight`.
- `containerCaptureProvider.ts:376` — pass `{ width: spec.outWidth, height: spec.outHeight }` as
  `dims` so ffmpeg upscales. `buildCaptureSpec` at `:312-320` keeps sending the *capture* dims to the
  container.

**Expected:** ~3–4× on the pixel-bound terms. 2 s/frame → ~0.6 s/frame.

### Rank 2 — Decouple the *clock rate* from the *readback rate*.

The naive move is "capture at 15 fps". **Do not do that**: `driver.ts:226-237` advances the virtual
clock by exactly one `1/fps` step per frame, so halving `fps` doubles the simulation's `dt`. A
physics integrator run at `dt=1/15` produces *different content*, not the same content sampled
sparsely. That is a silent correctness regression dressed as a perf win.

Instead: **keep stepping the clock at 30 Hz, screenshot every Nth frame.** `driver.ts` already
separates `stepFrame` from `captureFrame` (`DriverDeps:49,51`), so this is a small, honest change:

- `driver.ts` — add `captureEveryNth?: number` to `DriverOptions` (`:59-81`); in the kept-frame loop
  (`:233-237`) always `stepFrame`, call `captureFrame` only when `c % N === 0`.
- `driver.ts` `DriverResult.frameCount` becomes the number of *readbacks*, and the ffmpeg
  `-framerate` in `encodeFramesToClip` becomes `fps / N`, with `-r 30` on the output still producing a
  30 fps clip by frame duplication (`containerCaptureProvider.ts:145,152`).
- `beginFrameBackend.ts:471-482` — the `pendingStepFlush` bookkeeping already handles "a step whose
  compositor frame is flushed without a screenshot", so an uncaptured step costs one
  `noDisplayUpdates: true` beginFrame. That is the cheap path by construction.

**Expected at N=2:** removes ~half the JPEG-encode + base64 + pipe + writeFile cost while the
simulation renders identically. Combined with Rank 1: **~6–8× total**, which converts the measured
2 s/frame into ~0.25–0.35 s/frame and lands the 15-second section inside its 180 s budget.

Risk: a fast-motion sim will look 15 fps. That is a *visual* trade the product can see and reverse
with one env var; it is not a correctness trade. Expose `EXPORT_CAPTURE_EVERY_NTH` (default 1 at
first, flip to 2 after measuring).

### Rank 3 — Content-addressed clip cache keyed on the immutable sim revision.

Zero visual cost, and it makes the *second* export of a project nearly free. Users iterate on audio
and text far more often than on the simulation, so the steady-state hit rate should be high.

- New `services/export/capture/clipCacheKey.ts`, mirroring
  `shared/src/sim/posterIdentity.ts:99-107`'s key algebra:
  `sim-clips/{packageRevision}/{configHash}/{sectionId}/{w}x{h}@{fps}n{N}/{durationMs}.mp4`.
  Every axis that changes the pixels must be in the key — including `captureEveryNth` and a
  `CAPTURE_BACKEND_VERSION` constant bumped whenever `injection.ts` / `beginFrameBackend.ts` flag
  policy changes, or a stale clip will outlive the code that made it.
- `ProjectExportService.ts:361` — before `backend.captureSection`, `storage.objectExists(cacheKey)`
  (the method exists: `services/storage/StorageService.ts:90`). On hit, use the cached key as the
  clip's `storageKey` directly and skip capture entirely.
- On miss, upload to the **cache key** (immutable, `IMMUTABLE_CACHE_CONTROL` — already in use at
  `ProjectExportService.ts:391`) and reference it from the plan. The per-export key at `:390` becomes
  unnecessary; if you want to keep export-scoped provenance, `storage.copyObject` (`StorageService.ts:57`)
  is server-side and cheap.
- Guard: only cache when `configHash` is non-empty and the revision is a *verified* immutable one —
  `services/simulation/revisionIdentity.ts` already exports `isVerifiedRevisionKey`
  (used at `controllers/sim-public.controller.ts:13`). A legacy/mutable package must bypass the cache
  or it will serve stale pixels forever.

**Expected:** first export unchanged; every subsequent export of an unchanged sim section costs one
HEAD request instead of 180 s.

### Rank 4 — Move capture off the API/worker host to a dedicated render service.

This is the right *long-term* answer and the closest analogue to fiji's `fijicapture`
*(from KB, unverified)*. It is already designed for: `CaptureJobBoundary` is an **interface**
(`capture/isolation/captureJobBoundary.ts:125,167`) and `DockerCaptureBoundary` is one implementation.
A `RemoteCaptureBoundary` that POSTs the same `capture-spec.json` + staged package to a render host
and polls for `result.json` is a drop-in at
`containerCaptureProvider.ts:264` (the boundary is already a constructor parameter with a default).

But it costs a second machine. **Do it after 1–3, not before** — 1–3 may make it unnecessary, and if
they do not, you will at least be sizing the render host against a measured 0.3 s/frame instead of a
mystery 2 s/frame.

### Rank 5 — Parallel segment capture. **Recommend against, for now.**

On 2 vCPU with software rasterization, capture is CPU-saturated. Two concurrent containers roughly
double per-section latency (no throughput gain) and double peak memory, on a host whose own compose
file records an OOM kill during *plain assembly* (`deploy/docker-compose.capture.yml`, CAPACITY).
It only becomes correct after Rank 4 puts capture on a host with spare cores. Rank it last among the
technical levers.

### Rank 6 — Change the product contract to async delivery. **Already done; no work.**

See §0(a).

### One more thing worth fixing while you are in there

`wallClockCapSec` (`containerCaptureProvider.ts:253`) hard-codes `6× real-time + 90 s`. That constant
is a guess about a machine, embedded in a pure function. After Ranks 1–2 it will be far too generous;
before them it is far too tight. Derive it instead:
`90 + frames × MS_PER_FRAME_BUDGET`, with `MS_PER_FRAME_BUDGET` an env-tunable measured number, and
**log the achieved s/frame on every capture** so the budget is set from data. Note also that
`VISUAL_MAX_SEC = 15` appears **only as a doc comment** (`captureTypes.ts:56`) and is not enforced
anywhere I could find — section length comes from `end_sec - start_sec` (`exportPlan.ts:302-303`) and
is unbounded, so the 600 s branch *is* reachable.

## (e) Phased migration

| Phase | Content | Independently shippable? | Reversible? |
|---|---|---|---|
| **1a** | Instrument only: log `msPerFrame`, `frames`, `wallClockSec`, `width×height`, `renderer` per section. No behaviour change. | Yes | Trivially |
| **1b** | Rank 1 (capture-resolution split), default `960×540`, env-overridable | Yes | `EXPORT_CAPTURE_WIDTH=1920` |
| **1c** | Rank 2 (`captureEveryNth`), **default 1** — ship the mechanism dark, flip to 2 after 1a data | Yes | `EXPORT_CAPTURE_EVERY_NTH=1` |
| **1d** | Rank 3 (clip cache), gated on `EXPORT_CLIP_CACHE=1` | Yes | env flag |
| **1e** | Rank 4 (`RemoteCaptureBoundary`) — only if 1b–1d miss target | Yes | keep `DockerCaptureBoundary` as the default |

**Phase 1a must ship first.** Right now nobody knows the real s/frame; "10× too slow" is an
inference from timeouts. Every phase after 1a is sized by 1a's output.

## (f) Risks

- **1b:** upscaled 960×540 is visibly softer at 1080p, especially for sims with fine text. Mitigate
  by testing on the worst offender first, and by choosing `1280×720` (2.25× win) if 540p is too soft.
- **1c:** the `pendingStepFlush` interaction in `beginFrameBackend.ts:471-482` is subtle — an
  off-by-one turns into "the compositor is one frame behind the clock", which looks like judder, not
  like a crash. This needs a unit test on `driver.ts` asserting the exact `stepFrame`/`captureFrame`
  call sequence for `N=2` (the existing `capture/__tests__/driver.test.ts` already fakes both).
- **1d:** the real hazard is a **stale cache hit** — a cache key that omits an axis that changes the
  pixels. Bias hard toward over-keying; a redundant axis costs a cache miss, an absent one costs a
  wrong video. The `CAPTURE_BACKEND_VERSION` term is not optional.
- **1e:** a remote boundary reintroduces network egress into a subsystem whose entire security
  argument is `--network none` (`containerRunArgs.ts:141`). The isolation must move *with* the
  capture, to the render host — do not weaken the local boundary to make the remote one convenient.

## (g) How to measure it worked

- **The number:** median and p95 `msPerFrame` per section, from Phase 1a's log line, before and after.
  Target: **≤ 200 ms/frame at 1920×1080-equivalent output.**
- **The outcome:** the count of `plan.warnings` entries containing "capture" per export
  (`ProjectExportService.ts:353-357,378-382,407-409`) drops to zero on the demo project. That warning
  list is already the honest degradation record — use it as the acceptance metric, not a stopwatch.
- **The regression test:** `capture/__tests__/driver.test.ts` gains a case pinning the
  step/capture sequence for `captureEveryNth = 2`; a `clipCacheKey` unit test pins that changing each
  axis changes the key and changing nothing does not.
- **Manual:** one export of the seeded demo project (`LOCAL-CAPTURE-README.md:46`) end to end with
  `EXPORT_CAPTURE_IMAGE` set on a Linux host, eyeballing the master.

---

# Problem 2 — Job concurrency and host saturation

## (a) Current state

**Three independent, uncoordinated CPU budgets on one 2-vCPU box:**

1. **pg-boss worker concurrency.** `queue/pgBossDriver.ts:54` —
   `await boss.work(name, { localConcurrency: cropConcurrency() }, …)`. Note the function name:
   `cropConcurrency()` at `:17-19` reads **`QUEUE_CROP_CONCURRENCY` (default 2)** and is applied to
   **every** queue — `crop`, `video_generate`, **and `project_export`**
   (`queue/pgBoss.ts:22`). So the host will run **two concurrent exports**, each of which may spawn a
   capture container.
2. **ffmpeg semaphore.** `services/ffmpegLimit.ts:8` — `FFMPEG_CONCURRENCY`, default **2**. Its header
   comment cites the fiji BrowserPool-as-sole-limiter pattern explicitly (`ffmpegLimit.ts:6`).
3. **Capture containers.** `--cpus 2` by default (`containerCaptureProvider.ts:226`), 2048 MB
   (`:224`). **Nothing** bounds how many run at once; `captureJobBoundary.ts:436` spawns docker with
   no admission gate.

Worst case on a 2-vCPU host: 2 exports × (1 capture container @ 2 CPUs + ffmpeg) + 2 other ffmpegs
= **~6 CPUs demanded, 2 available, ~4+ GB of Chrome**. The compose file already records an OOM kill
at 908 MB during *assembly alone*.

**A concrete coverage hole in the limiter.** Of the production ffmpeg spawn sites, exactly one
bypasses `runFfmpegLimited`: `containerCaptureProvider.ts:156` (`encodeFramesToClip` →
`spawn('ffmpeg', …)`). Verified by comparing spawn sites to importers:

| Spawns ffmpeg/ffprobe | Under `runFfmpegLimited`? |
|---|---|
| `services/video/HLSTranscoder.ts` | yes |
| `services/captions/CaptionService.ts` | yes |
| `services/crop/ffmpegExtract.ts` | yes — wrapped by callers at `crop/cropProcessor.ts:84,90,111` |
| `services/generateVideoMetadata.ts` | yes |
| `services/podcast/audio/ffmpegAudio.ts` | yes |
| `services/export/LinearAssembler.ts` | yes |
| **`services/export/capture/isolation/containerCaptureProvider.ts:156`** | **no** |
| `services/export/capture/localCaptureProvider.ts:108` | no (dev-only, `EXPORT_CAPTURE_LOCAL=1`) |

**Nothing sheds load.** There is no queue-depth check, no per-org concurrency limit, and no
admission control. Overload is expressed as OOM kills and SIGKILLed capture containers, not as a
polite "queued, position 3".

**Also:** `queue/pgBoss.ts:35` sets `project_export: expireInSeconds: 60 * 60`, with the comment
"covers per-section capture wall clocks (≤10 min each) plus the assembly". Six sim sections at the
600 s branch plus assembly exceeds that, and pg-boss will re-deliver a job that is still running.
The `claim()`/heartbeat logic (`ProjectExportService.ts:61-66,177`) makes that survivable, but it is
a race the arithmetic should not permit in the first place.

## (b) Fiji's approach

*(from KB, unverified)* `fijicapture` uses a **pre-warmed BrowserPool as the sole limiter** plus a
**single poll-loop `JobDispatcher` with fairness** (`fiji.md:138-140`). The structural idea worth
porting is the phrase "sole limiter": *one* object owns the machine's scarce resource, and every
consumer acquires from it. FlowVid has three owners that cannot see each other. I have no fiji
`file:line` and cannot confirm pool sizes or the fairness policy.

## (c) Gap analysis

FlowVid's `ffmpegLimit.ts` is already the right shape — a global semaphore with FIFO handoff
(`:21-28` hands the slot directly to the next waiter, which is correct and non-obvious). The gap is
**scope**, not design: it counts ffmpeg processes, and the expensive things on this host are now
*Chrome containers* and *whole exports*. It needs to become a **weighted CPU-slot semaphore** that
every heavy consumer acquires from, ffmpeg and docker alike.

## (d) The ported solution

**The safe envelope on 2 vCPU.** Reserve ~0.5 vCPU for the API + nginx + Next. That leaves ~1.5 for
background work. Concretely:

| Knob | Today | Target | Where |
|---|---|---|---|
| `project_export` worker concurrency | 2 | **1** | `pgBossDriver.ts:54` |
| `video_generate` worker concurrency | 2 | **1** | same |
| `crop` worker concurrency | 2 | 2 (short, cheap) | same |
| `FFMPEG_CONCURRENCY` | 2 | **1** while a capture container is live, else 2 | `ffmpegLimit.ts:8` |
| `EXPORT_CAPTURE_CPUS` | `2` | **`1.5`** | `containerCaptureProvider.ts:226` |
| Concurrent capture containers | unbounded | **1** | new |

**Files to add/modify:**

1. **`queue/pgBossDriver.ts:17-19,54`** — replace `cropConcurrency()` with a per-queue map. Keep
   `QUEUE_CROP_CONCURRENCY` reading as the `crop` default (backward compatible), add
   `QUEUE_EXPORT_CONCURRENCY` (default **1**) and `QUEUE_VIDEO_GENERATE_CONCURRENCY` (default 1).
   This is a ~10-line change and is by itself the single highest-value fix in Problem 2.

2. **New `services/hostCapacity.ts`** — generalise `ffmpegLimit.ts` into a weighted semaphore:
   `acquireSlots(n)` / `release(n)` over a budget of `HOST_CPU_SLOTS` (default
   `max(1, cpus() - 1)`). Keep `runFfmpegLimited` as a thin wrapper (`weight 1`) so **no call site
   changes**. Add `runCaptureLimited` (`weight 2`) used by `captureJobBoundary.ts:436` before
   `spawnDocker`. That is what makes ffmpeg and Chrome finally see each other.

3. **`containerCaptureProvider.ts:372-378`** — wrap `encodeFramesToClip` in `runFfmpegLimited`,
   closing the one production coverage hole.

4. **Admission control at the producer**, not the consumer. In
   `controllers/v1/export.controller.ts` (the `POST` handler at `:63`), before enqueuing: count
   non-terminal `project_exports` rows for the org. Over a threshold → **`429` with a `Retry-After`
   and a queue position**, not an enqueue. This is the "shed load instead of collapsing" mechanism,
   and it is a *product-visible, honest* answer. The alternative — enqueue everything and let pg-boss
   absorb it — is fine for durability but gives the user no signal and lets one org monopolise the
   box.

5. **Fairness.** `pgBossSend` at `pgBossDriver.ts:30` already uses `singletonKey`, but
   `singletonKeyFor` (`:41-44`) returns `undefined` for everything except `crop`. Give
   `project_export` a singleton key of `exportId` — free dedup. Cross-org fairness (fiji's
   `JobDispatcher` idea, *from KB, unverified*) is a later phase: with `localConcurrency: 1` and a
   per-org admission cap, strict FIFO is acceptable.

6. **`queue/pgBoss.ts:35`** — raise `project_export.expireInSeconds` to cover
   `maxSections × wallClockCapSec + assembly`, or (better, after Problem 1) recompute it from the new
   per-frame budget. Do not leave the comment and the arithmetic disagreeing.

## (e) Phases

| Phase | Content | Shippable alone? | Reversible? |
|---|---|---|---|
| **2a** | Per-queue concurrency map; `project_export` → 1; `EXPORT_CAPTURE_CPUS=1.5`; `expireInSeconds` fix | Yes | env vars |
| **2b** | `hostCapacity.ts` weighted semaphore; `runFfmpegLimited` becomes a wrapper; capture acquires 2 slots | Yes | `HOST_CPU_SLOTS` large ⇒ old behaviour |
| **2c** | Wrap `encodeFramesToClip` in the limiter | Yes | trivial |
| **2d** | Per-org admission control + `429` + queue position in the export POST | Yes | threshold env, `Infinity` disables |

2a alone removes the worst case (two simultaneous exports) and is a same-day change.

## (f) Risks

- **2a:** halving export concurrency halves export throughput. On a saturated 2-vCPU host that is a
  *gain* in wall-clock terms, but it will look like a regression on a graph that counts jobs started.
  Measure completions, not starts.
- **2b:** a weighted semaphore can deadlock if one holder waits on another holder. `ffmpegLimit.ts`
  today cannot deadlock because every acquisition is weight-1 and leaf. `encodeFramesToClip` running
  *inside* a capture that already holds 2 slots would deadlock at `HOST_CPU_SLOTS = 2`. Fix by
  releasing the capture slots before the encode (the container has already exited at that point —
  `containerCaptureProvider.ts:348-378`), and add a test that pins it.
- **2d:** a 429 on export is user-visible. It needs a real UI string, not a raw error. Coordinate
  with `client-web/lib/useProjectExport.ts`.

## (g) Measurement

- Host: `docker stats` 1-minute load average and per-container CPU during a 3-section export; target
  **load < 2.5** with no container over its quota.
- Zero OOM kills: `dmesg | grep -i oom` and container exit code 137 count over a week.
- Zero `wallClockTimeoutSec` SIGKILLs at `captureJobBoundary.ts:488` under a two-export burst.
- Test: a unit test on `hostCapacity.ts` asserting the total weight never exceeds the budget and that
  FIFO handoff is preserved (the existing `ffmpegLimit` handoff at `:21-28` must not regress).

---

# Problem 3 — Storage and public links

## (a) Current state — better than the KB says

**The single adapter contract already exists.** `services/storage/StorageService.ts` is a 112-line
interface with `uploadFile`/`uploadStream`, `getPresignedDownloadUrl:18`,
`getPresignedUploadUrl:19`, full **S3 multipart** (`:26-37`), `copyObject:57`, `copyPrefix:69`,
`getPublicUrl:71`, `getSimPublicUrl:73`, `keyFromPublicUrl:84`, `readObject:86`, `listObjects:88`,
`objectExists:90`, `headObject:102`. Three adapters implement it: `R2StorageAdapter.ts`,
`SupabaseStorageAdapter.ts`, `LocalStorageAdapter.ts`.

**Production already refuses local disk.** `getStorageAdapter.ts:71-84` is a fail-closed guard: in
`NODE_ENV=production`, `STORAGE_BACKEND=local` **throws**, a prior `forceLocalStorage()` **throws**
(`:34-38`), and missing cloud credentials **throws** with a named remedy. `deploy/docker-compose.yml`
pins `STORAGE_BACKEND: supabase` on both `backend` and `worker`.

**Public links are already a checked property, not a path prefix** for the media that matters.
`server.ts:272-277` routes `videos/`, `hls/`, `exports/` through `authorizeMediaRequest`, which
resolves owner/token via `services/storage/mediaAccess.ts` + `mediaToken.ts`. `server.ts:267` rejects
`..` **before** the public-prefix branch — the comment there names the exact attack
(`podcasts/..%2fexports/…`) that ordering closes. `safeLocalPath` is applied at `:284,305,375`.

So: **`.claude/reference/fiji.md:96-104` is stale on this point and should be corrected.** The
remaining gaps are narrower and I would not call any of them structural-critical:

1. **`PUBLIC_LOCAL_PREFIXES` is still a prefix list** (`server.ts:253`) — 8 prefixes, including
   `podcasts/`, served with no auth. This is dev-only (the routes only matter under
   `LocalStorageAdapter`), but it is the one surviving instance of "public means the key starts with
   a magic string" rather than fiji's "public is a column" *(from KB, unverified —
   `fiji.md:90-92` describes `artifact.isPublic` checked at serve time)*.
2. **`/hls-proxy/*` streams bytes through Node** (`server.ts:337-357`). It does stream rather than
   buffer (`:348-357`, and the comment records that it used to `arrayBuffer()`), but every HLS
   segment for every viewer still transits the app server. The header at `:319-320` explains why:
   "pub-*.r2.dev ignores PutBucketCorsCommand CORS rules". That is a *CDN configuration* problem being
   solved with *application bandwidth*.
3. **No CDN in front of media at all.** `deploy/docker-compose.yml` terminates everything at one
   nginx. Media bytes and API requests share the same 2-vCPU host's egress.

## (b) Fiji's approach

*(from KB, unverified)* Three pillars (`fiji.md:52-93`): a `StorageService` abstraction over
S3/GCS/Azure with a presigned-URL cache (30-min TTL under a 1-hour expiry); **presigned upload and
download so bytes never transit Node**; and, where bytes must transit, a `/storage/proxy/{filePath}`
whose wildcard is used as an **object key**, gated by per-object authorization —
`isPublic` OR owner OR admin OR a scoped artifact token, else 403. I have no fiji `file:line` I can
verify.

## (c) Gap analysis

FlowVid has pillars 1 and 3. It has pillar 2 **for downloads that matter** (the export download is
presigned at 6 h — `export.controller.ts:35` `DL_TTL`) but **not for HLS playback**, which is the
highest-volume path. Fiji's multi-cloud abstraction is more than FlowVid needs; `fiji.md:149-151`
says so itself. **FlowVid should deliberately do less here** — one writable bucket (Supabase, already
chosen) plus a CDN, not three providers.

## (d) The ported solution

**Target state:** local-disk serving is a *development* backend only; production media is fetched by
the browser from a CDN-fronted bucket via presigned or signed-cookie URLs; the app server serves
**zero media bytes**.

1. **Put a CDN in front of the bucket and delete `/hls-proxy`.** The proxy exists solely because
   `pub-*.r2.dev` ignores bucket CORS. A CDN (Cloudflare in front of R2, or Supabase's own CDN
   domain) sets CORS headers at the edge, which removes the reason for the proxy entirely. New config:
   `MEDIA_CDN_BASE_URL`. `getPublicUrl` (`StorageService.ts:71`) becomes the single place that knows
   the CDN base — every adapter already implements it, and `keyFromPublicUrl:84` already exists as its
   documented inverse, so the pair cannot drift. **This is the highest-value item in Problem 3** and
   it is mostly a DNS/config change, not a code change.
2. **Signed URLs for private HLS.** `getPresignedDownloadUrl` already exists (`:18`). Playlists
   reference segments relatively, so presigning each segment is awkward — the clean answer is a
   **signed-cookie or signed-prefix** scheme at the CDN, scoped to the `hls/{videoId}/{runId}/`
   prefix, minted by the existing `mediaToken.ts` logic. Interim: keep `/hls-proxy` for private
   videos, route *public* ones straight to the CDN.
3. **Add a presigned-URL cache.** *(from KB, unverified: fiji uses an in-memory `Map`, 30-min TTL
   under a 1-hour expiry — `fiji.md:64`.)* FlowVid mints a fresh signature per call. A 30-minute
   memo keyed by `(key, ttl)` is ~20 lines in a `PresignCache` wrapper around whichever adapter
   `getStorageAdapter()` returns, and cuts signing CPU and Supabase API calls on hot paths.
4. **Turn `PUBLIC_LOCAL_PREFIXES` into a checked property.** `server.ts:253` — the honest fix is to
   resolve the owning row and check a visibility column, the way `authorizeMediaRequest` already does
   for `videos/`/`hls/`/`exports/`. Lower priority: these routes are unreachable in production
   because `getStorageAdapter.ts:71-84` refuses `LocalStorageAdapter` there. **Do not spend
   re-architecture budget here** — it is a dev-surface tidy-up, and saying so is more useful than
   pretending it is a P0.
5. **Do not add a fourth adapter, do not add multi-cloud.** `fiji.md:149-151` explicitly says one
   writable bucket is enough. Agreed. The abstraction is already there for swapping later.

## (e) Phases

| Phase | Content | Shippable alone? | Reversible? |
|---|---|---|---|
| **3a** | `MEDIA_CDN_BASE_URL` + CDN in front of the bucket; `getPublicUrl`/`keyFromPublicUrl` learn it; public media served from the edge | Yes | unset the env var |
| **3b** | Presign cache wrapper | Yes | remove the wrapper |
| **3c** | Signed-prefix HLS at the CDN; `/hls-proxy` becomes private-only | Yes | route back through the proxy |
| **3d** | Delete `/hls-proxy`; `PUBLIC_LOCAL_PREFIXES` → row-checked visibility | Yes | revert |

## (f) Risks

- **3a:** URLs already persisted in the DB (`corpora.storage_url`, `avatar_config…faces[].imageUrl`,
  `guidance_meta.mdUrl` — enumerated in the `keyFromPublicUrl` doc at `StorageService.ts:76-83`)
  encode the *old* host. Changing `getPublicUrl` without a backfill leaves rows pointing at the old
  origin. `keyFromPublicUrl` is exactly the tool for that backfill and it already exists — but the
  backfill is a **migration**, and this repo's policy is expand/contract with no automatic schema
  rollback (`.claude/reference/stack.md:139`). Keep both origins serving through the transition.
- **3c:** signed-prefix cookies interact with CORS and with the `Cross-Origin-Resource-Policy` header
  set at `server.ts:289`. Get this wrong and playback breaks silently in Safari only.
- **3b:** a presign cache that outlives the signature's validity serves 403s. TTL must be strictly
  under the expiry, as the KB notes fiji does.

## (g) Measurement

- **The number:** bytes egressed by the `backend` container per day. Target: **→ ~0** for
  `hls/`/`videos/`. `docker stats` net I/O, or nginx access-log byte sums per location block.
- p95 time-to-first-segment for HLS playback, before and after the CDN.
- Test: an integration test asserting `getPublicUrl(key)` and `keyFromPublicUrl(url)` round-trip for
  every adapter, including with `MEDIA_CDN_BASE_URL` set — the doc at `StorageService.ts:76-83`
  already argues this pair must not drift, so pin it.

---

# Problem 4 — Contract drift

## (a) Current state

`podcast-saas/shared/src/generated/client-v1.ts` is **1667 lines**, `admin-v1.ts` is **272**, and the
directory named `generated` has no generator. Measured:

- **174** distinct `/api/v1/...` route path literals across `backend-api/src/controllers/`
- **145** `/api/v1/...` call sites in `client-v1.ts`

The gap is not a defect count — the sets are not comparable line-for-line — but it is the shape of the
problem: two hand-maintained lists of the same URL space, drifting freely.

**There is no runtime schema anywhere.** No Fastify route declares a `schema:` — routes are typed only
through TypeScript generics, e.g. `export.controller.ts:64`:
`app.post<{ Params: { id: string }; Body: { allow_degraded?: boolean } | null }>(...)`. Those generics
are **assertions, not validations**: they neither validate the request at runtime nor emit anything a
generator could read.

`tsoa ^6.4.0` is a dependency and `backend-api/tsoa.json` exists, but **nothing imports `tsoa`**
(`.claude/reference/stack.md:77-78`) — dead config plus a dead dependency, presumably an abandoned
attempt at exactly this. The root `package.json` also has a `"generate"` script pointing at a
`backend-api` script that does not exist (`stack.md:79-80`).

**`zod ^3.23.8` is already a dependency.** That matters: it is the cheapest available single source of
truth for this stack, and it is already in the tree.

## (b) Fiji's approach

*(from KB, unverified)* TSOA decorators on controllers → `yarn generate-routes` → OpenAPI at
`fijiserver/src/generated/swagger.json` → `generate-stubs:web` / `generate-stubs:admin` produce the
typed clients fijiweb/fijiadmin consume (`fiji.md:115-122`). The client is *derived from the server*,
so drift is a build error. I cannot verify the script names or the generator used.

## (c) Gap analysis

The mechanism is right; the vehicle is wrong. **TSOA is an Express decorator framework and does not
fit Fastify** — porting it means rewriting all 27 controllers into decorated classes. That is exactly
the "rewriting all 27 controllers at once" the brief rules out, and it is the reason the existing
`tsoa.json` is dead. The correct translation of "derive the client from the server" onto Fastify is
**JSON Schema**, which Fastify speaks natively (`schema:` on a route, validated by ajv, exportable via
`@fastify/swagger`) and which `zod` can produce.

## (d) The ported solution

**Single source of truth: a `shared/src/contracts/` module of zod schemas.** Not the controller, not
the client — a third thing both depend on. This is the one place where I would *not* copy fiji: fiji's
SSOT is the controller because TSOA reads decorators off it; FlowVid's SSOT should be `shared/`,
because `shared/` is already the package both sides import and because it makes migration
**per-route**, which is the property the brief demands.

Shape:

```
shared/src/contracts/
  index.ts            // route registry: { method, path, params, body, response } per route
  projects.ts
  export.ts
  ...
```

Each entry exports zod schemas. Then:

- **Server side:** a small `defineRoute(app, contract, handler)` helper in
  `backend-api/src/lib/defineRoute.ts` that (i) converts the zod schemas to JSON Schema via
  `zod-to-json-schema` and passes them as Fastify's native `schema:` — so ajv validates at runtime,
  for free — and (ii) types the handler from the contract. A controller migrates one route at a time:
  `app.post<{...}>('/api/v1/...', opts, handler)` becomes
  `defineRoute(app, contracts.export.start, handler)`. **Nothing else in the controller changes.**
- **Client side:** a generator (`shared/scripts/generate-client.ts`) walks the same registry and emits
  `shared/src/generated/client-v1.ts` methods for **migrated** routes, leaving the hand-written ones
  untouched below a `// ── hand-maintained (not yet under contract) ──` marker. So the file is
  progressively generated, never rewritten wholesale.
- **CI enforcement, two gates:**
  1. `pnpm -C podcast-saas --filter shared generate:client && git diff --exit-code` — the generated
     region must be committed and current. Add to the release audit under
     `podcast-saas/ops/release/`, which already runs deterministic audits.
  2. **The drift test, which ships first and covers the un-migrated 100%** (below).

**The interim that ships this week — a drift-detection test.** This is the `tq-010` idea from the
review, and it is genuinely safe on its own:

New `podcast-saas/shared/src/generated/__tests__/routeDrift.test.ts`:
- Extract every route path literal from `backend-api/src/controllers/**/*.ts` (the regex
  `'/(api/(v1|admin/v1))[^']*'` I used above finds 174 of them; a proper version should read the
  method too).
- Extract every path template from `client-v1.ts` / `admin-v1.ts`, normalising `${...}` → `:param`.
- Assert **client ⊆ server**: every path the client calls exists on the server. A client method that
  404s is the failure mode that actually bites users, and this catches 100% of it.
- Assert **server \ client** against a checked-in allow-list of intentionally-unclient-ed routes
  (webhooks, `/health`, `sim-public`, `local-storage`). A new server route then forces a deliberate
  decision — add a client method, or add to the allow-list — instead of silently existing.

This is ~150 lines, needs no dependency, no controller changes, and turns the whole class from
"silent" into "loud at `pnpm test`".

## (e) Phases

| Phase | Content | Shippable alone? | Reversible? |
|---|---|---|---|
| **4a** | Drift test + allow-list. Delete `tsoa` dep + `tsoa.json` + the broken root `generate` script | Yes | delete the test |
| **4b** | `shared/src/contracts/` + `defineRoute` helper; migrate **one** controller (`export.controller.ts`, 6 routes, newest and best-understood) | Yes | contracts unused = dead code |
| **4c** | Generator emits the migrated region of `client-v1.ts`; CI `git diff --exit-code` gate | Yes | stop running the generator |
| **4d** | Migrate remaining controllers opportunistically — whenever a route is touched for other reasons | Yes, per controller | per controller |

**4a is the whole point.** It gets 90% of the protection for 5% of the effort, and 4b–4d can then
proceed at whatever pace the team has, without a deadline.

## (f) Risks

- **4a:** a regex-based route extractor has false negatives on multi-line registrations (my own
  first-pass grep found only 35 of 174 for exactly that reason). Use `typescript`'s AST — it is
  already a devDependency — not a regex, or the test will be quietly under-enforcing.
- **4b:** adding real ajv validation to a route that previously validated nothing **will reject
  requests the old route accepted**. That is the point, but it is a live behaviour change. Ship each
  migrated route with `schema` in *warn-only* mode first (log-and-pass) for one release, then enforce.
- **4c:** a committed generated file plus a CI diff gate creates merge conflicts on every concurrent
  branch. Mitigate by keeping the generated region contiguous and sorted deterministically.

## (g) Measurement

- 4a: the test exists and fails when you delete a backend route that `client-v1.ts` still calls
  (verify by deliberately breaking it once).
- 4b/4c: count of routes under contract, as a fraction of 174. Publish it; it is a good ratchet.
- Typecheck (`pnpm -C podcast-saas --filter shared build`,
  `--filter backend-api typecheck`, `--filter client-web typecheck`) stays green at every phase.

---

# Problem 5 — Worker/API separation and scaling

## (a) Current state vs the plan

`.claude/reference/worker-queue-extraction-plan.md` says *"Phase A + B shipped … Phases C–D not
started."* **That status line is out of date in both directions.**

**Phase D is effectively shipped.** `deploy/docker-compose.yml` defines a separate `worker` service
running `node dist/worker.js` from the same image, with `WORKER_INLINE: 'false'` on the backend and
`QUEUE_DRIVER: pgboss` on both. `src/worker.ts:12-30` is the dedicated entrypoint with a
graceful-drain SIGTERM handler at `:32-38`. Networks are even split — `backend` on `edge`, `worker` on
`internal`. The plan's claim that true separation "needs Railway/Render"
(`worker-queue-extraction-plan.md:104-106`) is superseded: it is running on Docker Compose today.

**Phase C is *not* shipped, and this is the live structural gap.**
`queue/pgBoss.ts:22` — `PGBOSS_JOB_NAMES = ['crop', 'video_generate', 'project_export']`. Compare with
`queue/types.ts:11`, which declares **eleven** job names. So **eight jobs still run inline** in
whichever process enqueued them (`queue/index.ts:21-23,32-38`), and since controllers do the
enqueuing, that process is the **API container**:

| Job | Where it runs today | Weight |
|---|---|---|
| `transcode` | **API container**, inline | heavy ffmpeg (HLS ladder) |
| `captions` | **API container**, inline | ffmpeg + Groq STT |
| `metadata` | **API container**, inline | LLM vision |
| `podcast_render` | **API container**, inline | heavy ffmpeg |
| `podcast_clips` | **API container**, inline | TTS + ffmpeg |
| `podcast_mix_export` | **API container**, inline | heavy ffmpeg |
| `podcast_script` | **API container**, inline | LLM |
| `project_duplicate` | **API container**, inline | bulk object copy |
| `crop`, `video_generate`, `project_export` | worker | — |

The comment at `queue/pgBoss.ts:17-21` names the incident that motivated moving `project_export`:
*"the 2026-08-13 incident was the kernel OOM-killing the API container mid-assembly, taking every
in-flight request down with it."* **`transcode`, `podcast_render` and `podcast_mix_export` are the
same class of work and are still on the API tier.** The lesson was applied to one job, not to the
class. That is the single most important finding in Problem 5.

Two smaller gaps the plan flagged and that are still open:
- **`metadata` has no CAS claim** (`worker-queue-extraction-plan.md:26,99-101,133`) — it must get one
  *before* moving to at-least-once delivery, or it will double-run GPT vision.
- **`@trigger.dev/sdk` vestigial tasks** (`:30,135`) — `jobs/video.transcode.ts:6` still declares
  `maxDuration: 3600` in a trigger.dev `task()` shape that nothing invokes.

## (b) Fiji's approach

*(from KB, unverified)* `fiji.md:132-143`: an **nginx single TLS edge** (`/` → web, `/api` → server,
`/comm` → websocket) with `client_max_body_size 100M` and 600 s read/send timeouts for SSE;
**presigned direct-to-cloud** so app servers stay stateless and bandwidth-light; `fijicomm` with an
optional Redis adapter for horizontal scale; `HeartbeatService` registering nodes; `fijicapture` as a
separate service. FlowVid's `deploy/docker-compose.yml` + `deploy/nginx/` already matches the nginx
edge pattern closely.

## (c) Is the plan still right?

**Yes on the choice, no on the status, and one judgement I would now make differently.**

- **pg-boss was the right call** (`worker-queue-extraction-plan.md:32-44`) and remains so: no Redis,
  one fewer moving part, and the deployment target changed from a managed single-app host to a
  Docker-Compose VM *without* invalidating it. Good decision, still good.
- **The "single-app managed host" constraint that shaped Phases B and D is gone.** The plan's
  `WORKER_INLINE` compromise (`:103-106`) exists only to serve a host FlowVid no longer deploys to
  (`stack.md:69` — the GoDaddy story is stale boilerplate). `WORKER_INLINE` should be demoted to a
  local-dev convenience and documented as never-for-production.
- **What I would do differently now: the phasing unit was wrong.** The plan phases by *job*
  (crop, then transcode, then …). Two years of evidence say the right unit is *the tier*: any job that
  can spawn ffmpeg or a browser belongs off the web tier, full stop, and moving them one at a time
  left the API container holding `transcode` and three podcast render jobs while `crop` — the
  *cheapest* of them — was migrated first because it was the *safest*. Safest-first optimised for
  migration risk; it should have optimised for **blast radius**. The remaining migration should be
  ordered by weight, not by safety: `transcode`, `podcast_mix_export`, `podcast_render` first.
- **One thing the plan missed entirely:** `pgBossDriver.ts:54` applies one concurrency number to every
  queue. The plan's per-queue-concurrency intent (`:96`) was never implemented. See Problem 2.

## (d) Target state and phases

**Target:** the API container spawns **no** subprocess and holds **no** long-running job. Every entry
in `queue/types.ts:11` is in `PGBOSS_JOB_NAMES`. `WORKER_INLINE` is dev-only.

| Phase | Content | Shippable alone? | Reversible? |
|---|---|---|---|
| **5a** | Add a CAS claim to `metadata` on `projects.metadata_status` (prerequisite, no queue change) | Yes | revert |
| **5b** | Add `transcode`, `podcast_render`, `podcast_mix_export` to `PGBOSS_JOB_NAMES` (`pgBoss.ts:22`) + per-queue `expireInSeconds` (`:32-36`). Verify the post-transcode cascade (`transcode` → `captions`/`crop`/`metadata`) still enqueues **across the process boundary** | Yes | remove from the array — `queue/index.ts:21-23` falls straight back to inline |
| **5c** | Add `captions`, `metadata`, `podcast_clips`, `podcast_script`, `project_duplicate` | Yes | same |
| **5d** | Delete `@trigger.dev/sdk` + `src/jobs/*.ts` trigger shapes; demote `WORKER_INLINE` to dev-only in docs and in `server.ts` | Yes | revert |
| **5e** | Second worker replica (`docker compose up --scale worker=2`) — **only after the host has cores to spare**, i.e. after Problem 1 Rank 4 moves capture off-box | Yes | scale back to 1 |

**5b's rollback is genuinely one array element** (`pgBoss.ts:22`), which is why this phasing is safe:
each job is independently revertible without a code change beyond that line.

## (e) Risks

- **5b, the real one:** the post-transcode cascade. Today `runVideoTranscode` finishing and
  `enqueueJob('captions', …)` happen in one process; after the move they are in different processes,
  and the enqueue happens in the *worker*. That is fine — `queue/index.ts` is imported there too — but
  any code path that assumed in-process ordering (a shared in-memory `inFlight` Set, for example —
  `inlineDriver.ts:17` has exactly such a module-level set) breaks silently across the boundary.
  Audit for module-level state shared between a producer and its consumer before moving each job.
- **5b:** `expireInSeconds` per queue must exceed worst-case runtime or pg-boss re-delivers a running
  job. `transcode` of a long video can exceed 45 minutes.
- **5c/`metadata`:** without 5a's CAS, at-least-once delivery double-runs an LLM vision call — real
  money. 5a is a hard prerequisite, not a nicety.
- **5e:** two workers on a 2-vCPU host is strictly worse than one. Do not do it until the arithmetic
  in Problem 2 says there is headroom.

## (f) Measurement

- **The number:** count of ffmpeg/docker child processes with the `backend` container as parent.
  Target **zero**. `docker exec <backend> ps -ef | grep -c ffmpeg`.
- API p95 latency during a large upload+transcode, before and after 5b. This is the acceptance
  criterion the plan itself names (`worker-queue-extraction-plan.md:151`) and it was never measured.
- Zero exit-137 (OOM) on the `backend` container over a week.
- Durability test (still owed from Phase B, `worker-queue-extraction-plan.md:87-92`): kill the worker
  mid-transcode, confirm re-delivery and CAS-guarded single execution.

---

# Ranking: value per unit effort

| # | Item | Effort | Value | V/E | Why |
|---|---|---|---|---|---|
| **1** | **P2a** — per-queue concurrency (`pgBossDriver.ts:17-19,54`), `EXPORT_CAPTURE_CPUS=1.5`, `expireInSeconds` fix | **~1 day** | High | **★★★★★** | ~10 lines. Removes the two-simultaneous-exports worst case on a 2-vCPU box today. Pure env/config, instantly revertible. Nothing else works reliably until the host stops being 3× over-committed. |
| **2** | **P1a+1b** — capture instrumentation, then capture-resolution split | **~2 days** | Very high | **★★★★★** | The scale plumbing already exists (`containerCaptureProvider.ts:150`). ~3–4× on the live blocker, and 1a is what makes every later decision evidence-based instead of guesswork. |
| **3** | **P4a** — route drift test + delete dead `tsoa` | **~1 day** | High | **★★★★★** | ~150 lines, no dependencies, no controller changes. Converts a silent failure class into a `pnpm test` failure. The cheapest permanent win in this document. |
| **4** | **P1c** — `captureEveryNth` (clock/readback decoupling) | **~2 days** | High | **★★★★☆** | Another ~2× with *zero* change to simulation dynamics — the naive "capture at 15fps" would silently change the rendered content. Needs a careful driver test. |
| **5** | **P5b** — move `transcode` + the two podcast render jobs to the worker | **~2–3 days** | High | **★★★★☆** | One array element (`pgBoss.ts:22`) plus cascade verification. Directly closes the incident class the code comment at `pgBoss.ts:17-21` already documents. Effort is in testing, not writing. |
| **6** | **P1d** — content-addressed clip cache | **~3 days** | High | **★★★★☆** | Makes repeat exports ~free. Identity primitives already exist (`posterIdentity.ts`, `configHash`). Docked slightly for the stale-hit risk, which demands care. |
| **7** | **P3a** — CDN in front of the bucket, retire `/hls-proxy` | **~3 days** | High | **★★★★☆** | Mostly config. Takes all media bytes off the 2-vCPU host. Docked for the persisted-URL backfill, which is a migration. |
| **8** | **P2b/2c** — weighted host-capacity semaphore; close the `encodeFramesToClip` limiter hole | **~3 days** | Medium-high | **★★★☆☆** | The correct fix for "three budgets that cannot see each other", but it is real concurrency work with a deadlock risk. 2c alone is an hour. |
| **9** | **P5a+5c+5d** — `metadata` CAS, remaining jobs to the worker, delete trigger.dev | **~4 days** | Medium | **★★★☆☆** | Right direction, lower urgency once the heavy jobs (item 5) are off the API tier. |
| **10** | **P2d** — per-org admission control + 429 | **~3 days** | Medium | **★★★☆☆** | The honest load-shedding story, but needs UI work. Lower priority once concurrency is capped at 1. |
| **11** | **P4b–4d** — zod contracts + generated client | **~2 weeks, incremental** | High (cumulative) | **★★☆☆☆** | Correct destination, large. Only worth starting after 4a proves how much drift actually exists. Migrate opportunistically, never as a project. |
| **12** | **P1e/P5e** — remote capture service, second worker replica | **~2 weeks + hosting** | High | **★★☆☆☆** | The right long-term architecture and the closest fiji analogue. Costs a machine. Do it when items 2/4/6 have failed to close the gap, sized by their measurements. |
| **13** | **P3b–3d** — presign cache, signed-prefix HLS, `PUBLIC_LOCAL_PREFIXES` | **~1 week** | Low-medium | **★☆☆☆☆** | Genuine improvements, but the production guard at `getStorageAdapter.ts:71-84` already makes the local-disk surface unreachable in prod. Do not spend re-architecture budget here. |
| **14** | **P1 Rank 5** — parallel segment capture | — | **Negative today** | — | Recommend against on 2 vCPU. Revisit only after item 12. |
| **15** | **P1 Rank 6** — async delivery contract | — | **Zero** | — | Already shipped. No work. |

**If you do only three things:** items 1, 2 and 3 — roughly four days total, all independently
revertible, and they address the live blocker, the saturation, and the silent-drift class at once.

---

## Where FlowVid should deliberately do less than fiji

1. **No multi-cloud storage.** One writable bucket. `fiji.md:149-151` agrees. The `StorageService`
   abstraction is already there for the day a provider swap is needed.
2. **No warm BrowserPool.** Fiji's pool *(from KB, unverified)* is incompatible with FlowVid's
   ephemeral-container isolation boundary (`containerRunArgs.ts:132-176`), and container start is not
   the bottleneck. Keep the isolation; buy the throughput with pixels and caching.
3. **No TSOA-shaped contract pipeline.** Fiji's SSOT is the controller because TSOA reads decorators.
   FlowVid's should be `shared/`, because that makes the migration per-route rather than
   all-27-controllers. Same mechanism, different vehicle.
4. **No `fijicomm`-style real-time tier.** Export progress is polled today and that is adequate; SSE
   already exists in `lib/sse.ts` if it is not.
5. **No cross-org fairness dispatcher yet.** With `localConcurrency: 1` plus a per-org admission cap,
   FIFO is honest and correct. Fiji's `JobDispatcher` fairness *(from KB, unverified)* is a
   many-tenant problem FlowVid does not have.

---

## Verification checklist (whole plan)

```bash
pnpm -C podcast-saas --filter backend-api typecheck
pnpm -C podcast-saas --filter backend-api test
pnpm -C podcast-saas --filter shared build
pnpm -C podcast-saas --filter client-web typecheck
pnpm -C podcast-saas --filter admin-web  typecheck
```

Plus, per problem: the s/frame log line (P1), `docker stats` load and exit-137 count (P2), backend
container egress bytes (P3), the drift test (P4), `ps -ef | grep ffmpeg` in the backend container
(P5).

**Never run during review** (`stack.md:190-192`): no `.env` reads, no migrations, no `psql`, no
dependency installs, no starting/stopping containers. This document describes migrations; it does not
run them.
