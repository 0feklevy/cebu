# Vertical crop — deep investigation

**Branch:** `fix/night-audit-2026-08-15` @ `ef651a9` (worktree `.../scratchpad/audit-fix`)
**Scope:** `podcast-saas/backend-api/src/services/crop/**` + how the result reaches the player and the export.
**Read-only.** No source file was modified. Measurements below were produced by running the repo's own
pure functions and `ffmpeg` locally on synthetic inputs (no server, no vendor, no DB, no prod).

**Important:** none of the 13 audit-fix commits on this branch touch `services/crop/**`
(`git log -13 --name-only | grep -i crop` → empty). Everything here is live on this branch.

**Measured coverage context:** `services/crop` was 38.8% stmt / 25% branch. Verified by inspection:
only `dsp.ts` and `activeSpeaker.ts` have tests. **`cropProcessor.ts`, `headLocator.ts`,
`sceneAnalyzer.ts`, `smoother.ts`, `debounce.ts`, `ffmpegExtract.ts`, `runCropAnalysis.ts` have zero
direct tests.** That is 7 of 10 files, including every file that decides where the crop goes.

---

## 1. The algorithm, end to end, in plain terms

| Step | Technique actually used | Where |
|---|---|---|
| Sampling | ffmpeg `fps=4,scale=320:180`, rgb24 raw over a pipe. Fixed **4 fps**, fixed 320×180, **whole file decoded** (the `fps` filter decimates after decode). Streamed frame-at-a-time; nothing buffered. | `ffmpegExtract.ts:88-96`, `cropProcessor.ts:37-39` |
| Audio | ffmpeg → 16 kHz mono s16 → **entire track buffered** into a `Float32Array`. | `ffmpegExtract.ts:129-171` |
| Per-frame features | Three 96-bin **column projections**: (a) frame-difference motion, thresholded at 5/255, restricted to rows 8–78% of frame height; (b) **Kovač RGB skin-tone pixel count**, same band; (c) **spectral-residual saliency** (Hou & Zhang) via a hand-rolled 64×64 2-D FFT. Plus a weighted-centroid "interestX". | `sceneAnalyzer.ts:83-138` |
| Shot detection | **32-bin grayscale-luma histogram, Bhattacharyya distance > 0.30**, min 0.5 s between cuts. Luma only — no colour, no edges, no motion-vector signal. | `cropProcessor.ts:40-42, 123-128` |
| Pitch | FFT-based **normalised autocorrelation F0** per 0.25 s window, with parabolic peak interpolation and an octave guard. Threshold male/female by **1-D k-means valley** over the video's own F0 distribution, falling back to 160 Hz. | `dsp.ts:77-142`, `speaker.ts:55-81` |
| Subject location | **Not a face detector.** Per shot, sum the three profiles over that shot's frames, form `person-energy = skin×2.0 + saliency×0.6 + motion×1.0`, box-blur it, take the strongest peak in the left band [0.10, 0.46] and the right band [0.54, 0.90]. Two-shot iff both peaks ≥ 28% of the max, ≥ 0.20 apart, and a valley between them dips ≥ 12% below the weaker peak. Otherwise a single `dominantColumn` (skin-gated saliency, up-weighted motion) over [0.06, 0.94]. | `headLocator.ts:29-93` |
| Active speaker | **Local Pearson correlation of each head region's pooled motion against the audio RMS envelope**, over a ±5-frame (±1.25 s) window; needs corr ≥ 0.12 and a ≥ 0.06 margin between the two, else `null`. Gaps filled by the pitch→region mapping learned from the AV series. | `activeSpeaker.ts:76-149` |
| Commit gate | State machine: a new region must hold **0.8 s** before the crop moves; hold through silence for **1.5 s**; reset per shot. | `debounce.ts:13-14, 28-75` |
| Window placement | Clamp the chosen x so a **fixed 9:16** window fits inside the source frame. | `cropProcessor.ts:70-74` |
| Smoothing | Per shot: **3-tap median**, then a **zero-phase Gaussian, σ = 1.2 s** (4.8 samples at 4 fps, ±15-sample kernel). Segments never blend across a detected cut. | `smoother.ts:18-45`, `cropProcessor.ts:225`, `dsp.ts:250-275` |
| Delivery | JSON `{keyframes:[{t,x}]}` at `crop/{videoId}.json`, public URL as `segment.crop_url`. | `runCropAnalysis.ts:120-126`, `buildPlayerConfig.ts:557` |
| Player | Binary-search + linear interpolate the track at `video.currentTime`, then a **causal EMA (α = 0.06 per rAF)**, then `object-fit: cover` + `object-position: P% 50%`. **Portrait containers only.** | `useCropOverlay.ts:31-40, 150-166` |
| **Export** | **The crop never reaches the export.** `services/export/**`'s `crop`/`cropFrac` is the *image* crop (`image_files.crop_x/y/w/h`, `exportPlan.ts:490`). Grep for `crop_url`/`crop_key` finds no reference under `services/export/`. Exports are landscape only. | — |

Two other consumers are disabled or absent: crop is **switched off entirely in branching projects**
(`HLSPlayerShell.tsx:195-198` passes `[]`), and the **b-roll overlay elements keep `object-contain`**
(`HLSPlayerShell.tsx:494, 508`) while the main video is switched to `cover` — so in portrait a b-roll
cut-in letterboxes mid-playback and then snaps back.

---

## 2. Findings — ranked, labelled

### P0 / BUG-1 — A two-shot with no usable audio is cropped **exactly between** the two people
`cropProcessor.ts:175` gates the whole two-shot path on `hm.isTwoShot && hasAudio && f1-f0 >= 4`.
When it fails, `hm.heads.length === 2`, so the `=== 1` branch at `:213` is skipped and control lands
on the interest-centroid fallback at `:219-222`. The centroid of a bimodal profile is the **valley
between the modes**.

