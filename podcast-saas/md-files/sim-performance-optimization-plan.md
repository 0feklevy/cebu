# Simulation Rendering Performance Plan

**Targets:** `/Users/admin/Desktop/boids-3d`, `/Users/admin/Desktop/murmuration-knob`, and the podcast-saas sim-embedding pipeline.
**Symptom:** on phones / old devices the sims run like stop-motion (laggy, stuck, delayed) and use too much RAM.
**Hard constraint:** simulation **parameters, behavior, and visuals stay identical**. Only implementation-level ("backend") changes. Anything that is not bit/pixel-identical is explicitly flagged and needs owner OK before implementation.

Both sims share the same engine lineage (same `Flock.js`, `config.js`, `noise.js`, `BirdModel.js`, `Parrot.glb`, three.js **r169** via jsdelivr import map), so most engine fixes apply to both. Sources: four parallel audits (boids-3d, murmuration-knob, podcast-saas pipeline, web research 2024–2026). All file:line references verified against current files.

---

## 1. Root causes (evidence-backed)

| # | Root cause | Evidence | Hits |
|---|---|---|---|
| RC1 | **GC pauses → the stop-motion hitches.** `noise.js:64-66` allocates 3 closures *per curl() call* → 12–16k allocations/frame; the spatial-hash grid is a JS `Map` cleared + refilled with 4,000 entries every frame (`Flock.js:237-249` boids / `231-243` murm) → ~6–12 MB/s garbage → periodic 5–30 ms minor-GC pauses on old phones. | boids audit §3b, murm audit §3.2, research P3 | both sims |
| RC2 | **GPU vertex/fill load.** 4,000 birds × 497 verts ≈ 2.0M MeshStandardMaterial vertex invocations/frame (murm), and boids renders the **whole scene twice** because BokehPass does a full depth pre-pass (`BokehPass.js:81-92`) → ~5M tris/frame. DoubleSide material doubles rasterization; exploit-knob ball = massive overdraw. | boids §3c/3e, murm §3.3 | both |
| RC3 | **Wasted RAM.** `antialias:true` allocates a 20–32 MB MSAA canvas that is *provably unused* (every scene render happens inside the composer's non-MSAA HalfFloat targets; only the final fullscreen quad touches the canvas). Bloom in boids keeps 11 render targets with unused depth buffers. Phone totals: boids ~100–130 MB, murm ~60–75 MB (≈25–30 MB free to reclaim). iOS caps canvas memory at 224–384 MB/page; Android Chrome kills the oldest WebGL context after ~8. | boids §3d/3e/3j, murm §3.4/3.8, research P1/P5 | both |
| RC4 | **Nothing ever pauses.** The sims render unconditionally (no `visibilitychange` / IntersectionObserver / context-loss handling: boids `main.js:106,273`, murm `main.js:89,140-153`). The platform hides finished sims with `opacity:0` and **deliberately never unmounts the iframe** (`SimOverlayDynamic.tsx:12-33`, `viewer.css:282-301`) — so a finished sim keeps simulating 4,000 birds behind the video for the rest of the session. Browsers do **not** throttle opacity-0 in-viewport iframes. boids' ambient audio even keeps playing while hidden. The editor can run **two** live sims at once (`VideoPlayer.tsx:412-431` + `SectionEditor.tsx:2265-2276`). | boids §3g, saas §3, research P0 | both + saas |
| RC5 | **Platform serving/boot cost.** `/sim-public` has **no compression and no ETag**; entry HTML + `bridge.js` are `Cache-Control: no-cache` → full uncompressed re-download at every section entry (`server.ts:510-535`). No sim preloading exists (video gets 30 s prewarm, sims get nothing — `useProjectPlayer.ts:1013-1017` vs `:454-531`). murm additionally ships **unminified** three.module.js (1.30 MB vs 0.69 MB min). | saas §2/§6, murm §4#12 | saas + murm |
| RC6 | **Safari 30 fps iframe throttle (context, not a bug of ours).** Sims are cross-origin to the viewer (backend `/sim-public` origin), and Safari caps rAF in cross-origin iframes at 30 fps until the user first *taps inside* the frame; iOS Low Power Mode caps ~30 fps page-wide. Both sims are delta-clamped so speed survives 30 fps, **except** murm's pacing: at 30 fps `min(0.033×2, 0.05)` = 0.05 → runs at 1.5× instead of SIM_SPEED 2× (25% slow-motion on every iPhone until first tap). This is the sims' *intended* graceful-slowdown clamp being triggered by an artificial cap. | research P0; murm `main.js:24-25,141-147` | iOS mainly |

---

## 2. Workstream A — shared engine fixes (apply to BOTH sims)

All items here are **bit-identical** (same trajectories, same pixels) unless flagged. Effort S/M/L.

| ID | Fix | Where (boids / murm) | Impact | Effort |
|---|---|---|---|---|
| A1 | **Hoist `n1/n2/n3` closures to module scope** in `noise.js` (pure, no captured state). Kills 12–16k allocs/frame. | `noise.js:64-66` (both) | GC hitches ↓↓ (top stop-motion fix) | S |
| A2 | **Replace the `Map` spatial grid with a preallocated Int32Array open-addressing hash** (key + bucket-head per slot, keep existing `next`-chain head-insertion so per-cell iteration order is byte-identical). Zero steady-state allocation; `get` becomes an array probe. Main-flock k-NN is provably order-independent (total order on (d², id)); boids lab modes (`ExploreExploit.js:190-198`, `Intervention.js:487-496`) preserve insertion order → `NEIGH_CAP` truncation stays bit-identical. | boids `Flock.js:46,237-249,292` + lab files; murm `Flock.js:45,231-243,286` | GC ↓↓, sim CPU −10–25% | M |
| A3 | **Pause when invisible**: gate the animation loop on `document.visibilitychange` + `IntersectionObserver` on the canvas, and handle a `simPause`/`simResume` postMessage from the parent (see D1). On hide: stop rAF entirely (0 CPU/GPU), ramp boids audio to 0 (fixes the audio-keeps-playing bug); on show: flush `clock.getDelta()` then resume. Nothing visible changes — it only runs when nothing is visible. | boids `main.js:106,273` (+audio `main.js:180`); murm `main.js:89,140-153` | Offscreen burn → ~0; battery/thermal headroom | S |
| A4 | **`antialias: false`.** MSAA never touches scene geometry in a composer pipeline (r169 EffectComposer targets are non-multisampled); output pixels are identical. Verify with screenshot diff; do NOT "compensate" with target MSAA. | boids `main.js:52`; murm `main.js:57` | −20–32 MB RAM each, − a full-res resolve/frame | S |
| A5 | **WebGL context-loss recovery**: `webglcontextlost` (preventDefault) + `webglcontextrestored` → re-init renderer/composer/PMREM. Prevents the permanent black/white section after memory-pressure eviction on old phones (frequent on iOS 17+ backgrounding). | boids `main.js:52-63`; murm `main.js` (canvas `index.html:25`) | Reliability (no dead sims) | M |
| A6 | **Debounce resize** (~150 ms trailing). iOS URL-bar show/hide fires bursts; each resize reallocates ~20–46 MB of render targets (and resizing WebGL canvases leaks on iOS Safari — WebKit bug 219780). | boids `main.js:265-271`; murm `main.js:131-138` | Removes mid-scroll hitches | S |
| A7 | **Skip composer render when output is provably static** (paused + no camera/UI change). boids: `CONFIG.paused` freezes sim/grain/flap → identical frames; murm has no pause UI but A3 covers its hidden case. | boids `main.js:293,304,334` | Paused embed → ~0 GPU | S–M |
| A8 | **Use the minified three.js build** in the import maps (same r169, byte-identical behavior): `three.module.min.js` 687 KB vs 1,305 KB. Keep jsdelivr (immutable + edge-cached) for now — vendoring into the sim folder only makes sense after D3 (today `.js` via the proxy is `no-cache` + uncompressed). | boids `index.html:20-27`; murm `index.html:15-22` | Boot time on old phones/networks ↓ | S |
| A9 | *(flagged: near-identical, last-ulp float rounding — trajectories diverge over minutes, statistics identical; breaks bit-repro)* **Replace hot-loop `Math.hypot` with `Math.sqrt(x*x+y*y+z*z)`** (3–10× faster) and **eliminate the FOV `sqrt`** via sign-split squared compare. ~40k hypot + up to 2M sqrt per frame today. | murm `Flock.js:270,369,382,429,433,472,486,509,529,541,550` + `:300-301`; boids `Flock.js:307` | Sim CPU −1–4 ms/frame (more in dense mode) | S |

## 3. Workstream B — boids-3d–specific

| ID | Fix | Where | Impact | Risk / Effort |
|---|---|---|---|---|
| B1 | **Single-pass DoF**: attach a `DepthTexture` to the composer's scene target and feed BokehShader from it, removing BokehPass's second full-scene depth render (−2.5M tris, −9 draws per frame). **The biggest GPU lever in boids.** | `Post.js:64-72` (behavior source `BokehPass.js:81-92`) | Frame time −30–45% on vertex-bound phones | **Near-identical** (depth now includes wing-flap displacement, excludes mist/band depth writes; maxblur 0.006 → imperceptible, but **needs owner OK + A/B screenshots**) / M–L |
| B2 | **`depthBuffer:false` on bloom's 11 render targets** (they only ever receive fullscreen quads). | `Post.js:74` (targets from `UnrealBloomPass.js:46-64`) | −3 MB phone / −17 MB desktop | none / S |
| B3 | **Bound the instanceMatrix upload to live instances** via `addUpdateRange(0, count*16)` — today the full 5,000-slot buffer (320 KB) uploads every frame for 4,000 live birds. | `Flock.js:130,553` | −20% upload bandwidth | none / S |
| B4 | **Hoist per-bird `roostHalfExtents` destructuring + roost reads out of the loop** (4k iterator allocs/frame on old JSC). | `Flock.js:424-427` | CPU −0.5–1.5 ms/frame | none / S |
| B5 | **Remove dead weight from the uploaded bundle**: `src/UI.js` (unreferenced), `models/Stork.glb` (unused), dead CSS (`style.css:30-86,135-136`). | listed | −80 KB + clarity | none / S |
| B6 | *(optional, flagged config edit)* **Lower `spatialCellSize` 12 → 6-8**: the config comment marks it non-biological, and boids' k-NN selection is provably cell-size-independent — but it is still a CONFIG edit → owner sign-off + bit-equality regression over ~1,000 steps. Do NOT touch lab-mode `CELL` (order-sensitive). | `config.js:23` | Pass-1 candidates ~240 → ~30-60/bird | needs OK / S code + M verify |

## 4. Workstream C — murmuration-knob–specific

| ID | Fix | Where | Impact | Risk / Effort |
|---|---|---|---|---|
| C1 | **Adaptive *internal* grid cell size when local density explodes** (exploit-knob ball). The exact-K search is provably correct for any cell size; `CONFIG.spatialCellSize` stays untouched as the default. Removes the knob-at-exploit stop-motion (~500 pair tests/bird → ~40). | `Flock.js:46-47,247` | −5–15 ms/frame at exploit end | **bit-exact** / M |
| C2 | **Iterate ring shells directly** (faces/edges/corners) instead of full-cube-with-skip — kills the O(r³) skip overhead for sparse stragglers (3,375 iterations/ring at maxRing 7). Same cells, same result. (Port to boids too if trivial.) | `Flock.js:281-285` | Tail-latency win | none / S–M |
| C3 | **Don't construct disabled passes** (BokehPass + UnrealBloomPass are `enabled=false` before the first frame — today they still allocate 11+ JS render-target objects, 3 materials, and a latent ~7 MB GPU + shader-compile landmine). Build lazily if ever enabled. | `Post.js:64-75`, `main.js:107-109` | Startup ↓, heap ↓ | none / S |
| C4 | **Skip falcon construction + per-frame falcon loop when `predator.count === 0`**, and skip the wasted `compileEquirectangularShader()` (PMREM `fromScene` uses the cubemap path). | `main.js:72`, `Flock.js:63-70,141-163,570-577`; `Environment.js:61` | −50–200 ms startup | none / S |
| C5 | **Merge the post chain into one pass**: scene → single HalfFloat RT → one combined grade+ACES+sRGB fullscreen pass (reuse three's exact tonemap/sRGB GLSL chunks, keep grade math byte-identical, preserve linear-before-tonemap order). Drops one full-res pass + ~9 MB RAM; also lets the ×0 grain hash compile out behind `#ifdef`. | `Post.js:55-100`, `main.js:80,152` | −~10 MB/frame bandwidth, −9 MB RAM | near-identical→none (**verify pixel-identical via screenshot diff**) / M |
| C6 | **Renderer `depth:false`** (canvas depth unused — output is a fullscreen triangle; scene depth lives in the composer RT). Verify final pass depthTest. | `main.js:57` | −2–3 MB | none (verify once) / S |
| C7 | **Coalesce knob pointermove to once per rAF** (SVG `feDropShadow` re-raster per move today) — values land the same frame. | `Knob.js:181,212-229` | Smooth drags on old phones | none / S |
| C8 | **Hoist the per-bird `roostHalfExtents` destructure** (same as B4). | `Flock.js:427` | CPU | none / S |

## 5. Workstream D — podcast-saas platform (no sim visuals touched)

| ID | Fix | Where | Impact | Effort |
|---|---|---|---|---|
| D1 | **Real pause/freeze protocol** (gives the already-sent-but-unhandled `pauseScript` real semantics): extend the **system-owned injected bridge template** with a `simPause`/`simResume` handler that gates a wrapped `requestAnimationFrame` (queue callbacks while paused, deliver on resume — visual state untouched, works for ANY uploaded sim, no sim modification → consistent with the non-invasive guided-sim approach). Parent sends `simPause` wherever it hides the overlay / already sends `pauseScript`; `simResume` just before `startScript` + reveal. Also gate guidance.js's always-on rAF poll loop. Existing sims pick it up on next bridge/guidance regen (entry HTML is rewritten in place); add a one-off re-inject script for already-uploaded sims. | Template `SimulationService.ts:192-224` (+ `:693-737`, `:803-850`), inject `:1795-1801`; parent sends `useProjectPlayer.ts:479-483,842-849,1160-1165` (replace `pauseScript`), resume `:511-515,1155-1157`; editor `VideoPlayer.tsx:263-290`; guidance `GuidanceService.ts:334-347` | Hidden sims → ~0 CPU/GPU while staying warm (instant re-entry) | M |
| D2 | **Destroy-on-leave with hysteresis**: after the 200 ms fade completes, clear `activeSimUrl` so the iframe (WebGL context + JS heap) is truly freed — immediately on mobile/low-memory, after a 30–60 s grace window on desktop (fast scrub-back). Combine with D1: pause instantly, destroy later. Must clear *after* the fade (the "never clear" comment guards a mid-fade black flash). Editor: also pause the timeline sim while the SectionEditor preview tab has its own sim open (two live WebGL contexts today). | `useProjectPlayer.ts:479-493,842-849,1525-1532`; `SimOverlayDynamic.tsx:12-33`; `VideoPlayer.tsx:263-278`; `SectionEditor.tsx:2265-2276` | Hard RAM reclaim — the fix for iOS canvas-memory/jetsam and Android's ~8-context kill | S–M |
| D3 | **Compression + ETag on `/sim-public` text**: register `@fastify/compress` scoped to the route, add `ETag` (bridgeHash/content sha already available) so the `no-cache` entry HTML + bridge.js revalidate as 304 instead of full re-download. ~60–75% smaller text transfers. | `server.ts:150` (plugin), `:525-535` (etag/conditional); optional precompress at `SimulationService.ts:1371-1390` | Section-entry latency ↓↓ on phone networks | S |
| D4 | **Prefetch/pre-boot sims ahead of the boundary**: timeline is fully known (`segments[].simulations[]`). N s before a sim section, `fetch()` the entry+bridge to warm the cache (needs D3's ETag), or the stronger variant — mount the iframe early with `showSimOverlay:false` **paused via D1**, gated on HLS buffer health. Removes the boot hitch that lands exactly at the transition today. | Next to the b-roll prewarm `useProjectPlayer.ts:1041-1051` (pattern `:1013-1017`); entry points `:495-521`; editor `VideoPlayer.tsx:254-305` | Perceived transition smoothness ↑↑ | M |
| D5 | **Free HLS memory while a sim holds the screen**: `hls.stopLoad()` on active+standby when the overlay is up and video paused (post-roll / userInteraction), `startLoad()` on resume (scrub path already does this). Tens of MB back exactly when the sim needs them. | `useProjectPlayer.ts:503-509,1160-1165,1514-1563` | RAM headroom on low-end | S |
| D6 | **Low-end device hint (enabler, no behavior change until sims opt in)**: central `resolveSimUrl()` appends `lowend=1&dpr=…` when `deviceMemory ≤ 4 || hardwareConcurrency ≤ 4 || saveData`; also post an `env` message after `SIM_READY`. Verified safe with `canReuse` (checks `includes('section=')`) and guidance rewrites (preserve unknown params). | New helper beside `client-web/lib/assetUrl.ts:18-31`; src sites `SimOverlayDynamic.tsx:26`, `VideoPlayer.tsx:283/425`, `SectionEditor.tsx:892`; template `window.__SIM_ENV` | Enables owner-gated tiering later (see §6) | S |
| D7 | **Proxy micro-tuning**: 308 instead of 302 for immutable binary redirects; consider streaming instead of full-buffer `readObject` for large text. | `server.ts:518-523,525-535`; `SupabaseStorageAdapter.ts:272` | Small | S |
| D8 | **In-place sim file update endpoint (operational enabler)**: today re-uploading creates a *new* simulation id + storage prefix, so existing sections keep pointing at the old files. Add an owner-only "replace files" path that reuses the same simId/prefix (bridge re-injection + `?v=` bust already handle staleness), so shipping these optimizations doesn't require re-linking every section. | `simulations.controller.ts:116-236`, `SimulationService.ts:1328-1397` | Makes A/B/C deployable to live sections | M |

## 6. Owner-gated options (change output resolution/pacing — DECIDE, not yet planned)

These are the only items that are not visually identical. Each needs an explicit go/no-go:

1. **Lower DPR cap on weak devices** (boids 1.75→~1.4, murm 1.5→1.25 when `lowend=1`): +20–45% fps where fill-bound, −30–55% RT/canvas RAM; slight softness. (Current caps stay for capable devices.) — boids `main.js:60`, murm `main.js:60`, keyed off D6.
2. **Tap-to-run poster on phones** (`SimOverlayDynamic` defers mount until tap): WebGL never boots unless requested — the biggest possible win for the worst devices, but a UX change, and it interacts with post-roll/guided/auto-script sims. Bonus: the tap also lifts Safari's 30 fps iframe throttle (RC6).
3. **Decimated Parrot LOD (~150–250 tris)** for murm (birds render at 4–25 px): −60–75% vertex cost, often 15→45 fps on old GPUs — but it *is* a mesh change (sub-pixel at those sizes); requires A/B screenshot sign-off.
4. **Worker-thread solver** (murm first): same math, deterministic, unblocks the UI thread — L effort; only if still CPU-bound on target devices after A1/A2/C1.
5. **30 fps render cap on measured-slow devices** (delta-correct rAF halving — sim speed unchanged): steadier-feeling motion than uncapped jitter per frame-pacing research.
6. **murm pacing under Safari's 30 fps cap**: `MAX_DT=0.05` + `SIM_SPEED=2` means 1.5× instead of 2× speed at 30 fps (25% slow-motion on iPhones until first tap). Fixing it means touching a frozen pacing parameter — flagged only; default is leave as designed.

## 7. Explicitly NOT doing (would change visuals/behavior)

Bird counts (4,000), all steering/perception/flight/roost/predator parameters, knob keyframes/detents/inversion, deterministic seeds (9973/4321/1337), material class + DoubleSide + iridescence/flap uniforms, tone pipeline (ACES 0.58, grade order/constants), light rig + PMREM env bake, camera framing, `frustumCulled=false`, current DPR caps upward, fixed-timestep-with-interpolation refactors (rejected in-code already), lab-mode order-sensitive internals (`NEIGH_CAP`, `CELL`), OffscreenCanvas rendering (old iPhones ≤ iOS 16 lack WebGL-in-worker — research verdict: not worth it), WebGPU migration (the target devices are exactly the fallback cohort), serving sims same-origin to dodge Safari's 30 fps cap (with `allow-same-origin` sandbox it would hand uploaded sims the app origin → XSS).

## 8. Verification & acceptance

- **Bit-exactness harness (per sim):** run N=1,000 steps headless with fixed dt seed-for-seed before/after; byte-compare `px/py/pz` snapshots for every "risk: none" change. A9-class changes (documented rounding) are excluded and verified statistically instead.
- **Pixel-exactness:** golden screenshots (same seed, fixed frame indices) diffed for A4, B2, C5, C6, B1 (B1 expects only mist/wing-edge DoF deltas).
- **Perf before/after on-device:** Chrome DevTools 6× CPU throttle + a real old iPhone/Android: report fps, JS heap, `renderer.info` (calls/triangles/textures), GC pause count (Performance panel), and total page memory in the viewer with a video+sim section.
- **Platform checks:** sim section enter/leave/re-enter (warm resume via D1, destroy via D2), guidance + branching still fire, `canReuse` unaffected, editor dual-preview paused, `/sim-public` returns brotli + 304s, existing sections keep working after D8 in-place update.
- **Release path:** run repo test suites for backend/client changes; sims re-uploaded through D8 (or re-linked manually until D8 lands).

## 9. Rollout order

1. **Phase 1 — zero-risk engine wins (both sims):** A1, A4, A3, B2, B3, B4/C8, C3, C4, C6, C7, A6, A8, B5 → then A2 (grid rework) + C2. *Expected: GC stop-motion gone, −25–30 MB RAM each, offscreen burn → 0.*
2. **Phase 2 — platform lifecycle:** D1 + D2 (one lifecycle policy), D3, D5, D7 → then D4, D6, D8. *Expected: finished sims cost nothing, section entry fast, RAM headroom on phones.*
3. **Phase 3 — structural sim wins:** C1 (exploit-ball fix), C5, A5, A7, A9 → B1 last (owner OK + A/B).
4. **Phase 4 — owner decisions:** §6 items as approved (recommended order: 1 → 2 → 5 → 3 → 4).

*Effort ballpark: Phase 1 ≈ 1 day; Phase 2 ≈ 1–2 days; Phase 3 ≈ 1–2 days; Phase 4 per decision.*
