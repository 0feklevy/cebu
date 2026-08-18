# Linear video export — compliance matrix

Branch `fix/export-final-e2e-acceptance`, head `a89fef0`, 19 commits ahead of `origin/main`. Every state below was decided by reading
the code, not a plan or a commit message; each row names the evidence. A requirement that is
implemented, exported and unit-tested but reachable from nowhere real is PARTIAL, never COMPLETE.

**Verdict: NOT READY — REQUIREMENTS REMAIN.** Local requirements are still open (§Remaining below),
so the stronger verdict is not available yet. The capture itself is correct and proven on the real
host, and the throughput gap is a purchasing decision rather than a code change — but that is not
sufficient while local work remains.

---

## The one blocker, quantified

| | measured |
|---|---|
| per-frame cost, 640×360 | **5,366 ms** — sim 153 + flush 19 + **raster 5,193** + write 1 |
| per-frame cost, 1920×1080 | ~16,300 ms |
| per-section budget | `min(600, 90 + 6·durationSec)` — 150 s for a 10 s window |
| a 10 s window at 360p | 1,394 s — **9.3× over** |
| host | 2 vCPU Xeon 8259CL, no GPU, shared with backend and client-web |

**96.8 % of a frame is software rasterisation**, which is exactly what a GPU replaces. The
simulation's own JavaScript is 2.9 %, so every lever that changes what the viewer sees — fewer
boids, lower LOD, no post-processing — is worth at most 3 % and is not worth its dishonesty. The
decision is a dedicated GPU capture pool, and it needs its own spike (§4.2 below is the code half).

---

## Phase 0 — operational

| id | requirement | state | evidence |
|---|---|---|---|
| 0.1a | The export's cancellation signal reaches the capture | COMPLETE | `captureTypes.ts` `captureSection(spec, signal?)`; `ProjectExportService.ts` passes `abort.signal`; `containerCaptureProvider.ts` forwards it to the boundary |
| 0.1b | A cancelled capture ends as `cancelled`, not `failed` | COMPLETE | The failure path calls `throwIfCancelRequested`; test *a cancel DURING capture ends as cancelled — with the error the REAL backend throws* |
| 0.1c | Cancellation is never laundered into a poster | COMPLETE | Rethrown before the policy branch; test *CANCELLATION is never degradation, even where a poster was permitted* |
| 0.1d | A queued ffmpeg pass honours cancellation | COMPLETE | `ffmpegLimit.ts` `runFfmpegLimited(task, signal)` checks before the wait and after the slot |
| 0.1e | The `ready` CAS refuses to publish over a cancellation | COMPLETE | `cancel_requested = false` in the update predicate; mutation-proven test |
| 0.1f | Docker stop then hard kill after a bounded grace | COMPLETE | `captureJobBoundary.ts` stop → `docker kill --signal=KILL` after `KILL_ESCALATION_MS` |
| 0.1g | Cancellation during package fetch / staging | PARTIAL | Covered between phases by the poll, not inside the fetch loop |
| 0.2a | Every capture artifact has an explicit owner | COMPLETE | The clip's ownership passes to the consumer, removed after upload |
| 0.2b | Release on every failure path, not only success | PARTIAL | Cleanup is on the success path; upload/DB failure still leaks the clip dir |
| 0.2c | Janitor restricted to a validated root; orphan metrics | NOT DONE | No janitor exists |
| 0.3a | `project_export` has its own concurrency, default 1 | COMPLETE | `pgBossDriver.ts` `concurrencyFor()`; tests pin 1 for export, 2 for crop |
| 0.3b | Concurrency parser handles absent/0/negative/NaN | PARTIAL | `Math.max(1, Number(...))` handles absent, 0, negative and NaN→1; fractional is not floored |
| 0.3c | Expiry derived from an admitted job bound | PARTIAL | Expiry raised above the per-section caps and admission now bounds the workload, but the two are not yet derived from one formula |
| 0.3d | Process-local concurrency is not a global limit | NOT DONE | Documented, not solved; needs a scheduler slot |

## Phase 1 — the trusted/untrusted output boundary