Measured on a synthetic two-face frame through the real `SceneAnalyzer`:
`interestX = 0.503` for faces at 0.295 / 0.705. Both people are cut in half for the entire video —
the exact failure the feature exists to prevent. `hasAudio` is false whenever `extractMonoPcm`
resolves empty, which it does **silently on any non-zero ffmpeg exit** (`ffmpegExtract.ts:151-162`) —
unsupported/corrupt audio codec, or a genuinely silent source.

### P0 / BUG-2 — Warm-toned set dressing is located as a person; a deep-skin-tone speaker is not
`isSkin` (`sceneAnalyzer.ts:143-151`) is the Kovač RGB rule, requiring `r > 95 && |r-g| > 15 && r>g>b`.
Skin is weighted **2.0**, the largest term in person-energy (`headLocator.ts:37`).

Measured, running the real `SceneAnalyzer` + `locateHeads` on synthetic frames:

| frame | skin px (max col) | located head(s) | two-shot? |
|---|---|---|---|
| light-skin face @0.30 | 51 | `[0.295]` | no |
| **deep-skin-tone face @0.30** (rgb 85,55,42) | **0** | `[0.274]` | no |
| **deep-skin face @0.30 + wooden panel @0.75** | 67 (**all panel**) | **`[0.747]` — the panel** | no |
| light-skin face @0.30 + wooden panel @0.75 | 67 | `[0.295, 0.758]` | **false two-shot** |
| slide, two bright text blocks, no skin | 0 | `[0.305, 0.811]` | **false two-shot** |

Two distinct defects, both reproduced:
1. The rule scores **zero** on a deep skin tone under normal exposure, so those speakers are located
   by saliency/motion alone — and lose outright to any warm-toned object in frame.
2. Any wood panel, brick wall, tan couch, or warm lamp is a "person". With one real speaker it
   produces a **false two-shot**, after which the AV correlator spends the video deciding whether the
   furniture is talking.

*Caveat, stated honestly:* these are flat-colour synthetic blobs. Real footage has texture and
gradients that change both profiles. The **mechanism** is demonstrated; the **rate** is not. See
Measurement M1.

### P0 / BUG-3 — The smoother cannot deliver a normal conversational turn
Measured end-to-end through the real `applyDebounce` + `smoothKeyframes(…, 1.2, 0.25)`, heads at
0.30/0.70, 1920×1080 (9:16 window half-width = 0.1582 = **304 px**):

| turn length | peak crop x | miss vs the speaker's head | is the speaker in the window? |
|---|---|---|---|
| 1.0 s | 0.300 | 0.400 (768 px) | no — debounce suppressed the switch (correct) |
| **1.5 s** | 0.487 | 0.213 (**409 px**) | **NO — off-screen** |
| **2.0 s** | 0.538 | 0.162 (**312 px**) | **NO — off-screen** |
| 2.5 s | 0.581 | 0.119 (229 px) | yes, 75% to the edge |
| 3.0 s | 0.615 | 0.085 (163 px) | yes, 54% to the edge |
| 4.0 s | 0.662 | 0.038 (74 px) | yes |
| 6.0 s | 0.695 | 0.005 (9 px) | yes |

There is a **dead band from ~1.2 s to ~2.5 s** in which the debounce lets the switch through but the
Gaussian cannot carry it: the crop leaves the person who *was* talking, arrives on **nobody**, and
comes back. That is strictly worse than not switching. Conversational turns of 1.5–2.5 s
("yeah" / "right" / a one-line answer) are the single most common turn length in a two-host podcast.

Step response of the same filter chain (switch committed at t=0):

| offset | % of the way to the new speaker |
|---|---|
| −2.4 s | 2.3% |
| −1.2 s | 17.4% |
| 0 s | 54.1% |
| +1.2 s | 87.5% |
| +2.4 s | 98.7% |

Because the Gaussian is **zero-phase** (applied offline over the whole series), the motion is
**anticipatory**: the crop has already travelled ~22% off the current speaker *at the instant the
next person opens their mouth* (the debounce puts the step 1.0 s after speech onset, and the kernel
reaches 17% at −1.2 s from the step). It then needs ~3.4 s from speech onset to settle, plus the
player's EMA. Visually this reads as the camera drifting away from whoever is talking — which is
exactly the "cheap" tell.

### P0 / BUG-4 — The player pans across every hard cut, undoing the backend's reset
The backend does the right thing: `smoothKeyframes` segments on `shotTimes` and never blends across a
boundary (`smoother.ts:31-42`), and `new DebounceState()` per shot (`cropProcessor.ts:190`).
**The player throws that away.** `useCropOverlay.ts:153` runs `smoothX += (target - smoothX) * 0.06`
per requestAnimationFrame, with **no knowledge of shot boundaries**. Measured settling of that EMA:

| display | τ | 95% settle |
|---|---|---|
| 60 Hz | 0.28 s | **0.85 s** |
| 120 Hz | 0.14 s | 0.42 s |
| 30 Hz (throttled tab / low-power) | 0.57 s | **1.70 s** |

So a backend keyframe **step** at a cut is rendered as an **0.85–1.7 s pan across the cut**. Panning
across a hard cut is the single most recognisable "this was done by a script" artifact. Additionally
`lookupCropX` linearly interpolates between the two keyframes straddling the boundary
(`useCropOverlay.ts:36-39`), adding another 0.25 s ramp before the EMA even sees it.

Two sub-defects in the same eight lines:
- **The smoothing constant is frame-rate dependent.** α is per rAF, so the same video crops with 4×
  more lag on a 30 Hz throttled tab than on a 120 Hz phone. Nothing normalises by `deltaTime`.
