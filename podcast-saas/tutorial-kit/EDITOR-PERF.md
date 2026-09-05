# EDITOR-PERF — "loading simulation in the editor takes HOURS"

Date: 2026-09-05 · Branch: `feat/welcome-tutorial-kit` · Local stack (client :3000 next dev, backend :8080 tsx, LocalStorageAdapter). Heavy case: the **Kinesin / Dynein package — 13 files, 36.5MB**, of which one file is a **28.3MB** `models/kinesin-alembic-baked.glb`.

All numbers below are measured (playwright `request/response` waterfalls, curl, backend logs); artifacts referenced at the bottom. **Cold** = fresh browser profile, first visit. **Warm** = the same tab, reopening the same surface seconds later. The backend process was warm throughout (the 60s `simFileResolver`/`revisionIdentity` caches and `SimTextCache` were live in both BEFORE and AFTER, so they are not what changed).

## 1. BEFORE numbers

### 1a. Editor, never-generated (LEGACY-path) kinesin section — measured before the v3 template rebuild replaced it
Every mount of the sim document re-downloaded the **entire package**; nothing was cacheable:

| moment | sim-public transfer | detail |
|---|---|---|
| open `/projects/<id>/editor` (timeline slot warms the package) | **36.5MB** (13 × full 200) | `.glb`/`assets/*`: **no Cache-Control, no ETag, no Last-Modified**; HTML: `no-cache`, **no ETag** |
| open **Edit Section** (+0.3s → SIM_PAINTED) | **+36.5MB** (13 × full 200, again) | second iframe, same URLs, zero revalidation possible |
| close + reopen Edit Section (warm) | **+36.5MB** (13 × full 200, again) | ~**110MB** total for one editor visit |

Header proof (old code): `GET …/models/kinesin-alembic-baked.glb` → `200`, `content-length: 29719784`, **no caching header of any kind** (`out/before-headers.txt`). On localhost each 36.5MB pull is ~0.3s, which is why dev feels fine; at a WAN's 20–50Mbit/s it is **6–15s of "FORMING…" per mount, three mounts per short session** — the owner's live-product experience, and the tutorial films' long loading states. The v3 template build that ran mid-task independently corroborated it: its own verification failed with `heavy · kinesin … never presented inside the [32-44s] window` — the package could not arrive in time.

### 1b. Editor, generated (REVISION-path) kinesin section "Touch the motor" (v3 demo `6bf5b36b…`, section `93e6b8fa…`)
Revision package files already carried `public, max-age=31536000, immutable`, so 11 small files cached — but every mount still re-downloaded **29.7MB**:

| moment | transfer | what still re-downloads |
|---|---|---|
| editor open (cold) | 36.6MB | first visit — expected |
| Edit Section open → SIM_PAINTED 0.33s | **29.7MB** | entry HTML **full 29.6KB** (`no-cache, must-revalidate` but **no ETag** on the local branch → nothing to revalidate with) **+ the 28.3MB GLB** |
| warm reopen → SIM_PAINTED 0.44s | **29.7MB** | same two, every time |

### 1c. Generate (publish path), BEFORE
Editor Generate on the kinesin section: **52.8s** click → new revision live (LLM-dominated locally). The storage stages under it (old code, from the source): **~57 serial storage round trips per publish** — 15 serial writes (`SimulationService.ts` loop, `RevisionDerivation.ts` loop), then `validate()` read the whole package back **twice**, serially: `verifyStoredBytes` GET+HEAD per file, then `checkCaptureCompatibility` GET per file again ≈ **73MB re-streamed + 36.6MB written per publish**. On cloud storage at 50–150ms/round-trip that alone is 3–9s of pure latency plus double-transfer — and it scales linearly with file count (a 1000-file package: ~4000 serial round trips), which is the "sometimes fine, sometimes forever" cost model.

### 1d. Library card
The editor's Library row click loads **no** package (0 sim-public requests — it only selects). The surface that does is the public library share (`/{slug}/library`, `LibraryOverlay`), which mounts the **legacy** entry URL — i.e. the worst path in 1a, fixed below.

## 2. Root cause (file:line, verified against the waterfalls)

