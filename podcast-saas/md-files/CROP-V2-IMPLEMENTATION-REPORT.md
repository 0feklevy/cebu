# Vertical-Crop Upgrade — Implementation Report

**Branch:** `feat/crop-v2` (7 commits, not pushed) · **Base:** `origin/main` @ 6c7f9bb
**Spec:** `md-files/CROP-VERTICAL-IMPROVEMENT-PLAN.md` · **Date:** 2026-08-21

---

## 1. Read this first: what the numbers in this report are

Every measurement below comes from **synthetic fixtures generated in-repo**, not from catalogue
footage. Eleven deterministic clips of flat-shaded discs and rectangles, each built to reproduce one
specific mechanism from the plan's diagnosis, with ground truth exact by construction.

**These are not field results.** An mIoU of 0.64 here does not predict what a hand-labelled podcast
clip would score. What the harness answers is narrower and is the question every task in the plan
actually asks: *did this change move the mechanism it claims to move, and did it break another one.*

The plan's P0.3 — 20–50 real catalogue clips, hand-labelled — is **NOT DONE and was not attempted**:
the catalogue is customer footage, it cannot be committed, and a harness that needs media the repo
does not contain is a harness that never runs. That gap has one consequence that decides the shape of
this run, and it is spelled out in §6: it is why P2's face detector was measured, costed, and then
deliberately **not landed**.

---

## 2. Numbers

Frame-weighted over 1,664 scored frames from 1,824 total. `attribution` is over the 864 frames that
contain more than one subject; chance is 0.500. Arrows mark the better direction.

| Metric | centre crop | v1.0 (before) | v1.1 (after P1) |
|---|---|---|---|
| mIoU ↑ | 0.3158 | 0.5852 | **0.6429** |
| IoU@0.5 ↑ | 0.1737 | 0.5890 | **0.6785** |
| subject-out-of-frame ↓ | 0.8359 | 0.3630 | **0.3311** |
| attribution accuracy ↑ | 0.5000 | 0.4236 | **0.4849** |
| jitter (mean abs 2nd diff) ↓ | 0 | 0.01256 | **0.00806** |
| travel per second ↓ | 0 | 0.02492 | **0.01635** |
| pinned at clamp ↓ | 0 | 0.0909 | 0.0909 |

v1 clears the centre-crop baseline the plan demands it justify itself against, before and after.

### Per category

| Category | mIoU v1.0 → v1.1 | attribution v1.0 → v1.1 | out-of-frame v1.0 → v1.1 |
|---|---|---|---|
| dark_skin | 0.272 → **0.508** | 0.281 → **0.526** | 0.719 → **0.474** |
| multicam | 0.358 → **0.438** | 0.417 → **0.464** | 0.583 → **0.536** |
| no_subject | 0.748 → **1.000** | — | 0 → 0 |
| same_gender | 0.435 → *0.347* | 0.467 → *0.454* | 0.533 → *0.546* |
| two_shot | 0.484 → 0.484 | 0.500 → 0.500 | 0.500 → 0.500 |
| warm_set | 0.961 → 0.961 | — | 0 → 0 |
| single | 0.961 → 0.961 | — | 0 → 0 |
| moving_subject | 0.407 → 0.407 | — | 0.663 → 0.663 |
| no_audio | not scored (ambiguous by design) | — | — |

**On `same_gender`.** Its mIoU drops while its IoU@0.5 and out-of-frame stay flat. That is an artefact
of mIoU against a bimodal target: a crop that hedges between two heads scores moderate IoU on every
frame, one that commits scores 1 or 0. The decisive metrics did not move. It is reported here rather
than smoothed over because it is the flagship category for defect D2b.

**Three baselines are committed** under `backend-api/scripts/crop-eval/results/`:
`centre@baseline.json`, `v1@v1.0.json` (pre-P1, regenerated against the final fixtures so the
before/after is like-for-like), `v1@v1.1.json`. Plus `sweep-av.txt`, the 80-point threshold grid.