- `smoothX.current = 0.5` on every segment change (`useCropOverlay.ts:122`) means the first ~0.85 s
  of **every segment** is a visible pan from dead centre onto the subject.

### P1 / BUG-5 — A/B-cam cuts on the same set are invisible to the cut detector
Shot detection is a **32-bin grayscale-luma histogram** with Bhattacharyya > 0.30
(`cropProcessor.ts:40-41, 123-127`). Two camera angles of the same lit set have near-identical luma
distributions. This product's most common edit — the A-cam/B-cam angle change — is therefore the cut
most likely to be **missed**. Consequences when missed: the two angles' head positions are summed
into one profile (smearing or falsely splitting the heads), the debounce does not reset, and the
smoother pans across the cut.

The converse also holds: a lighting change, a slide transition, or a flash inside a continuous take
exceeds 0.30 and creates a **spurious** cut, which re-localises heads from a ≥0.5 s fragment and
hard-resets the smoother — an abrupt jump. I cannot quantify either rate from the repo. See M2.

### P1 / BUG-6 — A single speaker who moves is not followed at all within a shot
`cropProcessor.ts:213-218`: when `locateHeads` returns one head, **every frame of that shot gets the
same constant x** (`const cx = hm.heads[0]` — the time-average of the whole shot). The comment says
this was a deliberate fix for `backend-107` (the per-frame centroid "lands in dead space").

The 9:16 window is only **31.6%** of a 16:9 frame's width. A speaker who shifts by more than ~0.16 of
frame width (≈300 px on 1920 — a lean, a chair swivel, standing up, moving to a whiteboard) during
one continuous take **walks out of the crop window and stays out** until the next detected cut.
Given BUG-5, "the next detected cut" may be never.

Net effect: the two most common single-speaker cases are both wrong in opposite directions — a static
speaker is fine; a moving speaker is abandoned.

### P1 / BUG-7 — Non-16:9 sources are mis-registered against the HLS stream
`HLSTranscoder.ts:175` renders every tier as
`scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2`, and **all four tiers
are 16:9** (`HLSTranscoder.ts:30-33`). So a non-16:9 source gets **black bars baked into the
playback stream**. But `crop_x` was computed against the **un-padded original** (`probeVideo`'s
`width`/`height`), and the player applies it as a fraction of the **padded** frame
(`useCropOverlay.ts:53-58`, using `videoWidth`/`videoHeight` of the HLS stream).

For a 4:3 source (a very common Zoom/webcam recording), pillars occupy 12.5% each side.
`crop_x = 0.2` should map to `0.125 + 0.2×0.75 = 0.275`; the player places it at 0.200. The error is
**0.075 of frame width = 144 px on 1920**, roughly half the window's half-width — and the resulting
window `[0.042, 0.358]` contains ~8 percentage points of **pure black pillar**.

The same math means the crop is *correct* when the player falls back to `fallback_url` (the original
file), so the crop's correctness silently depends on which source the player chose.

Related, smaller: `probeVideo` reads `width`/`height` but never SAR/DAR, so anamorphic sources get the
wrong window-width fraction in `interestToCropX` (`cropProcessor.ts:70-74`). Head *positions* survive
(the squeeze is a linear map) — only the clamp is wrong.

### P1 / BUG-8 — The garbage frame at every cut is given authority over the whole shot
`prevGray` is assigned unconditionally at `cropProcessor.ts:139` and is **never reset at a shot
boundary**. The first frame of every new shot therefore has its motion computed as a difference
against the *last frame of the previous shot* — a full-width, content-free spike.

That spike is (a) summed into the new shot's `actS` head profile (`cropProcessor.ts:169-172`),
(b) injected into `regionMotionSeries` for both regions, corrupting the Pearson correlation for the
first ±5 frames (±1.25 s) of the shot, and (c) landed on by the debounce, which at
`debounce.ts:49-54` commits the **first** labelled frame of a shot **immediately, with no 0.8 s
hold** (`currentSpeaker === null`). So the least reliable frame in each shot dictates the crop for up
to 0.8 s. For a 2 s shot that spike is 12.5% of the shot's entire motion evidence.

### P1 / BUG-9 — No heartbeat on the crop claim; a long crop analyses itself twice
`runCropAnalysis.ts:79-97` sets `crop_updated_at` **once**, at claim time, and never refreshes it.
`STALE_CLAIM_MS = 20 min` (`:40`), and pg-boss `expireInSeconds = 30 min` (`pgBoss.ts:33`), which
does not kill the running ffmpeg. So **any crop whose wall clock exceeds 20 minutes has a
re-claimable claim**, and at 30 minutes pg-boss retries it — the retry sees a stale claim, wins it,
and a second full analysis of the same file starts on the same 2 vCPUs while the first is still
running. This is a positive feedback loop into LIMIT-1 and LIMIT-2 below. The export path has a
heartbeat for exactly this reason (see the comment at `pgBoss.ts:29-31`); crop has none.

### P1 / LIMIT-1 — Two crops saturate the *global* ffmpeg limiter; this is what breaks first
`ffmpegLimit.ts:8` caps **all** ffmpeg/ffprobe across the process at `FFMPEG_CONCURRENCY` (default
**2**). `pgBossDriver.ts:17-19` sets `QUEUE_CROP_CONCURRENCY` default **2**. Crop wraps
`streamRgbFrames` in `runFfmpegLimited` (`cropProcessor.ts:111`), and because `onFrame` runs
synchronously inside the stdout handler, **the slot is held for the entire analysis**, ffmpeg time
and JS time together.