1. **Legacy sim files served with no validators at all.** `backend-api/src/services/storage/serveFile.ts` (old :31-33) set only `Content-Type`/`Accept-Ranges` (+`Cache-Control` when given); `sim-public.controller.ts` (old :346-355) passed no cacheControl for non-revision keys and never any ETag/Last-Modified → the browser cannot cache and cannot revalidate → **full re-download per mount** (1a).
2. **Entry HTML unrevalidatable on the local branch.** `sim-public.controller.ts` (old :330-345) served injected HTML with `no-cache` and no ETag (the cloud branch has one via `simTextCache`) → full re-download per mount (1b).
3. **Publish = ~4N serial round trips + double read-back.** Serial upload loops at `SimulationService.ts:3247-3256` and `RevisionDerivation.ts:392-401`; `RevisionService.validate()` (:425) reading the package twice serially — `verifyStoredBytes` (:518 GET, :545 HEAD) then `checkCaptureCompatibility` (:399 GET per file) (1c).
4. **Capture container staged packages serially** — `containerCaptureProvider.ts` `fetchPackageFiles` one `readObject` at a time (same shape as 3).
5. **Residual, out of server control:** Chrome refuses to *store* a 28.3MB cache entry (its per-entry cap is a fraction of the cache budget). Measured: the 5.5MB `dynein-runtime.glb` hits the cache on every remount, the 28.3MB `kinesin-alembic-baked.glb` never does — same URL, same `immutable` header, `cache: 'default'` fetch, re-downloaded 3× in one session. gzip only shrinks it 14% (25.4MB), so compression cannot duck the cap. See §5.

## 3. Fix (all backend; viewer present-gating untouched)

| file | change |
|---|---|
| `services/storage/serveFile.ts` | opt-in `statValidators`: `Last-Modified` + weak `W/"<size>-<mtime>"` ETag from the stat it already does; If-None-Match / If-Modified-Since → **304, no stream opened**. RFC 9110 weak comparison; conditional check before Range handling. |
| `controllers/sim-public.controller.ts` | local branch: legacy keys now `Cache-Control: no-cache` + `statValidators: true` (revalidate every use → replace-in-place picked up immediately, so the audited stale-immutable bug cannot return); local entry HTML gets a **strong ETag of the served (post-injection) bytes** + 304, same semantics as the cloud branch. Revision keys keep their verified policy byte-for-byte. |
| `services/simulation/SimulationService.ts` | publish upload loop → `mapWithLimit(…, 8)` (order-preserving, per-item abort check kept, first failure still marks the draft failed); + one `sim publish: revision files staged` log (fileCount/totalBytes/uploadMs). |
| `services/simulation/RevisionDerivation.ts` | same bounded fan-out for derived revisions (base reads are lazy, so this parallelises read+write); + staged log. |
| `services/simulation/RevisionService.ts` | **single read-back pass** (`readBackPass`, bounded 8-wide): one GET+hash+HEAD per file feeds *both* the verification report and the capture gate's file map — the capture verdict now evaluates the very buffers the verifier hashed. Problem codes/details, skip rules, manifest-order reporting, and the gate's fail-closed read error are preserved byte-for-byte; `verifyStoredBytes` still exists (delegates) for its direct callers/tests. Only capture-relevant bytes are retained, so peak memory matches what the old gate already held. + `revision read back and verified` log. |
| `services/export/capture/isolation/containerCaptureProvider.ts` | package staging reads 8-wide; the 256MiB cumulative ceiling still enforced as each read lands. |
| `controllers/__tests__/sim-public.localParity.test.ts` | +4 regression tests (ETag/304 for HTML and binaries, replace-in-place freshness, Range unaffected). **Mutation-proven**: with the serving fix stashed, 3 of them fail; restored, 10/10 pass. |

Not done, deliberately: on-the-fly compression of `.glb` (measured 14% for 1.25s CPU — not worth it) and year-long caching for legacy keys (the audited staleness bug; `no-cache`+304 gives the same warm-path bytes with none of the risk).

## 4. AFTER numbers (same scenarios, fixed backend)

**Headers/conditional (curl, `out/after-headers.txt`, `out/after-304-proof.txt`):** legacy `.glb` now `no-cache` + `ETag: W/"1c57ce8-…"` + `Last-Modified`; conditional GET → **`304`, 0 bytes, 1.6ms** (vs 29.7MB full). If-Modified-Since alone → 304. Legacy and revision entry HTML → strong ETag → 304.