### v2, flag on

**No numbers exist, and none can be produced here.** See §6.

---

## 3. Reproducing this

```bash
pnpm -C podcast-saas install --frozen-lockfile
pnpm -C podcast-saas --filter shared build

# the table in §2, and the delta against the committed pre-P1 baseline
pnpm -C podcast-saas --filter backend-api eval:crop -- --algo v1 --compare 'results/v1@v1.0.json'

# the centre-crop baseline
pnpm -C podcast-saas --filter backend-api eval:crop -- --algo centre

# the 80-point AV threshold sweep (~4 min)
cd podcast-saas/backend-api && ./node_modules/.bin/tsx scripts/crop-eval/sweep-av.ts

# the regression gate, plus every crop unit test (90 tests, ~4 s)
pnpm -C podcast-saas --filter backend-api test -- src/services/crop
```

`--write` refreshes the committed results file for the current `ALGO_VERSION`. A version bump with no
refreshed file fails `cropEval.test.ts` on the read, which is exactly when it should — the bump is
what forces every `ready` row to recompute.

---

## 4. Commits

| SHA | Scope | What |
|---|---|---|
| `cbc5c18` | P0 | Eval harness, `CropSource` seam, `ALGO_VERSION` in the idempotency hash, committed baselines, version-keyed vitest gate |
| `4f70652` | P1.1, P1.2 | Gender→region gap-fill deleted and replaced by shot-level speech evidence; AV thresholds in null-σ units; sweep committed |
| `3906dc1` | P1.6 | Block-histogram adaptive shot detection; synthetic grain removed from fixtures; baselines regenerated |
| `20e9823` | P1.5 | Null-evidence floor, honest fallback ladder, no more midpoint framing |
| `d208af3` | P1.3, P1.7 | Real debounce commit boundaries; decision-layer tests; dead code deleted |
| `69db63b` | P0.5 | Migration 066 — `video_files.crop_algo_version` |
| `9e10b97` | P2.2 | Async-backpressure frame delivery + eight extractor tests |

Tree state at HEAD: `pnpm -r typecheck` green across all six workspaces; backend crop suite 90 tests
green; `eslint src` zero errors.

---

## 5. Defect status