So **two concurrent crop jobs take both global ffmpeg slots in the worker process for the full
duration of both analyses**, and every `project_export` assembly, `transcode`, and `captions` job
queues behind them. The comment justifying `QUEUE_CROP_CONCURRENCY=2` — *"A crop is I/O-bound and two
of them interleave happily"* (`pgBossDriver.ts:24`) — is **factually wrong**: the measurements below
show crop is ~95% CPU (h.264 decode) and the remainder is synchronous JS on the single event loop.

**Scale at which this breaks: two uploads within one crop-duration of each other.** Given the
estimates in §3, a 30-minute source is ~4–12 minutes of crop on the prod host, so *one user uploading
a two-part episode* is enough to block exports for ~10 minutes.

### P1 / LIMIT-2 — The audio path buffers the whole track three times over
`extractMonoPcm` (`ffmpegExtract.ts:141-169`) accumulates every stdout chunk, `Buffer.concat`s them,
then expands Int16 → Float32. For a 1-hour source at 16 kHz mono:

| live at peak | size |
|---|---|
| `chunks[]` (still in scope) | 115 MB |
| `Buffer.concat` result | 115 MB |
| output `Float32Array` | 230 MB |
| **peak** | **≈ 461 MB** |

Plus ~40 MB of retained per-frame profiles (3 × `Float64Array(96)` × 14,400 frames,
`cropProcessor.ts:99-104`). At `QUEUE_CROP_CONCURRENCY=2` that is **~1 GB** for two 1-hour crops.
The `worker` service in `deploy/docker-compose.yml:62-85` has **no `mem_limit` and no `cpus`**. This
is precisely the shape of the 2026-08-13 kernel-OOM incident referenced at `pgBoss.ts:17-20`.

The file header at `ffmpegExtract.ts:11-16` proudly documents that whole-stream buffering was removed
for **video** (perf-001/perf-009) — while the audio path, which is 10× larger, still does it.

### P2 / BUG-10 — Nothing bounds a crop's wall clock
`grep -n "setTimeout\|AbortSignal\|timeout" services/crop/` → **zero hits**. No wall-clock cap, no
`AbortSignal` plumbed into `runFfmpegLimited` (the limiter supports one — `ffmpegLimit.ts:79`), no
free-space preflight (the export path does `statfs(tmpdir())` at `ProjectExportService.ts:746`; crop
downloads the whole source to `tmpdir()` at `runCropAnalysis.ts:103-111` with no check). A hung
ffmpeg holds a global slot forever; only a process restart clears it (`server.ts:132-141`).

### P2 / BUG-11 — Two head windows overlap on a tight two-shot, guaranteeing "can't tell"
`regionMotionSeries` pools **±0.13 of frame width** around each head (`activeSpeaker.ts:23`) =
±12 of 96 columns, i.e. a 25-column window each. `MIN_SEPARATION` only requires the heads to be
**0.20** apart (`headLocator.ts:21`) = 19 columns. **For any separation in [0.20, 0.26] the two
windows overlap** — up to 6 shared columns — so `motionL` and `motionR` are partly the same signal,
their correlations converge, `|cL − cR| < 0.06` (`activeSpeaker.ts:105`), and the detector returns
`null` for the whole shot. The result falls to the gender gap-filler, or holds. Tight two-shots — the
framing most in need of this feature — are the ones it refuses to answer for.

### P2 / LIMIT-3 — 4 fps is below what the claimed mechanism needs
The design doc and `activeSpeaker.ts:1-19` claim the SyncNet/TalkNet signal: mouth motion correlated
with the audio envelope. That signal lives at the **syllable rate, ~4–8 Hz**, and those detectors
sample at 25 fps. At **4 fps** the frame difference is between images 250 ms apart, and the audio
"envelope" is one RMS value per 250 ms. What is actually being correlated is *"which head moved at
all during the loud quarter-seconds"* — gross head/body motion, not lip sync. A listener who nods
emphatically beats a still speaker. This is a **substantive overclaim in the documentation**, not
just a tuning choice, and it is the reason the hardest case (two same-gender hosts, one animated
listener) is unlikely to work as advertised. See M3.

### P2 / COST-1 — The keyframe track is 4× larger than the smoother can justify
4 keyframes/s survive to the output (`cropProcessor.ts:211`, `smoother.ts:44`). A 1-hour video →
14,400 keyframes ≈ **360 KB of JSON**, fetched in full by the player at segment start
(`useCropOverlay.ts:114-117`). After a σ = 1.2 s Gaussian the signal contains nothing above ~0.4 Hz;
1 keyframe/s is ~4× oversampled already. Whether it is served gzipped depends on the storage
adapter's response headers, which I could not determine from the repo.

### P3 / dead code and dead knobs
- `speaker.ts:85-156` — `CalFrame`, `SpeakerCalibration`, `speakerFaceX`, `calibrate`: **entirely
  unreferenced.** Superseded by `calibrateGenderRegion` in `activeSpeaker.ts`. ~70 lines.
- `headLocator.ts:96-108` — `activeHeadIndex`: exported, never called.
- `processVideoCrop` has exactly one caller, with **no options** (`runCropAnalysis.ts:114`), so
  `faceHook`, `sampleInterval`, and `onProgress` (`cropProcessor.ts:64-68`) are all dead — including
  the `FaceHook` extension point the design doc offers as the upgrade path, and
  `addColumnGaussian` (`sceneAnalyzer.ts:155`) which only runs for `faceXs`. **There is no progress
  reporting for a crop job at all.**
- `crop_aspect` is written into the JSON (`cropProcessor.ts:232`) and **never read by the player**.

### P3 — documentation drift in `references/crop-processor/PIPELINE.md`
- `:145` says the Gaussian is **σ ≈ 1.5 s**; the call site passes **1.2** (`cropProcessor.ts:225`).
- `:70` says frames are extracted at **2 fps**; `:177` says **4 fps**; the code is 4 fps.
- `:20` describes a **"per-second"** keyframe track; it is per-quarter-second.
- `:55` says a 40 s clip takes ~2.5 s ("16× realtime"); `:178` claims **"~50× realtime end-to-end"**.
  Measured below: ~7–9 ffmpeg CPU-seconds per **video-minute** on an M4-class core.