**Legacy path in a real browser** (`legacy-reload.mjs` — load the legacy kinesin entry URL, then reload):
- first load: 13 × full 200 = **36.5MB**
- reload: 11 revalidated-from-cache + 1 × 304 + **only the 28.3MB GLB** re-fetched (browser cap, §5) — and for every seeded sim without a >cap file (murmuration, solar, galton, 5-species) a warm mount is now **~0 bytes**. BEFORE, every reload was 36.5MB regardless.

**Editor, revision section (playwright, same script as BEFORE):**

| moment | BEFORE | AFTER |
|---|---|---|
| Edit Section open, transfer | 29.7MB (HTML full + GLB full) | **29.7MB → GLB only; HTML now a 304** |
| warm reopen, transfer | 29.7MB (same two) | **GLB only; 12 of 13 files cache/304** |
| open → SIM_PAINTED | 0.33s / 0.44s (warm) | 0.45s / 0.17s (warm) — localhost hides transfer cost; the bytes column is what converts to WAN seconds |

**Generate (publish), AFTER** — editor Generate, new prompt, wall **33.8s** (LLM-dominated both runs; the wall delta is *not* attributable). The storage stages, now measured directly (backend log, `sim publish:` lines): staging **14 files / 36.6MB: uploadMs=80**; single read-back+verify+capture gate: **readBackMs=78**, `bytesVerified=14, storageProblems=0, captureVerdict=compatible`. Round trips per publish: **~57 serial → ~30 ops in 8-wide waves (≈6 sequential wave-times), and read amplification halved (73MB → 36.6MB)**. On cloud storage that is the difference between 3–9s of serialized latency + double transfer and well under a second of it. Verification semantics unchanged — the gate that refused the CDN-loading Galton package still sees exactly the same bytes and answers with the same codes (170 backend tests over the touched files pass, incl. the mutation-tested manifest/verify suites).

## 5. What remains, honestly

- **The 28.3MB single file cannot be browser-cached** (Chrome per-entry cap; measured: 5.5MB caches, 28.3MB never does, headers correct). Server headers cannot fix this file; every *document mount* re-fetches it. Two real options, both out of this task's surgical scope: (a) let the SectionEditor preview adopt the already-warm timeline `EditorSimPool` document instead of mounting a second one — touches the protected residency/present-gating design, needs its own review; (b) shrink the asset (meshopt/Draco or splitting the alembic bake) — content-side, biggest win per byte. Until then: open-editor + open-section costs ~65MB cold and each reopen ~28MB for THIS sim (down from 36.5MB per mount for every sim, every time).
- Run→`SCRIPT_APPLIED` never acks over `window.postMessage` in either build (runtime uses its own channel); the Run measurement was taken as click→paint instead. Not a perf issue; noting so nobody chases it.
- Cloud binary serving 302→bucket is untouched (already redirects); the legacy-path validators help any deployment on local-disk storage and the entry-HTML/304 fix helps all of them.

## 6. Verification run

`pnpm --filter backend-api typecheck` ✓ · `--filter client-web typecheck` ✓ · backend vitest over every touched file (9 files, **170 passed**, no unhandled errors) ✓ · localParity incl. new 304 tests **10/10** (3 RED with fix stashed — mutation check) ✓ · client guard tests `simExitHandoff` + `viewerActiveSimUrl` **26 passed** ✓ · nothing committed; backend restarted via `run-backend-seeded.sh`, `/health` 200.

Proofs (all under `seeding/proof/`): `editor-perf-before-open-painted.png`, `editor-perf-after-open-painted.png` (Edit Section fully painted, asset-proof 0.57s), `editor-perf-after-warm-reopen.png` (0.31s), `editor-perf-after-generate.png`. Raw evidence, same dir: `editor-perf-evidence-{before,after}-headers.txt`, `editor-perf-evidence-after-304.txt`, `editor-perf-evidence-after-legacy-reload.txt`, `editor-perf-evidence-waterfalls.txt`, and the full playwright waterfalls `editor-perf-evidence-{before-legacy,before-revision,after-revision}-events.json`.

Note for integrators: `client-web/components/viewer/useProjectPlayer.ts`, `lib/sim/SimRuntimeClient.ts`, `lib/simTelemetry.ts` carry a *different* agent's concurrent worktree changes — not part of this fix; client typecheck and the guard tests passed with them present.