| id | requirement | state | evidence |
|---|---|---|---|
| 1.0a | Artifact names are allowlisted | COMPLETE | `ALLOWED_ARTIFACT_PATHS`; 16 tests fail if reverted |
| 1.0b | Artifact paths are realpath-confined | COMPLETE | `assertWithinOutputDir`; symlink test |
| 1.1a | `result.json` is confined, regular-file, size-capped before parsing | COMPLETE | `assertRegularArtifact(outputDir, CAPTURE_RESULT_FILENAME, MAX_RESULT_BYTES)`; the `/dev/zero` OOM primitive is closed |
| 1.1b | No-follow descriptor read | PARTIAL | `realpath` + `lstat` achieves the same outcome; `O_NOFOLLOW` not used |
| 1.2a | `result.sectionId` must equal `spec.sectionId` | COMPLETE | `assertResultMatchesSpec` |
| 1.2b | A passing result has exactly `expectedFrameCount(spec)` | COMPLETE | same |
| 1.2c | Viewport and DPR match the request | COMPLETE | same, enforced only where frames exist |
| 1.2d | Exactly one artifact form on success | COMPLETE | same |
| 1.3a | Frames is a real directory, exact contiguous names | COMPLETE | `assertFrameSet` |
| 1.3b | Nested symlinks rejected before ffmpeg reads them | COMPLETE | `lstat` per entry; mutation-proven (`stat` instead of `lstat` fails the test) |
| 1.3c | Per-file and total byte bounds | COMPLETE | `MAX_ARTIFACT_FILE_BYTES`, `MAX_ARTIFACT_TOTAL_BYTES` |
| 1.3d | Frame dimensions probed | NOT DONE | Size and count are checked; pixels are not |
| 1.4a | Clip is a regular confined file, size-bounded | COMPLETE | `assertRegularArtifact` |
| 1.4b | Clip streams, codec, fps, duration probed | NOT DONE | No `ffprobe` on the returned clip |
| 1.5 | Adversarial tests | COMPLETE | 48 boundary tests: traversal, absolute, symlink, oversize, wrong section, wrong count, wrong viewport, both/neither artifact |

## Phase 2 — full-versus-degraded semantics

| id | requirement | state | evidence |
|---|---|---|---|
| 2.1a | `degradation_policy` column, default `forbid` | COMPLETE | migration `059`, `schema.ts` |
| 2.1c | Persisted at creation from explicit consent | COMPLETE | `export.controller.ts`; test *records the STRICT policy on the row by default* |
| 2.1d | Immutable across retries and redeliveries | COMPLETE | Read from the row by `degradationPolicyOf`; test |
| 2.2a | A sim-capture window is not degradation | COMPLETE | Consent now triggers only on `poster-fallback`; test |
| 2.2b | Strict-mode unavailability is a truthful failure | COMPLETE | `StrictCaptureFailed`, retryable |
| 2.3a–d | Under forbid every failure fails the export, no master | COMPLETE | Four outcome-matrix tests, each asserting `output_key` is null |
| 2.3e | Under allow_poster the per-window fallback is unchanged | COMPLETE | test |
| 2.3f | Retry only transient infrastructure failures | PARTIAL | A gate failure is marked non-retryable; there is no retry budget |
| 2.4a | The plan is frozen at creation and that plan executes | NOT DONE | The controller dry-runs; the worker rebuilds |
| 2.5a | Consent bound to a plan fingerprint | NOT DONE | No fingerprint |
| 2.6a | `quality_state` is null until ready | COMPLETE | `exportBody` |
| 2.6b | `degradation_policy`, `degraded_windows` exposed | COMPLETE | `exportBody` |
| 2.6c | Per-section progress fields, capture stage, frame counts | NOT DONE | Only `objects_done/total` |

## Phase 3 — instrumentation

| id | requirement | state | evidence |
|---|---|---|---|
| 3.0a | Per-frame cost split into sim / flush / raster / write | COMPLETE | `beginFrameBackend.ts`; measured on the real package |
| 3.0b | The measurement is observable outside the container | COMPLETE | `createBackend()` wires `log` to stderr — it was a no-op, so every diagnostic was discarded |
| 3.0c | Per-phase timings (fetch, staging, docker, chrome, nav) | NOT DONE | Only the capture loop is instrumented |
| 3.1a | `warmupFrames` propagates spec → backend | COMPLETE | `toBackendSpec` forwards it, backend honours it; test asserts the driver received 7 |
| 3.2a | Actual readiness pumped-frame counts recorded | NOT DONE | The 900 ceiling is still the only number |
| 3.3a | Benchmark matrix, three cold repetitions | PARTIAL | Four points measured by hand; no harness |

## Phase 4 / 5 — hardware and capacity

| id | requirement | state | evidence |
|---|---|---|---|
| 4.2a | Typed renderer profile allowlist | COMPLETE | `RENDERER_PROFILES`, `resolveRendererProfile` |
| 4.2b | Hardware fails closed if SwiftShader answers | COMPLETE | `assertRendererMatchesProfile`; test |
| 4.2c | `--use-angle=gl` forbidden in both profiles | COMPLETE | test |
| 4.2d | Chrome / image / GPU / driver recorded | PARTIAL | Image digest and shell version recorded; no GPU or driver |
| 4.1 | Hardware bake-off with p50/p95 and cost | NOT DONE | **Needs the GPU host** |
| 4.3 | GPU isolation proven with the cage intact | NOT DONE | **Needs the GPU host** |
| 4.4 | SLA derived from measured p95 | NOT DONE | Blocked on 4.1 |
| 5.2a | Reject impossible jobs before enqueue | COMPLETE | `admitCaptureWorkload`; 413/429; test asserts nothing is inserted or enqueued |
| 5.1a | Dedicated pool routing / queue allowlist | NOT DONE | One process consumes every queue |
| 5.2b | Global scheduler slots, per-org limits, backlog cap | NOT DONE | |
| 5.4 | Worker shutdown drains and verifies container removal | NOT DONE | |