- `:21` and `:152` describe the player as using a **`translateX` transform**; it uses
  `object-position` (the file's own header explains why the transform was abandoned).

---

## 3. Sampling rate vs cost — measured

**Method.** (a) The JS inner loop of pass 1 driven directly through the repo's real `SceneAnalyzer`,
`analyzeChunk` and `bhattacharyya` over 600 synthetic 320×180 frames. (b) The exact ffmpeg command
lines the code spawns, against two 60 s 1920×1080@30 H.264 sources: a low-complexity
"talking-head-like" clip (1.36 Mbps) and a high-detail `testsrc2` (6.5 Mbps). Host: 10-core Apple
Silicon, Node v22.23.2, ffmpeg 8.x.

**JS analysis (single-threaded, per analysis frame):**

| stage | ms/frame |
|---|---|
| `toGray` | 0.100 |
| `analyze` (motion + skin + saliency FFT) | 0.829 |
| shot histogram + Bhattacharyya | 0.187 |
| pitch F0 (2× 8192-pt FFT) | 0.407 |
| **total** | **1.524** |

→ 0.37 CPU-seconds of JS per **video-minute**; ~22 CPU-s for a 1-hour video. **The JS is not the
problem.**

**ffmpeg (the `fps=4,scale=320:180,rgb24` pass — the whole file must still be decoded):**

| source | wall (auto threads) | **CPU-seconds** |
|---|---|---|
| talking-head, 1.36 Mbps | 6.4–7.0 s / 60 s | **7.3–7.4** |
| testsrc2, 6.5 Mbps | 5.0–5.6 s / 60 s | **8.8–9.0** |
| audio PCM pass | 0.3–0.4 s / 60 s | **0.2** |

**So: ≈ 7.5–9.2 CPU-seconds per video-minute, ~95% of it H.264 decode**, on an M4-class core.
A 1-hour source is **~8 CPU-minutes on this host**.

**What that means on the 2-vCPU prod box — stated as an estimate, not a measurement.** A shared cloud
vCPU is roughly 2–3× slower per core than an M-series P-core, and this host used ~10 cores where prod
has 2. Scaling gives **~16–25 CPU-minutes for a 1-hour 1080p source**, i.e. roughly **8–13 minutes of
wall clock with both cores, or 16–25 minutes with one** (the realistic case, since the API, the
worker, and any export share the box). I did not measure on the prod host — see M4.

Three consequences follow directly from those numbers:
1. A 1-hour source under contention lands **at or past the 20-minute stale-claim window** → BUG-9
   fires and the job runs twice.
2. Crop holds a global ffmpeg slot for that whole time → LIMIT-1.
3. Dropping to 2 fps would **not** halve the cost: the `fps` filter decimates *after* decode, and
   decode is 95% of it. The only real lever is decoding less — keyframe-only sampling
   (`-skip_frame nokey`), hardware decode, or a lower input resolution via `-lowres`/scaler hints.

---

## 4. Content-case matrix

| content | what the algorithm does | acceptable? |
|---|---|---|
| **Static single speaker** | `dominantColumn` → one x for the whole shot, held. | **Yes.** This is the good case. |
| **Single speaker who moves** | Same constant x = the shot's time-average. Speaker exits the 31.6%-wide window after ~0.16 of frame width of drift and stays out. (BUG-6) | **No.** |
| **Two people, long turns (>4 s)** | AV correlation → debounce → smoother. Lands within 74 px. | **Yes**, apart from the ~3.4 s settle and the anticipatory drift. |
| **Two people, normal turns (1.5–2.5 s)** | Switch commits, Gaussian delivers 32–59% of the travel, crop lands on neither face, returns. (BUG-3) | **No — this is the common case.** |
| **Speaker leaves frame and returns** | No re-detection within a shot. Heads are fixed for the shot from summed profiles; a departure just removes their motion, so AV goes `null` and the debounce **holds on the empty chair**. On return, nothing changes. | **No.** |
| **Hard cut between scenes** | Backend resets correctly; **player pans across it over 0.85–1.7 s**. (BUG-4) And an A/B-cam cut is likely not detected at all. (BUG-5) | **No.** |
| **Simulation / screen-share, no face** | Sims are iframe overlays over a still-playing video, so they are fine. A **recorded screen-share inside the main video** is not: skin ≈ 0, so `dominantColumn` argmaxes saliency+motion → the cursor, or the highest-contrast column. Measured: two bright blocks on a dark slide produce a **false two-shot** at `[0.305, 0.811]`, after which the crop switches between two parts of the slide in time with the audio. | **No.** |
| **Text / slides that must not be cut** | A 31.6%-wide vertical strip of a slide. There is **no** "do not crop this" signal, no per-segment opt-out, no text detection. | **No.** |
| **Letterboxed (2.39:1)** | Horizontal geometry survives. The face band 8–78% of *coded* height is mis-centred over the picture, degrading motion/skin. | **Marginal.** |
| **Pillarboxed / 4:3 source** | HLS pads to 16:9; the player applies an un-padded `crop_x` to a padded frame → 144 px offset and black bars inside the portrait window. (BUG-7) | **No.** |
| **Anamorphic** | SAR ignored; head positions survive, the clamp width is wrong. | **Marginal.** |
| **Deep skin tone + warm set** | Measured: the crop locks onto the wooden panel. (BUG-2) | **No.** |
| **Branching project** | Crop disabled entirely (`HLSPlayerShell.tsx:195-198`). | Deliberate; portrait viewers get letterbox. |
| **B-roll cut-in, portrait** | Main video `cover`, b-roll `contain` → letterbox flash mid-playback. | **No.** |

---

## 5. Failure and fallback

- **No subject found** — `dominantColumn` returns −1 only if the search range is empty; otherwise it
  always returns *something*. There is no "I don't know" state and no confidence output. The crop is
  always emitted, always marked `ready`.
- **Analysis times out** — it cannot; there is no timeout (BUG-10). A hang holds a global ffmpeg slot
  until the process restarts.
- **Analysis throws** — `crop_status='failed'`, `crop_url` null, player leaves `object-contain`. In
  portrait that is a **letterboxed** video, not a centre crop. If the crop *is* ready but the JSON
  fetch fails, `useCropOverlay.ts:117` leaves `[]` → `lookupCropX` returns 0.5 → a **centre crop with
  `cover`**. So the two adjacent failure modes produce two visually different products.
- **Is a bad automatic crop ever shipped without a human seeing it?** **Yes, always.** There is no
  quality gate before `crop_status → 'ready'` (`runCropAnalysis.ts:124-126`) — any keyframes array,
  including one that sits on a wooden panel for an hour, is published. `crop_url` then flows straight
  into every public share link and playlist via `buildPlayerConfig.ts:557`. The only UI is a status
  line and a "Re-crop" button (`ProjectSettingsPanel.tsx:317-325`) — **no preview of the crop track,
  no way to scrub it, no manual override.** `video_files` has no manual-crop column
  (`schema.ts:424-429`: only `crop_status`, `crop_key`, `crop_source_hash`, `crop_error`,
  `crop_updated_at`). Re-crop is the only remedy, and it is deterministic — it produces the same
  wrong answer.
- **Observability** — `stats` (`cropProcessor.ts:234-244`) reports frame counts and the **last**
  two-shot segment's heads. There is no per-shot record, no confidence, and no count of frames that
  fell back to a static column or to the centroid. From the stored metadata you **cannot tell whether
  a given video got a good crop**.

---

## 6. Verdict

**Visibly wrong on common content.** Not "close to perfect with rough edges" — the two most frequent
things in this product's footage each hit a defect that a viewer will notice within seconds:

1. A **1.5–2.5 second conversational turn** moves the crop to a position where **neither speaker is in
   frame**, then moves it back (measured: 312–409 px of miss against a 304 px half-window).
2. Every **hard cut** is rendered as a **0.85–1.7 second pan across the cut** by the player's EMA,
   which discards the correct reset the backend computed.

Underneath those, a **single moving speaker is not tracked at all** within a shot, and a warm-toned
set element can capture the crop for the entire video.

**The two changes that would most improve it, in order:**

1. **Fix the temporal response, on both sides of the wire.** Replace the offline zero-phase
   σ = 1.2 s Gaussian with a rate-limited/critically-damped move — a slew limit (e.g. ≤ 0.25 of frame
   width per second) plus a short median — so a committed switch *arrives*, and make the player's
   smoothing **delta-time-normalised and shot-aware** (snap, don't ease, when the incoming keyframe
   pair straddles a shot boundary; publish the shot boundaries in the JSON so the player can). This
   single change fixes BUG-3, BUG-4 and the frame-rate dependence, and needs no new vision work.
2. **Replace the skin-tone heuristic with an actual face/person detector** behind the `FaceHook`
   interface that already exists (`sceneAnalyzer.ts:35`) — a small ONNX/tfjs face detector run at
   1–2 fps costs far less than the H.264 decode already being paid. This fixes BUG-2 (both halves),
   BUG-6 (a real per-frame track instead of one static column), most of the slide/screen-share case,
   and removes the false-two-shot gate entirely.

Nothing else on the list is close to these two in visible impact per unit of work.

---

## 7. What I could not determine from the repo

| # | Question | Measurement that would settle it |
|---|---|---|
| **M1** | How often does `isSkin` actually pick set dressing over a face, and how badly does it fail across skin tones, on **real** frames? | Run `SceneAnalyzer.analyze` + `locateHeads` over ~200 hand-labelled frames sampled from real customer videos, spanning skin tones and set types; report located-head error in frame-width units against the labelled face centre. |
| **M2** | Does the Bhattacharyya-0.30 luma cut detector find A/B-cam angle changes, and how often does it fire spuriously? | On a real multi-cam episode with a known cut list, dump the per-frame Bhattacharyya series and plot the distribution at true cuts vs. within-take. If the two distributions overlap at 0.30, the detector needs a different feature, not a different threshold. |
| **M3** | Does the AV correlation at 4 fps actually identify the speaker, or only "who moved"? | Re-run `windowedActiveRegions` at 4 / 12.5 / 25 fps on the same clip and score per-frame active-region agreement against hand labels. If 25 fps is materially better, 4 fps is a correctness choice, not a cost choice. |
| **M4** | What does a crop actually cost on the 2-vCPU prod host? | `/usr/bin/time -v` around one `runCropAnalysis` for a known-duration source on the prod worker, plus `docker stats` peak RSS. Two numbers needed: CPU-seconds per video-minute, and peak RSS for a 1-hour source. Everything in §3 beyond the JS figures is extrapolated from a 10-core Apple Silicon host. |
| **M5** | Is the ~360 KB keyframe JSON served compressed? | Inspect the `Content-Encoding` on a real `crop/{id}.json` response from the configured storage backend. |
| **M6** | Do real projects hit BUG-7? | `SELECT` the distribution of source `width`/`height` across `video_files`. If non-16:9 sources are rare, BUG-7 drops in priority; if Zoom/webcam 4:3 uploads are common, it rises above BUG-6. |

---

## 8. Dilemmas — NOT resolved here

These need a reviewer with deeper domain or product knowledge. Each states the problem, what I
verified, the real options, what I lean toward, and what evidence decides it.

### D-CROP-1 — What temporal law should the crop follow? (the biggest one)

**Problem.** The current filter is an offline **zero-phase Gaussian, σ = 1.2 s**
(`cropProcessor.ts:225` → `smoother.ts:28` → `dsp.ts:250`). Measured, it (a) starts moving off the
current speaker ~1.4 s *before* the next person speaks, (b) needs ~3.4 s to settle, and (c) for turns
of 1.5–2.5 s delivers only 32–59% of the travel, parking the crop on **nobody**. Under-smoothing is
not the answer either: σ is large precisely because the detector underneath is noisy, and I have no
measurement of that noise floor.

**Verified.** Full step-response and turn-response tables in §2/BUG-3, produced by running the repo's
real `applyDebounce` + `smoothKeyframes`. Player-side EMA settle times in BUG-4.

**Options.**
- **(a) Same Gaussian, smaller σ (~0.4 s).** One constant, zero structural change. But short turns
  become whip-pans and every bit of detector jitter comes through. Cheap to try, cheap to revert.
- **(b) Slew-rate limiter + short median.** Replace "blur the trajectory" with "the camera may move
  at most V frame-widths/second". Committed moves always *arrive*; never anticipates. Costs one
  constant (V) chosen by eye, and constant-velocity ramps can read as mechanical.
- **(c) Critically-damped second-order filter (spring), tuned to a settle-time target.** Eases in and
  out like a real operator and always arrives. Two constants, and overshoot must be pinned to zero.
- **(d) Change the *decision*, not the filter: raise the commit threshold so short turns never move
  the crop at all**, holding on the previous speaker. Pairs with (b) or (c).

**What I lean toward.** **(d) + (b).** The measurements say the failure is not "too much smoothing" in
the abstract — it is that a move is *ordered* which the filter cannot *deliver*. Making the decision
layer refuse moves it cannot complete, and the filter layer complete every move it is given, fixes
the artifact from both ends. (a) alone trades one visible defect for another.

**What decides it.** An editorial call the owner has to make and cannot be derived from the code:
**for a 2-second interjection, should the frame stay on the previous speaker, whip to the new one, or
pull wide?** Cut the same 60 s two-host clip four ways — current, (a), (b)+(d), (c)+(d) — and have the
owner pick. That is one afternoon and it settles the largest quality question in this subsystem.

### D-CROP-2 — Is 4 fps a cost decision or a correctness decision?

**Problem.** `activeSpeaker.ts:1-19` and `PIPELINE.md:106-116` claim the SyncNet/TalkNet mechanism —
mouth motion correlated with the audio envelope. That signal lives at the syllable rate (~4–8 Hz) and
those detectors sample at 25 fps. At **4 fps** what is actually correlated is gross head/body motion
against a 250 ms RMS. If that is why the two-shot case is unreliable, the fix is sampling, not tuning.

**Verified.** The sample rate (`cropProcessor.ts:37`), the ±5-frame correlation window
(`activeSpeaker.ts:33`), and — importantly — that **raising the rate is nearly free**: measured, the
`fps` filter decimates *after* decode and decode is ~95% of the cost, so going 4 → 12.5 fps raises
CPU by roughly **10%** (7.9 → 8.7 CPU-s per video-minute), not 3×.

**Options.** (i) Leave it and treat the doc's claim as marketing. (ii) Raise the *analysis* rate to
12.5 fps and decimate the *output* keyframes to 1/s (which also fixes COST-1). (iii) Raise it only
inside detected two-shots, keeping 4 fps elsewhere — more code, less cost.

**What I lean toward.** **(ii)**, conditional on the measurement below. A 10% CPU increase to make the
headline mechanism actually work is obviously worth it — *if* it works. But retained profile memory
goes 40 MB → 125 MB per 1-hour job, which interacts badly with LIMIT-2 on a box that has already been
OOM-killed once, so this cannot be turned up without fixing the audio buffering first.

**What decides it.** **M3**: re-run `windowedActiveRegions` at 4 / 12.5 / 25 fps on the same clip and
score per-frame active-region agreement against hand labels. If 12.5 fps is not materially better,
the AV mechanism is not the weak link and D-CROP-3 becomes the only lever.

### D-CROP-3 — Heuristic person-finding, or a real detector?

**Problem.** Subject location rests on a 1990s RGB skin-tone rule (`sceneAnalyzer.ts:143-151`) weighted
2.0 — the dominant term. Measured, it scores **zero** on a deep skin tone and **higher than a face**
on a wooden panel, which is enough to point the crop at furniture for an entire video and to
manufacture false two-shots on slides.

**Verified.** The measurement table in §2/BUG-2. Also that the `FaceHook` upgrade path already exists
(`sceneAnalyzer.ts:35`, `cropProcessor.ts:65`) and is **dead** — no caller ever passes it.

**Options.**
- **(a) Keep dependency-free; tune the heuristic** (better colour space, chroma gating, spatial
  compactness prior). Cheap and safe to deploy. But the measured failures are *structural* — "wood is
  skin" is not a threshold problem — so this buys a partial improvement at best.
- **(b) Small ONNX face detector (YuNet / BlazeFace class) at 1–2 fps behind `FaceHook`.** Decisively
  fixes location, and at 1–2 fps costs far less than the H.264 decode already being paid. Adds a
  native dependency and model weights to the image, and ~50–200 MB RSS.
- **(c) (b), but only in the `worker` image**, so the native dep never lands in the request-serving
  API container. Crop already runs only in the worker under `QUEUE_DRIVER=pgboss`.

**What I lean toward.** **(c)**, running the detector only for *head localization* (once per shot,
1–2 fps), leaving the AV correlation, debounce and smoothing untouched — which is exactly the seam
`FaceHook` was designed for. That fixes BUG-2 both ways, most of the slide case, and unblocks BUG-6
(a real per-frame track instead of one static column per shot).

**What decides it.** Two things. **M1** sizes the prize (how often is the heuristic actually wrong on
real footage — if it is 2%, spend the effort elsewhere; if it is 20%, nothing else matters). And a
**product/ops call the owner owns**: is a native model dependency acceptable on this 2-vCPU box, or is
dependency-free a hard constraint? `PIPELINE.md:41-45` says the port went dependency-free because the
*old* managed host was Node-only — that constraint no longer holds (it is Docker now), so the
constraint may be stale rather than real.

### D-CROP-4 — Should the crop reach the export at all?

**Problem.** The crop is **player-only**: it is applied as CSS `object-position` in portrait
containers and never touches `services/export/**`. Exports are landscape.

**Verified.** No reference to `crop_url`/`crop_key` anywhere under `services/export/`; the `crop` in
`exportPlan.ts:490` / `ffmpegGraph.ts:265-272` is the *image* crop.

**Options.** (i) Keep it player-only. (ii) Add a vertical export deliverable (Shorts/Reels/TikTok)
driven by the same keyframe track.

**Why this is a dilemma and not a finding.** It **reorders the entire list**. Player-only means a bad
crop is escapable — the viewer rotates the phone and gets the letterboxed original — and BUG-7's
padding mis-registration can be fixed **entirely in the player** for a few lines. A vertical *export*
is a permanent, un-escapable artifact, which raises the quality bar to where D-CROP-1 and D-CROP-3
become blocking rather than improvements, and adds a new ffmpeg render path on a host whose export
capture is already ~10× too slow.

**What I lean toward.** Ask before doing anything else in this subsystem. If vertical export is not on
the roadmap, I would fix D-CROP-1 and BUG-7 in the player and stop. If it is, D-CROP-3 becomes
mandatory first.

**What decides it.** Purely a product decision. No amount of code reading answers it.

### D-CROP-5 — What should happen to content that must not be cropped?

**Problem.** Slides, screen-share and any text-bearing frame are cropped to a 31.6%-wide vertical
strip that cuts the text. Measured, a slide with two bright blocks is even classified as a **two-shot**
and the crop then switches between two parts of the slide in time with the audio. There is no
detection, no per-segment opt-out, and no "don't crop" signal anywhere in the schema.

**Options.** (a) **Detect it** (low skin + high edge/text density + low motion diversity) and fall back
to letterbox for those shots. (b) **Let the user mark it** — a per-section/per-video boolean. (c) Do
nothing.

**What I lean toward.** **(b) first, (a) later.** (b) is a small schema + UI change, is never wrong,
and gives the owner an escape hatch today. (a) is another classifier with its own false-positive
mode — falsely calling a real speaker "a slide" letterboxes footage that cropped fine, which is a new
defect traded for an old one.

**What decides it.** How much of the corpus this actually is: a query over section/segment types and a
sample of main-video content for screen-share. If it is rare, (b) alone is the whole answer.

### D-CROP-6 — Is `QUEUE_CROP_CONCURRENCY = 2` defensible?

**Problem.** `pgBossDriver.ts:17-19` runs two crops at once, justified by the comment at `:24`:
*"A crop is I/O-bound and two of them interleave happily."* Measured, crop is **~95% CPU** (H.264
decode) with the rest synchronous JS on one event loop. Two crops take **both** global ffmpeg slots
(`ffmpegLimit.ts:8`, default 2) for the full duration, queueing every export assembly, transcode and
caption job behind them — on a 2-vCPU box with no `cpus`/`mem_limit` on the worker service.

**Options.** (a) Drop to 1. (b) Keep 2 and raise `FFMPEG_CONCURRENCY` (worse — deeper oversubscription
on 2 cores). (c) Keep 2 but give crop a lower-priority lane so exports pre-empt it. (d) Keep 2 and
accept it, on the grounds that crop is background work nobody is waiting on.

**What I lean toward.** **(a)**, and rewrite the comment — the premise it rests on is measurably false.
But this is a real **throughput-vs-latency trade the owner should own**: dropping to 1 halves the
collateral damage to exports and doubles the queue latency when two videos land together.

**What decides it.** **M4** (real CPU-seconds and peak RSS on the prod host) plus the actual arrival
distribution of uploads. If uploads essentially never overlap, the setting is moot and (d) is fine;
if they arrive in bursts (a user uploading a multi-part episode), (a) is clearly right.

### D-CROP-7 — Should a crop ever go live without a human seeing it?

**Problem.** Today it always does. There is no quality gate before `crop_status → 'ready'`, no preview
of the crop track in the UI, no manual override column, and no stored signal from which badness could
even be inferred. "Re-crop" is the only remedy and it is deterministic — it reproduces the same wrong
answer.

**Options.** (a) Keep auto-publish. (b) Auto-publish, but store a **confidence/coverage signal** and
show a scrubbable preview strip so the owner can spot-check. (c) Require approval before `crop_url` is
served.

**What I lean toward.** **(b)**. (c) destroys the "it just lights up in the background" property the
whole design is built on, which is probably wrong for self-serve. But (b) has a hidden cost: it needs
a confidence metric that does not exist, and **inventing one that actually correlates with badness is
itself a research task**. The cheapest honest candidate from what is already computed is coverage-
based — fraction of frames decided by AV vs. gender-filled vs. held vs. static-column, plus head-
position variance across shots — but I have no evidence it correlates with "looks wrong".

**What decides it.** Label ~50 real videos "good crop / bad crop" by eye, then check whether any
candidate metric separates them. If nothing separates them, (b) collapses into "just show a preview",
which is still worth doing and is the cheap half of the work.
