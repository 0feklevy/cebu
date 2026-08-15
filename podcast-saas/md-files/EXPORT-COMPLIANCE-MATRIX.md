# Linear video export — compliance matrix

Branch `fix/export-final-e2e-acceptance`, head `36d93b2`. Every state below was decided by reading
the code, not a plan or a commit message; each row names the evidence. A requirement that is
implemented, exported and unit-tested but reachable from nowhere real is PARTIAL, never COMPLETE.

**Verdict: NOT READY — EXTERNAL VALIDATION REQUIRED.** The capture is correct and proven on the real
host. It cannot meet the production time budget on the current hardware, and that is a purchasing
decision, not a code change. Everything that does not depend on it has been built.

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