| ID | Verdict | Evidence / reason |
|---|---|---|
| **D1** skin-rule person detection | **PARTIAL** | The null-evidence floor stops saliency-only false heads, and motion now carries a subject the Kovač rule scores zero on: `dark_skin` mIoU 0.272 → 0.508, out-of-frame 0.719 → 0.474. But the rule itself is untouched and still fires on set decor — measured, the wood panel peaks at **122 skin px/frame against 49.7 for an actual face**. Replacing it is P2.1, not done (§6). |
| **D2a** AV attribution at the noise floor | **PARTIAL — bounded, not fixed** | Thresholds are now multiples of the null SD of *r* for their window instead of free-floating literals (0.12 at n=11 was a 0.38σ bar). The sweep's result is negative and decisive: across **all 80 grid points attribution never exceeds 0.499, against 0.500 for guessing**. Direct measurement of the correlator shows it names 13–45% of frames and is right on **17–46% of those — below chance**, because a nodding listener carries more motion than a talker's mouth at 4 fps. No threshold recovers information the signal never carried. Root fix is the mouth-ROI signal (P2.5), not done. |
| **D2b** gender gap-fill inverts on same-gender shows | **FIXED** | Removed from the decision path; both calibrators and their tests deleted. Deleting it alone regressed the D-16 end-to-end test (the below-chance correlator then latched onto its first firing and held for the take), so the slot was **replaced** — with shot-level speech-correlated motion per head, the same evidence `locateHeads` already trusts. Pitch keeps one job: speech vs silence, an RMS test. |
| **D3** two-shot gate degrades dialogue to one person | **NOT-DONE** | The bands/ratio/valley gates are deletable only once face tracks exist (P2.3/P2.4). |
| **D4** 3 s glides; client EMA smears cuts | **FIXED** | Server: the debounce now records the times it actually changed speaker and the smoother takes them as hard boundaries, replacing an inference from the output's own shape that had a documented false-negative mode. Client: **already fixed before this run** — see §7. |
| **D5** no null hypothesis; all-zero shots pin hard left | **FIXED** | `locateHeads` requires admissible per-frame evidence (skin/motion/speech — *not* saliency) before naming any head; branch C is real. Title card 0.412 → **1.000**, zero clamp pinning on subject-free shots, five unit tests. |
| **D6** shot detection misses same-room multicam cuts | **FIXED** | 4×3 block histograms scored over the four most-changed blocks, adaptive ratio against the local two-sided average. Multicam cut **recall 0 → 1.0 at F1 ≥ 0.9**; category mIoU 0.358 → 0.438. |
| **D7** mean-of-bimodal framing aims at the gap | **FIXED** | Pre-commit fallback is the previous shot's framing when a head is near it, else the head holding this shot's speech evidence — never the midpoint. Branch C takes one static framing or frame centre instead of a per-frame centroid. |
| **D8** static-camera prior with no escape | **NOT-DONE** | `walk-on` mIoU 0.407, unchanged. Needs the tracking-mode planner (P2.6). |
| **D9** unmeasurable, unfixable, unshippable | **PARTIAL — the core is fixed** | Harness, metrics, committed baselines, a version-keyed regression gate, `ALGO_VERSION` folded into the idempotency hash, and `crop_algo_version` on the row. Still missing: fleet audit (P0.1), annotation tool (P0.2), real labelled set (P0.3), backfill script (P2.8). |
| **D10** hygiene | **PARTIAL** | Deleted, verified unimported: `speaker.ts`'s `CalFrame`/`SpeakerCalibration`/`weightedMean`/`calibrate` and two dead constants (77 lines), `headLocator.ts`'s `activeHeadIndex` and `HEAD_WINDOW`. Still true: `stats.heads` and `stats.calibration` reflect only the last two-shot segment. Text protection is deferred by the plan itself. |

### Task-level

**P0** — P0.1 fleet audit **NOT-DONE** (needs production DB and HTTP access to public crop JSONs; out
of bounds for this worktree). P0.2 annotation tool **NOT-DONE**. P0.3 real labelled set **NOT-DONE**
(§1). P0.4 metrics + runner **DONE**. P0.5 version + column **DONE**.

**P1** — all seven addressed. P1.1 **DONE** (as a replacement, not a bare deletion — see D2b). P1.2
**DONE**, with the sweep's negative result recorded in the source. P1.3 **DONE**, deliberately
metric-neutral (mIoU 0.6435 → 0.6429): it removes an inference, it does not chase a number. P1.4 was
**already done before this run**. P1.5, P1.6, P1.7 **DONE**.

**P2** — P2.2 **DONE**. P2.1, P2.3–P2.8 **NOT-DONE**, §6.

**P3** — not reached, correctly out of scope.

---

## 6. Why P2 stopped, and what the next run should know

The plan's named stop conditions did not fire. Everything installs and runs. A different and stronger
blocker did, and all three findings below are worth more than the code they prevented.

**1. The dependency is fine, and it is bigger than the plan says.** `onnxruntime-node@1.27.0` installs
and loads with **no build script** — the tarball ships prebuilt binaries for every platform including
`linux/x64`, which is the production host. It unpacks to **258 MB** (darwin 74 MB, linux 56 MB, win32
128 MB), not the 60–80 MB the plan's risk section estimates. `pnpm-workspace.yaml` needs an
`allowBuilds` entry; `false` is correct and sufficient, since the postinstall only fetches a binary
that is already present.