## Phase 7 — frontend

| id | requirement | state | evidence |
|---|---|---|---|
| 7.0a | No client-side capture anywhere | COMPLETE | No MediaRecorder / WebCodecs / captureStream in `client-web` |
| 7.0b | Strict default CTA + separate stills CTA | NOT DONE | One button, `allow_degraded` on retry |
| 7.0c | Consent names the affected sections | PARTIAL | Warnings are returned; the panel does not name sections |
| 7.0d | Staged progress ("Rendering simulation 2 of 11") | NOT DONE | |
| 7.0e | Active-export discovery on reload | NOT DONE | |
| 7.1a | `LINEAR_EXPORT_ENABLED` kill switch | COMPLETE | `export.controller.ts` — off answers 404 |
| 7.1b | Pinned `EXPORT_CAPTURE_IMAGE` digest | PARTIAL | Env names the image; a digest is not required |
| 7.1c | Account allowlist / percentage rollout | NOT DONE | |

---

## What must happen next, in order

1. **Decide the hardware.** The measured 96.8 % raster share makes a GPU capture pool the only
   option that closes a 10× gap. The code half is ready (`EXPORT_CAPTURE_RENDERER=hardware`, which
   fails closed if SwiftShader answers); the spike must prove a real renderer inside an unweakened
   cage, `beginFrame` determinism, frame-hash repeatability on a pinned image and driver, and the
   dead-canvas negative control still failing.
2. **Then the real-host gates**: smoke A–E, the production package at 1920×1080 for a real section
   duration, two runs compared by frame hash, and no network / DNS / IMDS reachable from the cage.
3. **Then the remaining product work**: the frozen plan and its fingerprint (2.4, 2.5), per-section
   progress (2.6c), the two CTAs and export discovery (7.0b–e), pool routing and global capacity
   (5.1, 5.2b), shutdown draining (5.4).
4. **Only then** the end-to-end acceptance: a multi-simulation project exported, the MP4 watched,
   every simulation visibly moving, `quality_state: full`, `degradedWindows: 0`, twenty consecutive
   exports without timeout, OOM, fallback or disk growth.

Nothing above may be met by weakening the cage, relaxing the gate, raising a timeout to hide a hang,
or letting a strict export publish a still.

---

## Update — the eight-commit pass (head `a89fef0`)

Eight commits landed after the matrix above was first written. What follows supersedes the rows they
touch, adds the requirements the earlier matrix omitted, and states what remains.

### Closed by this pass