**2. The plan names the wrong model file.** `face_detection_yunet_2023mar.onnx` — the file the plan
specifies, and the input size and timing it budgets from — has a **fixed 640×640 input**. ONNX Runtime
rejects the plan's 320×192 outright (`Got: 192 Expected: 640`). At its actual 640×640, with
`intraOpNumThreads: 1`, it measures **89.9 ms/frame on an Apple M-series core**. Derated for the shared
2-vCPU Xeon that is 180–360 ms/frame, or **216–432 s of inference for a 10-minute video at 2 Hz** —
against the plan's 6–30 s budget, and past the 20-minute stale-claim ceiling for a one-hour episode
even at `CROP_DETECT_FPS=1`.

`face_detection_yunet_2026may.onnx`, in the same opencv_zoo directory under the same MIT LICENSE, has
a **dynamic input**. It accepts 320×192, emits the expected 960/240/60 priors at strides 8/16/32, and
measures **5.20 ms/frame** — inside the plan's envelope, ≈12–25 s per 10-minute video after derating.
**That is the file to use.** Both are 227–230 KB. Licensing is unchanged: MIT, © 2020 Shiqi Yu.
SCRFD and YOLOv8 were never considered.

**3. The blocker is measurement.** Run against the eval fixtures, YuNet returns **zero detections at
any score threshold** — they are flat-shaded discs, not faces. So the detector, the tracks built on
it, the mouth-ROI signal and the planner fed by it **cannot be scored by the harness that exists**.
The plan's own P2.1 acceptance criterion ("detects both faces on two-shot fixtures … incl. the
darker-skin and warm-set fixtures") depends on P0.3 supplying fixtures cut from real clips.

Landing an unmeasurable detector — whose entire value proposition *is* detection quality — behind a
default-off flag would have produced roughly a thousand lines that look finished, cannot be verified,
and carry a 258 MB dependency for code nothing calls. The plan's central rule is that every change
moves a number. So the dependency and the model were **removed from the branch** rather than left in
place, and P2.1/P2.3–P2.8 are reported not-done.

Twice during this run a fixture artefact nearly measured as an algorithm result (§7, grain). Fitting a
synthetic face to a detector until it registers would be the same trap with higher stakes, so it was
not attempted.

**What P2 needs, in order:** P0.3 first — twenty to fifty real clips with labelled active-speaker
boxes. Everything in P2 is then measurable and the work below is ready to receive it: `CROP_ALGO` and
`ALGO_VERSION` exist (`services/crop/algo.ts`), `crop_algo_version` exists on the row, the harness and
gate exist, and **P2.2 is done** — `streamRgbFrames` now accepts an async `onFrame` and pauses stdout
while it is pending, so inference cost is wall time and never memory. That seam had to exist before
any detector, because the obvious alternative is the buffering that caused the perf-001 OOM.

---

## 7. Where the plan and the code disagreed

The plan states its citations were verified on 2026-08-20. Several describe an older tree. **The code
won in every case.**

1. **`useCropOverlay.ts:153` "EMA α = 0.06 per RAF" — stale, and P1.4 was already done.** The viewer
   has `nextCropX`, a pure exported function with `SNAP_THRESHOLD = 0.12`, a wall-clock
   `SMOOTH_TAU_MS = 260` exponential (frame-rate independent), and adopt-on-first-frame-of-segment.
   `client-web/__tests__/cropSmoothing.test.ts` drives the shipped function, explicitly because an
   earlier draft reimplemented the law and stayed green with the snap deleted. No viewer change was
   needed or made.

2. **`headLocator.ts` person-energy is not `skin×2 + sal×0.6 + motion×1.0`.** That is the audio-blind
   path only. Whenever audio decodes the file already used `SPEECH_AWARE = {skin 1.0, sal 0.5,
   motion 0.4, speech 2.2}` driven by `speechCorrelatedMotion` — a D-16 fix the plan does not mention
   anywhere, including in its §2.6 constant table. This materially weakens D1's "skin is weighted
   highest everywhere downstream".

3. **`activeSpeaker.ts` had a second gender calibrator.** `calibrateGenderRegionByActivity`, preferred
   over `calibrateGenderRegion` and absent from the plan. Both are now deleted.

4. **"Test coverage: only `dsp.test.ts` and `activeSpeaker.test.ts` exist" — wrong.** Five files
   existed, including `cropProcessor.test.ts`, a real end-to-end D-16 regression test. It is the test
   that caught P1.1's bare deletion and forced the better fix. `backend-api/bench/crop/` also already
   held three benches the plan does not mention.

5. **`smoother.ts` already cut at speaker switches.** The plan's §2.4 describes it as "median-3 then
   Gaussian σ = 1.2" and D4 derives a 3.1 s glide from that. The file already had `findSwitches` /
   `smoothRuns` with `SWITCH_STEP 0.12` and `SWITCH_HOLD_SEC 0.75`. P1.3's real contribution is
   replacing that *inference* with the debounce's actual commit times.

6. **Line numbers drifted.** The decision block cited at `cropProcessor.ts:196-207` was at ~208-213;
   `activeHeadIndex` cited at `headLocator.ts:96-108` was at 138-150. The two-shot bands are computed
   from fractions of `PROFILE_COLS`, not hardcoded as cols 9–44 / 52–86 (numerically identical).
   `runCropAnalysis.ts:28-33`, `sceneAnalyzer.ts:143-151` and the ffmpeg/queue citations were correct.

7. **Harness layout, deliberately split.** The runner is at the plan's `backend-api/scripts/crop-eval/`,
   but the pure fixture and metric modules are under `src/services/crop/eval/`. Backend vitest only
   collects `src/**/*.test.ts` and tsconfig only includes `src/**/*`, so anything outside `src` is
   neither typechecked nor testable — and a harness that scores wrongly is worse than none, because it
   launders regressions as improvements. The metric code has its own unit tests.

### Two things I got wrong mid-run, recorded because they cost real time

**Synthetic film grain measured as algorithm behaviour, twice.** A per-frame *global* brightness
offset makes a flat background jump a whole histogram bin at once — the new shot detector read four
cuts on a static title card. Replacing it with a pre-drawn noise field read at a frame-dependent
offset was worse: the field *scrolls*, which is coherent motion, and it collapsed scores across the
whole set. Fixtures are now clean, the limitation is stated in the file header, and **both committed
baselines were regenerated against the final fixtures** so the before/after remains like-for-like.
A "walk-on regression" attributed to the shot detector turned out to be the first grain artefact.

**`blockDistance` first averaged all twelve blocks**, which dilutes exactly the case the detector
exists for: a mirrored subject reads 0.149 over twelve blocks and 0.447 over the top four.

---

## 8. Scope notes

- Touched outside `services/crop`: `db/schema.ts`, `db/migrate.ts` and migration `066` (plan P0.5, at
  the coordinator's direction; migration number reserved — 065 belongs to `feat/library-share-impl`,
  067 to `feat/dubbing-multilang`), and one line in `backend-api/package.json` (`eval:crop`).
- Not touched: export/capture, viewer, billing, queue driver, job registry, job payload. `CROP_ALGO`
  and `QUEUE_CROP_CONCURRENCY` semantics unchanged.
- `CropOptions.av` was added as a tuning seam so the sweep can drive the real pipeline. Production
  never passes it.
- The JSON contract is unchanged and additive: `stats` gains `algo_version` and `evidence`;
  `stats.gender` is retained and is now always 0.
- **`ALGO_VERSION` is `v1.1` at HEAD.** Deploying this makes every `ready` row stale on its next
  trigger, which is the intended effect and is also a recompute cost across the catalogue. It is a
  deploy-time decision, not a silent one.