| id | requirement | evidence |
|---|---|---|
| 0.3a | migration 059 SHIPPED — it existed, was reviewed, and was registered nowhere | `migrate.ts`, `check-db.ts`; `migration059.test.ts` (10 tests) |
| 0.3b | registration drift cannot recur, in either direction, with ordering | same file — three generalised guards, not per-migration assertions |
| 0.3c | 059 backfill idempotent BY CONSTRUCTION, not by accident | scoped inside the column-creation branch; the test ages the row first |
| 3.1a | `warmupFrames` reaches the compositor; ONE default | `beginFrameCapture.test.ts` proves 0 and 7 at provider level |
| 4.2e | renderer identity read from an ISOLATED WORLD, not page-writable state | the fake page claims an RTX 4090; the assertion requires SwiftShader |
| 4.2f | renderer profile is a typed field on the wire; unknown FAILS | `assertRendererProfileName`, `configFromEnv` |
| 3.0b | cost split returns as validated data, reaching the host on exit 0 | `parseCaptureCost` — bounded, finite, advisory, discarded whole if malformed |
| 0.1d | a QUEUED ffmpeg pass honours cancellation, with no slot leak | `ffmpegLimit.test.ts` — 6 saturation tests; mutation fails 3 |
| 0.1h | cancellation decided atomically in the terminal transition | `CASE WHEN cancel_requested` in the same statement |
| 1.1a | `result.json` refuses symlink at the NAME, hardlink via `nlink`, O_NOFOLLOW read | `captureJobBoundary.test.ts`; mutation fails 2 |
| 1.3b | frame entries refuse symlink AND hardlink before ffmpeg opens them | same |
| 1.3d/1.4b | frames and clip PROBED — streams, codec, pix_fmt, dimensions, fps, duration, count | `artifactProbe.ts`; `artifactProbe.realMedia.test.ts` against real ffmpeg output |
| 1.4c | every ffmpeg, including the provider's encode, under the global limiter | `runFfmpegLimited` wraps `encodeFramesToClip` |
| 0.2b | artifact ownership released in `finally` on every path | `ProjectExportService` upload try/finally |
| 2.4a | the plan is FROZEN at creation and that plan executes | migration 060, `planFingerprint.ts`, worker calls no planner; mutation fails 2 |
| 2.4b | `plan` is write-once; runtime → `effective_plan`, failure → `failure` | `assertNotFrozenColumn` refuses either frozen column |
| 2.5a | consent bound to the fingerprint, signed, expiring, per user and project | `consentToken.ts`, 12 tests |
| 2.5b | naked `allow_degraded` starts nothing | `exportEndpoints.test.ts` |
| 2.5c | preview endpoint: no row, no enqueue, sections named, will vs may | `GET .../export/preview` |
| 2.6a–c | authoritative progress: phase, section, capture stage, frame counters | migration 061; monotonicity and no-pre-increment tests; mutation fails 1 |
| 2.6d | `degraded_windows` counts substitutions, not warnings | column written with the terminal state |
| 5.1a | `WORKER_QUEUES` allowlist; unknown name is a startup error | `resolveWorkerQueues`, 5 tests |
| 5.1b | `project_export` can never run inline, whatever the driver says | `NEVER_INLINE`; `enqueueJob` throws |
| 5.1c | durable awaitable enqueue, singleton per export, truthful 503 | `enqueueProjectExport`; the row is marked failed, not left queued |
| 7.0e | active-export discovery + server capability | `GET .../export/current`, registered before `:exportId`, 5 tests |

### Requirements the earlier matrix omitted, now recorded

| id | requirement | state |
|---|---|---|
| 6.x | **Phase 6 capture cache** | **BLOCKED BY ORDER** — the plan forbids caching until uncached production capture is proven, and it is not. Not implemented, deliberately; the key design (package digest, entry, section identity, config hash, duration, fps, size, DPR, warmup, algorithm and gate versions, dependency-registry hash, Chrome version, image digest, renderer identity, encode settings) is recorded here so it is not re-derived later. Never key on `configHash` alone. |
| 7.2 | capability endpoint | COMPLETE — `export/current` carries `export_enabled` and `live_capture_configured` |
| 7.3 | generated-client reconciliation, duplicate handwritten export methods removed | NOT DONE |
| 8.4a | rollout cohort / percentage | NOT DONE |
| 8.4b | monitoring and automatic rollout stop | NOT DONE |
| 0.2c | janitor for orphaned artifacts + orphan metrics | NOT DONE |
| 5.4 | worker shutdown drain, container removal verified | NOT DONE |
| 5.2b | global scheduler slots, per-org limits, backlog cap | NOT DONE (per-job admission control IS done) |
| 7.1b | image DIGEST enforcement (tag is accepted today) | NOT DONE |

### Remaining local requirements — why the verdict is REQUIREMENTS REMAIN

1. Two CTAs, staged progress rendering, and consent naming sections **in the UI** (7.0b–d). The
   backend contract they need is complete; the React work is not.
2. Generated client reconciliation (7.3).
3. Package-fetch cancellation inside the fetch loop (0.1g).
4. Expiry derived from one admitted-cost formula rather than a raised constant (0.3c).
5. Global capacity, shutdown drain, janitor and orphan metrics (5.2b, 5.4, 0.2c).
6. Image digest enforcement, rollout cohort, monitoring/autostop (7.1b, 8.4a–b).

### Verified on the real host at this head

- Image `podcast-saas/export-worker:v8` built from `a89fef0`.
- **`FLOWVID_SMOKE=PASS`** — Stages A–E, mechanism `sys-admin`.
- Throughput unchanged and still the blocker: 96.8 % of a frame is software rasterisation.

### Suite results at this head

| check | result |
|---|---|
| `pnpm --filter shared build` | clean |
| `pnpm --filter backend-api typecheck` | clean |
| `pnpm --filter backend-api lint` | 46 problems, **0 errors** |
| `pnpm --filter backend-api test` | **2489 passed**, 18 skipped, 0 failed |
| `pnpm --filter client-web typecheck` | clean |
| `pnpm --filter client-web lint` | 84 problems, **0 errors** |
| `pnpm --filter client-web test` | **1389 passed**, 0 failed |
| migration tests | 164 passed |
| adversarial boundary tests | 181 passed |
| mutation / consent / cancellation | 65 passed |
| `git diff --check` | clean |
