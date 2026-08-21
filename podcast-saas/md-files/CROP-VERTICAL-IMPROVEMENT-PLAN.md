# Vertical-Crop Pipeline Upgrade — Research-Backed Task Plan

**Status:** proposed · **Owner ask:** "an exact, high-quality algorithm" for the smart 16:9 → 9:16 crop
**Scope:** `backend-api/src/services/crop/*`, `client-web/components/viewer/useCropOverlay.ts`, plus a new eval harness
**Date:** 2026-08-20 · All file:line citations verified against the working tree on this date.

---

## 1. Executive summary

**What runs today.** The crop job downloads the raw source, makes one streamed 320×180 @ 4 fps video decode and one buffered 16 kHz mono audio decode (`ffmpegExtract.ts`), and computes — with zero ML anywhere — per-frame column profiles of frame-diff motion, Kovač RGB skin pixels, and spectral-residual saliency (`sceneAnalyzer.ts`); detects shot cuts by global 32-bin gray-histogram Bhattacharyya > 0.30 (`cropProcessor.ts:122-128`); per shot, peak-picks ≤2 "heads" from summed profiles with fixed side-bands and a valley test (`headLocator.ts`); attributes speech in two-shots by Pearson correlation of ±12-column motion vs the audio RMS envelope over an 11-frame window, gap-filled by a pitch-derived gender→region map (`activeSpeaker.ts`, `speaker.ts`); debounces switches (0.8 s commit / 1.5 s silence hold, `debounce.ts`); and smooths per shot with median-3 + Gaussian σ = 1.2 s (`smoother.ts`), emitting a public JSON keyframe track `{t, x}` at 4 Hz that the viewer applies client-side via `object-position` in portrait only (`useCropOverlay.ts`). The engineering shell — streaming extraction, per-shot scoping, CAS-claimed idempotent jobs — is production-grade and is kept.

**Top 3 defects** (full ranking in §3):

1. **The only person detector is a skin-color pixel rule** (`sceneAnalyzer.ts:143-151`) weighted highest everywhere downstream — it deterministically misses darker skin and cool/dim lighting, and fires on wood, brick, and beige walls, so the crop systematically frames furniture or the wrong guest, per set and per person.
2. **Active-speaker attribution operates at the statistical noise floor** — the AV gate (`minCorr 0.12`, `margin 0.06` on n = 11 samples whose null SD is ≈ 0.32, `activeSpeaker.ts:33-35`) is a coin flip, and its gender→region gap-fill **routes all speech to one head on same-gender shows** (the dominant podcast format), because pitch calibration correctly refuses to split same-gender voices (`speaker.ts:79`) and `calibrateGenderRegion` then maps the single label to one region and infers the other as complement (`activeSpeaker.ts:146-149`).
3. **Quality is unmeasurable and improvements cannot ship**: a wrong crop is `crop_status='ready'` like a right one; the idempotency hash `sha256(storage_key|size|duration)[:16]` (`runCropAnalysis.ts:28-33`) carries no algorithm version, so any fix silently never reaches existing videos; the only user control, Recrop, deterministically recomputes the same result.

**Chosen upgrade path.** Measurement first (P0): a 20–50-clip labeled eval harness (mIoU, subject-out-of-frame rate, jitter — the LIVE-YT VC / RetargetVid metric set) plus an algorithm-version field in the idempotency hash. Then zero-dependency quick wins (P1): delete the gender gap-fill, statistically defensible AV thresholds, hard-snap at speaker switches and cuts, a real center fallback, adaptive shot detection. Then the step-change (P2): **YuNet face detection** (opencv_zoo, 337 KB ONNX, MIT, ~1.6 ms @ 320×320 on desktop CPU) run **sparsely at 2 Hz** on the already-streamed 320×180 frames via `onnxruntime-node`, SORT-lite IoU tracks with per-shot resets, **mouth-ROI lip-activity vs audio-envelope correlation** (the Hershey–Movellan / SyncNet principle) for active speaker, and an AutoFlip-style per-shot camera planner (stationary-first, dead-zone hysteresis, 1-euro filter, hard cuts at switches) — all behind a `CROP_ALGO` flag with the v1 path intact for rollback.

**Expected outcome.** Detection stops being demographically and set-decor biased; two-person shows stop pinning to one host; speaker switches become cuts instead of 3-second glides through dead space; face-less shots fall back to center instead of a confident wrong crop — each claim gated by harness numbers, not vibes. Added CPU: **≈ 6–30 s per 10-minute video** on the 2-vCPU host (≈ 85–110 s total job, ~0.15–0.18× realtime, one core) — comfortably inside the 20-min stale-claim ceiling even for 1-hour episodes (§4.7).

---

## 2. The current pipeline, stage by stage

Everything below is verified against the tree. Paths are relative to `podcast-saas/`.

### 2.1 Orchestration & triggers

- Upload/replace enqueues `transcode`; `runVideoTranscode` on success enqueues captions + crop for the project **unless** the replacement media is "similar" (`backend-api/src/services/video/runVideoTranscode.ts:143-148`). Manual `POST /api/v1/projects/:id/recrop` clears `crop_source_hash`/`crop_status` then enqueues (`backend-api/src/controllers/v1/video.controller.ts:558-575`). Crop is never enqueued from reads (perf-002).
- `runCropAnalysis` (`backend-api/src/services/crop/runCropAnalysis.ts`): in-process `inFlight` set (:37); idempotency hash `sha256(storage_key|file_size|duration_sec)[:16]` (:28-33); ready+matching-hash no-op (:80); DB CAS claim flipping `crop_status→'processing'` with a 20-min stale-reclaim window (`STALE_CLAIM_MS`, :40, :87-101); source downloaded via a 3600 s presigned URL into a `crop-` tmpdir (:103-111); result JSON uploaded to `crop/<videoFileId>.json` (:120-122); failure sets `'failed'` and **clears the hash** so retries recompute (backend-104, :132-134). Row state: `crop_status/key/source_hash/error/updated_at` (`backend-api/src/db/schema.ts:425-429`).
- Queue: pg-boss `'crop'`, `singletonKey=videoFileId`, retryLimit 3 / 30 s exponential backoff / 30-min expiry / DLQ `crop-dead`; `localConcurrency = QUEUE_CROP_CONCURRENCY` (default 2) — **that same env applies to every durable queue** (`backend-api/src/queue/pgBossDriver.ts:17-18,54`). All ffmpeg/ffprobe spawns go through the global semaphore `FFMPEG_CONCURRENCY` (default 2, `backend-api/src/services/ffmpegLimit.ts:8`).

### 2.2 Extraction (`ffmpegExtract.ts`)

- Probe: `ffprobe … -show_entries stream=width,height,r_frame_rate,duration -show_entries format=duration -of json` (:31-38); fps falls back to 30 (:53).
- Video: `ffmpeg -y -i src -an -vf fps=4,scale=320:180 -pix_fmt rgb24 -f rawvideo pipe:1` (:88-96). Frames are **streamed**: stdout chunks reassembled into exact 172,800-byte frames; `onFrame` receives a transient view and runs synchronously in the `'data'` handler so the OS pipe backpressures ffmpeg (:104-116). Whole-stream buffering was deliberately removed (perf-001/perf-009; ~2.5 GB for a 60-min take) and must not return.
- Audio: `ffmpeg -y -i src -vn -ac 1 -ar 16000 -f s16le pipe:1` fully buffered → Float32 (÷32768, :129-171). Spawn error or non-zero exit logs a warning and resolves an **empty array** so crop degrades to visual-only (perf-011, :145-162).

### 2.3 Pass 1 — per-frame signals (`sceneAnalyzer.ts`, `cropProcessor.ts:111-141`)

Per 320×180 frame, restricted to a "face band" of rows 8 %–78 % (:23-24, applied :85-86):

- **motion**: per-column Σ|gray − prevGray| where diff ≥ 5 (:20, :90-98);
- **skin**: per-column count of Kovač-rule pixels `r>95 && g>40 && b>20 && max−min>15 && |r−g|>15 && r>g && r>b` (:143-151) — **the only "face" evidence in the pipeline**;
- **saliency**: 64×64 gray downsample → spectral-residual (Hou & Zhang 2007) via hand-rolled 2-D FFT, collapsed to columns (`dsp.ts:151-197`);
- **interestX**: centroid of `centerBias(σ 0.35)×0.5 + skin×1.5 + motion×0.6 + saliency×0.4` (:56-59, :123-135), plus an **unwired** `faceHook` Gaussian injection (σ 0.12, weight 2.0, :34-35, :121, :131) — `runCropAnalysis` calls `processVideoCrop` with no options, so production never uses it (verified by grep).

All profiles resampled to 96 columns (:18). Shot cuts: 32-bin global gray histogram, Bhattacharyya > 0.30, ≥ 0.5 s min gap (`cropProcessor.ts:40-42, 122-128`; `dsp.ts:292-299` returns 1 on an empty histogram). Audio per 0.25 s window: RMS + F0 via FFT autocorrelation with pre-emphasis 0.97, Hann, octave-error guard at 0.8×peak, parabolic interpolation, 70–450 Hz (`dsp.ts:77-142`, defaults :80-81; `speaker.ts:29-37`).

### 2.4 Between passes & Pass 2 (`cropProcessor.ts:145-223`)

- Pitch threshold self-calibration: 1-D k-means (k = 2, init P25/P75, ≤25 iters); accept the cluster midpoint iff clusters ≥ 35 Hz apart and midpoint ∈ [120, 220] Hz, else **160 Hz default** (`speaker.ts:55-81`; no-audio default at `cropProcessor.ts:146`). Labels: silence (RMS < 0.005), unclear (conf < 0.30 or ±10 Hz gray zone), male/female (`speaker.ts:40-48`).
- Per shot (segments from `buildFrameSegments`, :255-266), summed profiles → `locateHeads` (`headLocator.ts`): person-energy `skin×2 + sal×0.6 + motion×1.0` (:37), box-blur r=3 (:38); two-shot iff peaks in the **fixed bands cols 9–44 / 52–86** (:42-43) both ≥ 0.28×max (:20), separated ≥ 0.20 (:21), valley ≤ 0.88×weaker (:22, :56-61); else one `dominantColumn` over cols 5–90 with `skinGate = skin>0.15 ? 1 : 0.35` discounting no-skin saliency (:83-93). `heads: []` (:45) is unreachable in practice; `activeHeadIndex` (:96-108) is dead code.
- Two-shot + audio + ≥4 frames (:175): motion pooled ±12 of 96 columns per head (`activeSpeaker.ts:23, 40-54`); per frame, Pearson r of each head's motion vs audio RMS over ±5 frames; requires window audio ≥ 0.35× global mean, max corr ≥ 0.12, |cL−cR| ≥ 0.06 (:32-37, :91-109). `calibrateGenderRegion` votes gender→region from AV-resolved frames (:118-150). Decision priority per frame: **AV → gender→region gap-fill → hold** (:196-207), through the debounce (`debounce.ts`: 0.8 s commit :13, 1.5 s silence reset :14), with a **midpoint-of-heads** fallback before first commit (:210). Single located head → one static x for the shot (backend-107, :213-218). Otherwise → per-frame interest centroid (:219-222).
- Clamp: `interestToCropX` keeps the 9:16 window inside the frame — x ∈ [0.158, 0.842] at 1920×1080 (:70-74). Smoothing: per shot, median-3 then Gaussian σ = 1.2 s (= 4.8 samples, radius ⌈3σ⌉, reflect), hard reset at cuts (`smoother.ts:18-45`; σ passed at `cropProcessor.ts:225`).

### 2.5 Output & consumer

`CropMetadata {video_id, duration, width, height, crop_aspect: 0.5625, keyframes:[{t,x}] @4 Hz, stats}` → public storage key `crop/<id>.json`. `buildPlayerConfig` exposes `crop_url` when ready (`backend-api/src/services/buildPlayerConfig.ts:530-539`). The **only** consumer is `client-web/components/viewer/useCropOverlay.ts`: portrait-only, `object-fit:cover` + `object-position P% 50%`, keyframe binary-search + lerp at `currentTime`, **EMA α = 0.06 per RAF** (:153), center 0.5 fallback when metadata is missing. There is no server-side vertical render anywhere; export is hard-ruled 1920×1080 landscape and its `cropFrac` is the unrelated still-image crop.

### 2.6 Magic-constant inventory (verified)

| File | Line | Constant | Value |
|---|---|---|---|
| cropProcessor.ts | 36 | CROP_ASPECT | 9/16 |
| cropProcessor.ts | 37 | DEFAULT_SAMPLE_INTERVAL | 0.25 s (4 fps) |
| cropProcessor.ts | 38-39 | ANALYSIS_W/H | 320×180 |
| cropProcessor.ts | 40-42 | SHOT_BINS / SHOT_THRESHOLD / SHOT_MIN_GAP | 32 / 0.30 / 0.5 s |
| cropProcessor.ts | 146 | no-audio pitch threshold | 160 Hz |
| cropProcessor.ts | 175 | two-shot AV path min frames | 4 (1 s) |
| cropProcessor.ts | 225 | smoothing sigmaSec | 1.2 s |
| cropProcessor.ts | 250 | hist bin | `(v×32)>>8` |
| sceneAnalyzer.ts | 18-20 | PROFILE_COLS / SAL_SIZE / MOTION_THRESH | 96 / 64 / 5 |
| sceneAnalyzer.ts | 23-24 | BAND_TOP / BAND_BOT | 0.08 / 0.78 |
| sceneAnalyzer.ts | 56-59 | weights center/skin/motion/saliency | 0.5 / 1.5 / 0.6 / 0.4 |
| sceneAnalyzer.ts | 66 | center-bias Gaussian σ | 0.35 |
| sceneAnalyzer.ts | 78 | BT.601 luma | (77,150,29)>>8 |
| sceneAnalyzer.ts | 131 | faceHook Gaussian σ / weight | 0.12 / 2.0 (unwired) |
| sceneAnalyzer.ts | 143-151 | Kovač skin rule | r>95, g>40, b>20, max−min>15, \|r−g\|>15, r>g, r>b |
| headLocator.ts | 19-22 | HEAD_WINDOW / SECOND_HEAD_MIN / MIN_SEPARATION / VALLEY_RATIO | 0.09 / 0.28 / 0.20 / 0.88 |
| headLocator.ts | 37-38 | person energy; blur radius | sk×2 + sa×0.6 + ac×1.0; max(2,⌊n×0.04⌋) |
| headLocator.ts | 42-43 | two-shot bands (cols) | 9–44 / 52–86 |
| headLocator.ts | 86-91 | skinGate; dominant energy; range | sk>0.15?1:0.35; sk×2+sa×0.6·gate+ac×1.2; cols 5–90 |
| activeSpeaker.ts | 23 | WINDOW_FRAC | 0.13 (→ ±12 cols) |
| activeSpeaker.ts | 33-36 | halfWindow / minCorr / margin / silenceFloorRel | 5 / 0.12 / 0.06 / 0.35 |
| activeSpeaker.ts | 121 | calibrateGenderRegion minConf | 0.30 |
| speaker.ts | 16-22 | SR / SILENCE_RMS / MIN_CONF / DEFAULT_THRESH / GRAY_ZONE / CAL_MIN_CONF / TWO_SHOT_MIN | 16000 / 0.005 / 0.30 / 160 / 10 / 0.35 (dead) / 5 (dead) |
| speaker.ts | 47 | gray-zone confidence scale | ×0.4 |
| speaker.ts | 56-79 | calib filter; min samples; init; iters; accept | conf≥0.30, f0∈[70,350]; ≥8; P25/P75; ≤25; sep≥35 Hz, mid∈[120,220] |
| dsp.ts | 80-81 | autocorrF0 fmin/fmax | 70 / 450 Hz |
| dsp.ts | 86, 91, 123 | min chunk; pre-emphasis; octave guard | 64; 0.97; 0.8×peak |
| dsp.ts | 252 | Gaussian radius | ⌈3σ⌉, reflect |
| smoother.ts | 21, 28, 40, 44 | default σ; σ samples; median window; rounding | 1.5 s (caller: 1.2); max(0.5, σ/dt); 3; t 3dp / x 4dp |
| debounce.ts | 13-14, 21 | MIN_SPEAKER_DURATION / SILENCE_HOLD / lastSpeechT init | 0.8 s / 1.5 s / −999 |
| runCropAnalysis.ts | 32, 40, 108, 121 | hash slice; stale claim; presign; key | 16 hex; 20 min; 3600 s; `crop/<id>.json` |
| ffmpegExtract.ts | 53, 91, 129, 168 | fps fallback; video vf; audio sr; PCM scale | 30; `fps=4,scale=320:180`; 16000; ÷32768 |
| ffmpegLimit.ts | 8 | FFMPEG_CONCURRENCY | 2 |
| pgBossDriver.ts | 17-18, 54 | QUEUE_CROP_CONCURRENCY (applied to **all** durable queues) | 2 |
| useCropOverlay.ts | 153 | client EMA α | 0.06 per RAF (~0.28 s @60 fps) |

**Test coverage**: only `dsp.test.ts` and `activeSpeaker.test.ts` exist (real synthetic-signal tests). Untested: all of `sceneAnalyzer`, `headLocator`, `debounce`, `smoother`, `cropProcessor` orchestration, `ffmpegExtract`, `runCropAnalysis`, and `speaker.analyzeChunk`/`labelFromPitch`.

---

## 3. Diagnosis — ranked defects

Ranked by user-visible impact × affected-catalog share. Each mechanism is cited; each has a fix that lands in §6.

**D1 — Skin-rule person detection: wrong/absent subject with systematic demographic and set-decor bias.** The Kovač rule (`sceneAnalyzer.ts:143-151`) is the sole face evidence, weighted highest everywhere (skin×1.5 in fusion :57; ×2.0 in `headLocator.ts:37,87`; the `skinGate` :86 decides whether saliency counts at all). The `r>95` floor and `r−g>15` chroma demand return **zero evidence for darker-skinned speakers and any face under cool/dim light** — deterministically, every episode on that set — while firing on wood paneling, brick, beige walls, hands, and arms. Faces are 15–30 px tall at 320×180. Symptom: crop centered on furniture or the wrong guest; failures systematic per person, read as bias. → P2.1/P2.4.

**D2 — Active-speaker attribution at the noise floor; gender gap-fill inverts on same-gender shows.** (a) Pearson r over n = 11 samples (±5 frames @4 fps) between audio RMS and motion pooled over ±12.5 % of frame width — torso/hands/background, not a mouth; syllable-rate lip motion (3–8 Hz) is aliased past the 2 Hz Nyquist. Null SD of r at n = 11 ≈ 1/√10 ≈ 0.32, so `minCorr 0.12` / `margin 0.06` (`activeSpeaker.ts:34-35`) sit at ~0.4σ / ~0.2σ: frequent, coin-flip firings; a nodding listener beats the talker. (b) For same-gender pairs, pitch calibration correctly falls back (`speaker.ts:79` requires ≥35 Hz separation; header comment :11 admits it), all confident frames get one label, and `calibrateGenderRegion` maps it to one region and infers the complement (`activeSpeaker.ts:146-149`) — so wherever AV abstains (most frames), **both hosts' speech gap-fills to the same head** (`cropProcessor.ts:196-201`, counted in `stats.gender` ≫ `stats.av`). → P1.1/P1.2/P2.5.

**D3 — The two-shot gate silently degrades dialogue to a one-person crop.** Fixed bands cols 9–44 / 52–86 (`headLocator.ts:42-43`) exclude center-seated (~8 % of width) and same-half compositions; `SECOND_HEAD_MIN 0.28` fails for any guest the skin rule can't see (D1); close-seated guests have no valley ≤ 0.88. Any failure → `dominantColumn` → one static x for the whole shot (`cropProcessor.ts:213-218`): a conversation participant structurally unframeable for minutes, including while speaking. Zero tests on any of these gates. → P2.3/P2.4 (tracks make the gates deletable).

**D4 — Speaker switches render as ~3 s glides arriving late; the client EMA smears real cuts.** A committed switch is a ≥0.20-width step, committed 0.8 s late (`debounce.ts:13`), then Gaussian σ = 1.2 s turns it into a ramp whose 10–90 % span ≈ 2.56σ ≈ **3.1 s** (`cropProcessor.ts:225`, `smoother.ts:28-40`) — the camera floats across the table between guests. The client EMA α = 0.06 (`useCropOverlay.ts:153`) adds ~0.5 s and, being unconditional, turns the server's intentional hard resets at cuts into a visible post-cut swim. These are the top two "amateur tells" in the cross-tool research (drift; panning across cuts). → P1.3/P1.4/P2.6.

**D5 — No null hypothesis: every shot "finds" a head; all-zero shots pin hard left.** Profiles are per-shot max-normalized with no absolute floor (`headLocator.ts:118-124`); `argmaxRange` cannot return "nothing" (:112-116) — on an all-zero profile the first index wins (col 5 → clamped x = 0.158, hard left, whole shot). The designed "no head → centroid" branch (`cropProcessor.ts:219-222`) is dead code, and `heads: []` (:45) vestigial. Title cards, screen recordings, animations get confident wrong static crops. → P1.5/P2.7.

**D6 — Shot detection misses same-room multicam cuts and dissolves.** Global 32-bin gray histograms with fixed threshold 0.30 (`cropProcessor.ts:122-128`): two matched-exposure cameras in one room produce near-identical histograms (cut missed → merged shots corrupt every per-shot stage and the smoother pans across the unknown cut); a 4-frame dissolve never exceeds 0.30 between adjacent frames. → P1.6.

**D7 — Mean-of-bimodal framing aims at the gap between people.** Pre-commit fallback `(heads[0]+heads[1])/2` (`cropProcessor.ts:210`) — active for seconds at the start of every two-shot given D2's sparse firing — and the interest centroid (branch C, plus every audio-degraded video via perf-011) center a window ~31.6 % of frame width on nobody. → P1.5/P2.5.

**D8 — Static-camera prior with no escape.** Branch B emits one time-averaged x per shot (`cropProcessor.ts:213-218`); no dead-zone exit, no re-acquisition (the static-camera assumption is stated in `headLocator.ts:1-15`). A speaker who leans, stands, or walks drifts half out of frame for the rest of the shot. → P2.6.

**D9 — Program-level: unmeasurable, unfixable, unshippable.** `ready` says nothing about correctness; `stats` is buried in public JSON nothing aggregates; the idempotency hash has no algorithm version (`runCropAnalysis.ts:28-33`) so improvements never reach existing videos; Recrop recomputes the identical result; the decision layer has zero tests. `ImageCropEditor.tsx` proves a manual-override pattern exists for stills but was never applied to video. → P0.\*, P3.1/P3.3/P3.4.

**D10 — Hygiene.** Dead exports `speaker.ts:85-156` (`CalFrame`, `SpeakerCalibration`, `calibrate`) and `headLocator.ts:96-108` (`activeHeadIndex`); `stats.heads`/`calibration` reflect only the **last** two-shot segment (`cropProcessor.ts:160-161, 236-242`); no protection for on-screen text. → P1.7 (removal), §8 (text detection deferred).

---

## 4. Target algorithm (v2)

Design principle: keep the proven shell (streamed single decode, per-shot scoping, debounce, per-shot smoothing with hard resets, ops plumbing) and **replace the evidence layer** — faces instead of skin pixels, mouths instead of quarter-frame motion — then add the camera discipline every professional reference (AutoFlip, Adobe Auto Reframe presets, Apple Center Stage) converges on: stationary-first, cut-don't-pan, deadband hysteresis. The output contract `{t, x}` @4 Hz is **frozen**; y is fixed at 50 % by the viewer, so headroom is out of scope and only horizontal lead-room is tunable.

### 4.1 Detection — YuNet, sparse, on the existing stream

- **Model:** YuNet (`face_detection_yunet_2023mar.onnx` from opencv_zoo) — 75,856 params, 337 KB, **MIT license, commercial use explicitly allowed**; WIDER Face val AP 0.834/0.824/0.708 (easy/med/hard); measured 1.6 ms @320×320 on i7-12700K (YuNet paper; opencv.org benchmark), derated ×5–15 for the shared 2-vCPU Xeon 8259CL → **5–25 ms/frame**. Named fallback if the 12-tensor multi-stride ONNX head (cls/obj/bbox/kps at strides 8/16/32, opencv_zoo#192) proves troublesome in TS: **UltraFace version-slim-320** (MIT, ~1 MB, simple `[scores, boxes]` head — the model Clip Forge ships in Node ORT). Second fallback: Python `cv2.FaceDetectorYN` sidecar (reference implementation; costs a second runtime — only if both ONNX routes fail).
- **Runtime:** `onnxruntime-node` (official, prebuilt linux x64/arm64). One shared `InferenceSession` per worker process, `intraOpNumThreads: 1`, `interOpNumThreads: 1`, `executionMode: 'sequential'` — sessions pin their threadpools even idle (microsoft/onnxruntime#17011) and must never fight ffmpeg for the second core.
- **Input:** the streamed 320×180 rgb24 analysis frame, bottom-padded with 12 zero rows to **320×192** (stride-32 multiple), converted to the model's expected layout in TS. No extra decode, no resize.
- **Rate:** every 2nd analysis frame → **2 Hz** (env-tunable `CROP_DETECT_FPS`, degrade knob 1 Hz for very long videos). Sparse-detection-plus-interpolation is the universal OSS-clipper cost trick; detection is 99.4–99.9 % of naive pipeline runtime (Tetris, arXiv 2605.25538), and LIVE-YT VC's own ground truth is annotated every 6th frame then smoothed.
- **Post:** score ≥ 0.6, NMS IoU 0.3, top-K 8, discard boxes < 8 px wide. Detection re-runs immediately after every shot cut (tracks and interpolation are invalid across cuts — the AutoFlip per-scene rule).
- **Streaming integration:** extend `streamRgbFrames` with an async-onFrame variant — when `onFrame` returns a Promise, `proc.stdout.pause()` until it resolves. Peak retained memory stays **one copied frame** (172,800 B); the perf-001/perf-009 no-whole-stream-buffering rule is preserved; inference wall time simply serializes into the decode pass.

### 4.2 Tracking — SORT-lite in pure TS

Greedy IoU ≥ 0.3 association per 2 Hz sample (<1 ms in JS); track birth after 2 consecutive hits; coasting through ≤ 4 missed samples (2 s); **hard reset at shot boundaries**. Face centers linearly interpolated from 2 Hz onto the 4 Hz keyframe grid. A track is *persistent* if it covers ≥ 40 % of the shot's samples or ≥ 3 s. Per-shot head model (replaces `locateHeads` entirely):

- 2 persistent tracks with median-center separation ≥ 0.15 → **two-shot** (deletes the fixed bands, SECOND_HEAD_MIN, MIN_SEPARATION, VALLEY_RATIO);
- 1 persistent track → **single**;
- 0 → fallback ladder (§4.5).

### 4.3 Active speaker — mouth-ROI lip activity × audio envelope

- **Signal:** per persistent track, per 4 Hz frame, mean |Δgray| over the **mouth ROI = lower third of the face box** (computed in Pass 1 from the most recent detection's box, staleness ≤ 0.5 s — benign under the static-camera prior; the first ≤ 0.5 s of a shot is masked). This is spatially specific where the current ±12-column pooling is not, and it is the academically grounded cheap signal: Hershey & Movellan (NeurIPS 1999) localized speakers by exactly this correlation; MI/CCA studies found vertical lip/chin displacement the visual feature most correlated with speech; a VAD+lip-movement baseline reaches ~90.7 % mAP on AVA-ActiveSpeaker — within ~1.6 pts of TalkNet (arXiv 2206.10421). Cost: ~2 tracks × ~500 px × 2400 frames ≈ negligible.
- **Decision:** per frame, Pearson r of each track's lip series vs the audio RMS envelope over **±10 frames (±2.5 s, n = 21)**; active = argmax r requiring window audio ≥ 0.35× global non-silent mean (kept), best r ≥ **0.35**, margin ≥ **0.15** (null SD at n = 21 ≈ 0.22; final values swept on the harness — the current 0.12/0.06 are ~0.4σ/0.2σ and indefensible). Priority per two-shot frame: **mouth-AV → hold**. The gender→region path is **deleted** (D2b): "hold the last speaker" is strictly better than a proxy wrong ~50 % of the time for half the catalog. F0/pitch machinery leaves the decision path (retained in `dsp.ts` with its tests; optional debug stat).
- **Debounce unchanged:** 0.8 s commit, 1.5 s silence hold — right shape, defensible constants; it now receives a trustworthy signal. Pre-commit fallback: previous shot's exit x if a head sits within 0.10 of it, else the head with higher total lip activity — **never the midpoint** (D7).
- **No-audio degrade:** face tracks still frame; two-shot without audio → static crop on the dominant head (larger median box area). Missing/corrupt audio stays non-fatal (perf-011 contract).

### 4.4 Per-shot camera policy (planner)

Per shot, from the target series (active head center, or the single head's interpolated center):

- **Stationary-first (AutoFlip's rule, Apple Center Stage's behavior):** if P95 |xᵢ − median| ≤ **0.075**, emit one constant x = median for the shot; snap to exact center when |median − 0.5| ≤ 0.03 (AutoFlip `snap_center`). This generalizes today's correct backend-107 static-x rule and is the top "professional vs amateur" differentiator in the commercial-tool complaint research.
- **Tracking mode** otherwise (subject actually moves, D8's escape hatch): median-3 prefilter → **1-euro filter** (Casiez, CHI 2012 — ~40 lines TS; at 4 Hz: `mincutoff 0.3 Hz`, `beta 0.05`, `dcutoff 1.0`, sweep on harness) → max-pan-velocity clamp **0.15 frame-widths/s** → deadband: output moves only while |target − output| > 0.03 (kills "breathing crop").
- **Cut, don't pan:** smoothing segment boundaries = shot cuts ∪ **committed speaker-switch frames**. Within segments the existing median-3 + Gaussian σ = 1.2 s remains as final polish; across boundaries the crop jumps hard. This converts D4's 3.1 s glide into an edit-like cut, at the debounce's 0.8 s latency only.
- **Client:** keep EMA α = 0.06 but **snap when |target − smoothX| > 0.08** (~5 lines in `useCropOverlay.ts`) so server-side cuts reach the viewer as cuts.

### 4.5 Fallback ladder (no persistent face track in shot)

1. Static per-shot vote from `0.6×saliency + 1.0×motion` column profiles (no skin term) with a **null hypothesis**: accept only if peak ≥ 2.0× median column energy **and** the raw (pre-normalization) energy mass clears an absolute floor (calibrated in P0 from fleet data); emit one static x.
2. Else **x = 0.5** (center) — making D5's dead branch real. Fallback shots never track per-frame.

### 4.6 Versioning, flagging, rollout

`CROP_ALGO` env selects `'v1' | 'v2'` with the v1 path intact for one release after the flip. `ALGO_VERSION` is appended to the idempotency hash input (`sourceHash(storage_key|size|duration|algo)`), stamped into `stats.algo_version` and a new `crop_algo_version` column, so shipping v2 makes existing `ready` rows stale on their next trigger and the backfill script (P2.8) can find and re-enqueue them rate-limited. The JSON contract is unchanged; old crop JSONs stay valid; the viewer's center fallback still covers absence.

### 4.7 CPU & memory budget — 10-minute 1080p video on the 2-vCPU host

Basis: v1 measures ~2.5 s per 40 s clip on a laptop (references/crop-processor/PIPELINE.md ≈ 1/16× realtime); derate ×2 for the shared Xeon 8259CL → **v1 ≈ 75 s** per 10-min video. 10 min @4 fps = 2,400 analysis frames; @2 Hz = 1,200 detections.

| Added stage | Arithmetic | Cost |
|---|---|---|
| YuNet @2 Hz | 1,200 × 5–25 ms (1.6 ms @320×320 desktop, ×5–15 vCPU derate; input 320×192 is 60 % of those pixels) | **6–30 s** |
| IoU association + interpolation | 1,200 × <0.05 ms | <0.1 s |
| Mouth-ROI diff @4 Hz | 2,400 × ≤2 faces × ~500 px | <0.5 s |
| Windowed Pearson (n=21) | 2,400 × 21 × 2 series | <0.1 s |
| Planner + 1-euro + smoothing | arithmetic on 2,400 points | <0.1 s |
| Adaptive shot detection | per-block histograms on existing gray frames | ~1 s |
| Removed: per-window F0 FFTs (decision path) | −2,400 × ~1 ms (8192-pt FFT) | **−2–4 s** |

**v2 total ≈ 85–110 s ≈ 0.15–0.18× realtime on one core** — inside the ~60 ms/frame envelope the host allows, leaving core 2 for the web tier. A 60-min episode scales to ≈ 8.5–11 min, inside the 20-min stale-claim / 30-min pg-boss expiry ceilings, with `CROP_DETECT_FPS=1` as the documented degrade knob (halves detection cost). Memory: ORT session + model ≈ +30–60 MB steady per worker; tracks/series < 5 MB/hour; the streamed-frame discipline is unchanged (≤1 copied frame in flight), so the existing ~330 MB/hour audio+profiles envelope and the two-concurrent-crops caution stand.

---

## 5. Measurement first — the eval harness (P0, blocking)

No algorithm claim in this plan is accepted without numbers. Calibrating facts the harness must encode: naive center crop scores 55.7 mIoU vs a published smart method's 57.1 (SmartVidCrop) — **baselines are strong**; human inter-annotator IoU is only ~0.50 raw / ~0.67 after temporal smoothing (LIVE-YT VC, arXiv 2604.24947) — **~0.67 IoU is the realistic ceiling**.

- **Location:** `backend-api/scripts/crop-eval/` — `annotate.html` (single-file canvas boxing tool, arrow-key frame stepping), `metrics.ts`, `run-eval.ts`, `fleet-audit.ts`, `backfill-recrop.ts`; labels committed under `backend-api/scripts/crop-eval/labels/`; clip media referenced by a manifest (storage keys / local paths), not committed. Node-only tooling — the sandbox shell has no `jq`.
- **Set:** 20–50 clips from the real catalog **plus adversarial categories, ≥2 clips each**: two-shot, same-gender pair, darker-skinned speaker, warm/wood set, same-room multicam, screen share / title cards, walk-on or standing speaker, no-audio. RetargetVid (ICIP 2021, downloadable) as an external sanity set.
- **Labels:** active speaker's face box every 6th frame (the LIVE-YT VC protocol); temporal smoothing of labels per their recipe (Hamming-weighted bilateral filter over a 15-frame window) to raise consensus.
- **Metrics (verbatim from LIVE-YT VC / RetargetVid / AVA):**
  1. **mIoU + IoU@0.5** of the predicted 9:16 window vs the GT-derived window;
  2. **subject-out-of-frame rate** — % of labeled frames where the GT active-face box is not fully inside the predicted window (directly encodes "wrong person on screen");
  3. **jitter** — mean |Δ²x| (second-order finite difference of the crop-center track);
  4. **consecutive-center distance**;
  5. **speaker-attribution accuracy** on labeled speech spans (the AVA-ActiveSpeaker subproblem).
- **Baselines always run:** center crop (x ≡ 0.5) and current v1. If v1 does not clearly beat center crop, the feature is currently net-negative vs shipping nothing.
- **The rule:** every task in §6 that touches `src/services/crop/` must attach a `run-eval.ts` output delta to its PR; `results/<algo>@<version>.json` is committed; a vitest check asserts the committed results match the current `ALGO_VERSION` and that gated metrics have not regressed.
- **Zero-annotation fleet audit (runs today, before any labeling):** `fleet-audit.ts` enumerates `crop_status='ready'` rows, fetches each public `crop/<id>.json`, and tabulates: `av/(av+gender+hold)` share (how rarely the direct signal decided — expect single digits), `gender` share (the D2-broken proxy's real weight), `pitch_threshold_hz == 160` rate (the same-gender/uncalibrated population), `two_shot` ratio, plus keyframe dynamics: total travel, jitter, % of duration within |x−0.5| < 0.02 (feature did nothing a center crop wouldn't), % pinned at the clamps 0.158/0.842 (D5 signature). This quantifies the catalog-level damage in hours, read-only.

---

## 6. Task list

Each task is one focused PR. Effort: S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days. "AC" = acceptance criteria (measurable). Fleet constraints apply throughout: all ffmpeg spawns via `runFfmpegLimited`; jobs stay in the worker container; no read-path enqueues; streamed frames never fully buffered.

### P0 — Measure before touching (do first)

**P0.1 — Fleet stats audit script** · S · deps: none
Node script `backend-api/scripts/crop-eval/fleet-audit.ts` implementing §5's zero-annotation audit (read-only DB query + HTTPS fetch of public crop JSONs; no writes, no enqueues).
AC: one command prints the table + writes a JSON snapshot; runs against prod data without touching rows; numbers for `gender` share and `pitch==160` rate land in the P2.8 go/no-go memo.

**P0.2 — Annotation tool + label schema** · S/M · deps: none
`annotate.html` (single file: `<video>` + canvas + arrow keys), label JSON `{clip_id, frame_idx, t, box:[x,y,w,h] normalized, active_speaker: boolean}` at every-6th-frame cadence; loader/validator in `metrics.ts`.
AC: one clip labeled end-to-end; labels round-trip through the validator; README documents the protocol.

**P0.3 — Eval set assembly + labeling** · M (mostly human hours) · deps: P0.2
Manifest of 20–50 catalog clips covering every adversarial category in §5 (≥2 each); labels committed; label smoothing implemented per the LIVE-YT VC recipe.
AC: manifest + labels in repo; category coverage table in the PR; ~2–4 annotation hours logged.

**P0.4 — Metrics module + eval runner** · M · deps: P0.2, P0.3
`metrics.ts` (mIoU, IoU@0.5, out-of-frame rate, jitter, center distance, attribution accuracy) + `run-eval.ts` that executes `processVideoCrop` on manifest clips and scores predicted tracks; center-crop baseline built in; results file convention + vitest non-regression check.
AC: committed `results/v1@current.json` and `results/center.json` for the full set; the v1-vs-center comparison is quoted in the PR (this is the "prove the problem" number).

**P0.5 — Version the idempotency hash + algo column** · S · deps: none
`ALGO_VERSION` const in `cropProcessor.ts`, appended to the hash input in `runCropAnalysis.ts:28-33`; migration adding `video_files.crop_algo_version`; stamp `stats.algo_version`; write the column on success.
AC: bumping `ALGO_VERSION` makes a `ready` row recompute on the next trigger/recrop (test); migration applies cleanly; JSON contract unchanged (additive stats field only).

### P1 — Zero-dependency quick wins (each gated by P0.4 numbers)

**P1.1 — Delete the gender→region gap-fill** · S · deps: P0.4
In `cropProcessor.ts:196-207`, drop the `genderRegion` branch (priority becomes AV → hold); remove the `calibrateGenderRegion` call; keep silence/unclear debounce keys; `stats.gender` reports 0 (kept for schema stability).
AC: harness — wrong-attribution seconds on same-gender clips strictly ↓ with no regression elsewhere; converts D2b's active wrongness into inertness in ~10 lines.

**P1.2 — Statistically defensible AV gate** · S · deps: P0.4
Sweep `DEFAULT_AV` on the harness; land `halfWindow: 10` (n = 21), `minCorr ≈ 0.35`, `margin ≈ 0.15` (`activeSpeaker.ts:32-37`) or the sweep's winner.
AC: attribution accuracy ↑ or (accuracy flat + false-switch rate ↓) on the eval set; the sweep table is committed with the PR.

**P1.3 — Hard boundaries at committed speaker switches** · M · deps: P0.4
`cropProcessor.ts` Pass 2 records debounce commit frames; `smoothKeyframes` (`smoother.ts:18-45`) accepts extra boundary times = shot cuts ∪ commits.
AC: unit test — a step target yields a step output (no ≥3 s ramp; kills D4's glide); harness jitter not ↑; eval-set glide events (manual count on 5 clips) ↓.

**P1.4 — Client EMA snap-on-cut** · S · deps: none
`useCropOverlay.ts:153`: if |target − smoothX| > 0.08 set `smoothX = target`, else EMA α = 0.06. Extract to a pure helper for a unit test.
AC: helper test (snap + smooth branches); manual portrait check on a cut-heavy clip shows no post-cut swim.

**P1.5 — Null-energy floor + honest fallbacks** · S/M · deps: P0.4
`headLocator.ts`: require a minimum **raw** (pre-normalization) energy mass before declaring any head; below it return `heads: []`. `cropProcessor.ts`: branch C (:219-222) uses a static per-shot argmax of motion+saliency (mode) instead of the per-frame centroid; pre-commit fallback (:210) becomes previous-x/stronger-head, never the midpoint.
AC: synthetic black/title-card shot yields x = 0.5 (today: 0.158 hard-left — D5); no eval-set metric regresses; fleet-audit % - pinned-at-clamp drops on re-run of affected fixtures.

**P1.6 — Adaptive, spatial shot detection** · M · deps: P0.4
Replace the global-histogram fixed threshold (`cropProcessor.ts:122-128`) with per-block histograms (4×3 grid × 16 bins) scored against a rolling-average-normalized threshold (PySceneDetect AdaptiveDetector logic, F1 91.59 on BBC Planet Earth hard cuts); keep the 0.5 s min gap. Alternative implementation if preferred: `scdet` appended to the existing `-vf` chain with `metadata=print:file=` into the job tmpdir — still one decode.
AC: cut F1 on a small labeled cut set (drawn from P0.3 clips incl. the multicam clip) ≥ current detector, with the multicam same-room cuts found (currently missed — D6).

**P1.7 — Decision-layer tests + dead-code removal** · M · deps: none
Tests for `debounce.ts` (0.8 s commit, 1.5 s silence reset, pending-clear-on-current), `smoother.ts` (per-shot reset, σ math, new switch boundaries), `labelFromPitch` edges, `buildFrameSegments`. Delete dead `speaker.ts:85-156` (`CalFrame`/`SpeakerCalibration`/`weightedMean`/`calibrate`) and `headLocator.ts:96-108` (`activeHeadIndex`) — verified unimported.
AC: suites green; `grep` proves no imports broke; coverage exists for every constant the diagnosis indicts in those files.

### P2 — The step-change: face evidence, mouth AV, camera planner

**P2.1 — ONNX runtime + YuNet detector wrapper** · M · deps: none (parallel with P1)
Add `onnxruntime-node` to `backend-api` deps; vendor `face_detection_yunet_2023mar.onnx` (337 KB) + its MIT LICENSE under `backend-api/models/`; new `src/services/crop/faceDetector.ts`: 320×192 zero-pad, layout conversion, prior generation for strides 8/16/32, 12-output decode, NMS (IoU 0.3), score ≥ 0.6, min width 8 px; shared session with `intraOpNumThreads: 1`, sequential mode. Fixture-frame unit tests (frames extracted from P0.3 clips, hand-checked centers). Time-box the YuNet decode; if it stalls, swap to UltraFace-slim-320 (MIT, `[scores, boxes]` head) behind the same interface.
AC: detects both faces on two-shot fixtures within ±2 profile columns of hand labels, incl. the darker-skin and warm-set fixtures the Kovač rule fails (D1); logged p95 inference ≤ 25 ms/frame on the prod host; worker Docker image builds and boots.

**P2.2 — Async-backpressure variant of `streamRgbFrames`** · S/M · deps: none
`ffmpegExtract.ts`: when `onFrame` returns a Promise, `pause()` stdout until it resolves; at most one copied frame in flight; partial-frame discard and error paths unchanged.
AC: unit test with a slow async consumer proves bounded memory, in-order delivery, and unchanged behavior for sync consumers; the perf-001/perf-009 comment block is extended, not weakened.

**P2.3 — Face-track module (SORT-lite)** · M · deps: P2.1
`src/services/crop/faceTracker.ts`: greedy IoU ≥ 0.3 association, birth 2 hits, coast 4 samples, hard reset at shot boundaries, 2 Hz → 4 Hz center interpolation, persistent-track rule (§4.2). Pure TS, no deps.
AC: synthetic tests — crossing tracks stay distinct, missed detections coast then die, cut resets tracks; API `tracksForShots(detections, shotBounds)` documented.

**P2.4 — Track-based head model behind `CROP_ALGO` flag** · L · deps: P2.1–P2.3, P0.5
`cropProcessor.ts`: `CROP_ALGO` env (`'v1'` default); v2 path runs detection at 2 Hz inside Pass 1 (via P2.2), builds tracks per shot, derives two-shot/single/none from persistent tracks (§4.2) — `locateHeads`' bands/ratio/valley gates are bypassed in v2 (deleted once v1 retires). v1 path byte-identical.
AC: flag switches cleanly (test); harness v2-partial vs v1: subject-out-of-frame rate ↓ on two-shot, darker-skin, and warm-set categories with no single-speaker regression; job `ms` log stays within §4.7 budget on a 10-min clip on the prod host.

**P2.5 — Mouth-ROI lip activity + AV decision** · M · deps: P2.4
`src/services/crop/lipActivity.ts` (lower-third-of-box |Δgray| series, ≤0.5 s box staleness, first-of-shot masking); v2 decision: mouth-AV correlation (±10 frames, thresholds from §4.3 swept on harness) → hold; pitch/F0 removed from the decision path (dsp + tests retained); no-audio degrade = static dominant head.
AC: attribution accuracy on labeled speech spans beats v1+P1.2 overall **and specifically on same-gender clips** (D2's population); visual-only clips produce stable single-head framing; `stats` gains `attribution: 'mouth_av'` provenance counts.

**P2.6 — Per-shot camera planner** · M · deps: P2.4
`src/services/crop/cameraPlanner.ts`: stationary classification (P95 dev ≤ 0.075 → constant median; snap-center 0.03), tracking mode (median-3 → 1-euro `mincutoff 0.3, beta 0.05` → velocity clamp 0.15 w/s → deadband 0.03), boundaries at cuts + committed switches feeding the existing smoother (§4.4).
AC: unit tests — constant in → constant out; step → hard boundary (no ramp); sine jitter attenuated ≥ 10×; harness jitter ≤ v1 and travel not ↑ on stationary clips; the walk-on clip tracks instead of abandoning the subject (D8).

**P2.7 — Fallback ladder for face-less shots** · S · deps: P2.4
No persistent track → static saliency+motion vote with prominence ≥ 2× median + absolute raw floor, else center 0.5 (§4.5).
AC: screen-share/title-card clips produce centered or stable sensible static crops; zero left-pin (x = 0.158 on empty shots) across the eval set.

**P2.8 — Eval gate, default flip, backfill** · M · deps: all P2, P0.4
Full harness run v2 vs v1 vs center; go/no-go memo; flip `CROP_ALGO` default to v2; `scripts/crop-eval/backfill-recrop.ts` — operator-run, rate-limited (N videos/hour, off-peak), enqueues crop for `ready` rows whose `crop_algo_version` is old, resumable, `--dry-run` first.
AC: gate — v2 ≥ v1 on mIoU, **strictly better** on out-of-frame rate and same-gender attribution, jitter ≤ v1, and v2 > center-crop baseline on mIoU (else do not flip); backfill dry-run output reviewed; deploy runbook updated with the rollback line (§7).

### P3 — Polish (post-flip)

**P3.1 — Persist stats to the DB** · S/M · deps: P2.8
Migration: `crop_stats` jsonb on `video_files` (or hold/av-ratio columns); written on success in `runCropAnalysis.ts`; fleet-audit switches to SQL.
AC: audit runs without fetching public JSONs; a documented query answers "which ready videos held >80 % of the time".

**P3.2 — Lead-room bias from landmarks** · S · deps: P2.6
Facing direction from YuNet's 5-point landmark asymmetry; in tracking mode bias the target to 0.45/0.55 toward the facing side (x-only; y is fixed by the contract).
AC: harness mIoU not worse; side-by-side screenshots on interview clips attached to the PR.

**P3.3 — Portrait preview in the editor** · M · deps: none
A portrait-orientation preview toggle in `client-web` reusing the existing overlay math so creators can see the crop track without a phone (today the effect is invisible until published — D9c).
AC: editor preview matches viewer behavior on the same clip; no read-path enqueues added.

**P3.4 — Manual override (product call)** · L · optional · deps: P3.3
Per-video or per-segment x-nudge persisted as an additive JSON field (ignored by old clients), following the `ImageCropEditor.tsx` pattern. The escape hatch every professional tool ships (Adobe's editable keyframes; OpusClip's per-segment override).
AC: an override survives recrop; viewer honors it; contract remains backward-compatible.

**P3.5 — LR-ASD escalation on ambiguous windows** · L · optional · deps: P2.5, only if the harness shows mouth-AV attribution below target on some category
LR-ASD ONNX (MIT-licensed weights, 0.84 M params / 0.51 GFLOPs, 94.5 % mAP AVA) run **only** on windows where the DSP score is ambiguous — a streaming ASD still costs ~32 ms/frame on a Xeon 8275CL (arXiv 2409.09018), so it must never be the always-on path. Clip Forge (MIT, Node) is the working ORT reference.
AC: attribution on the failing category ↑ with total job time still inside §4.7's ceiling; hard CPU cutoff enforced.

**Dependency spine:** P0.1–P0.5 unblock everything → P1.\* land independently (each harness-gated) → P2.1/P2.2/P2.3 in parallel → P2.4 → P2.5/P2.6/P2.7 → P2.8 flips → P3.

---

## 7. Risks & rollback

- **Licensing.** YuNet: MIT, commercial use explicit (opencv_zoo). UltraFace: MIT. LR-ASD weights: MIT (repo LICENSE © 2025 Liao Junhua). **Forbidden:** SCRFD/InsightFace pretrained weights (non-commercial research only, deepinsight/insightface#2022) and anything YOLOv8-derived (Ultralytics AGPL-3.0) — named here so they don't sneak in as "better" swaps. Vendored model files ship with their LICENSE alongside.
- **Docker image size / build.** `onnxruntime-node` adds ~60–80 MB unpacked native binaries (single arch); the model is 337 KB. Pin the ORT version; verify glibc compatibility with the backend base image in CI; measure the image-size delta in P2.1's PR. If the native module fights the build, the wasm backend is a functional (slower) fallback and the Python sidecar the last resort.
- **CPU regression on the 2-vCPU host.** Budget is §4.7 with headroom, but the box is already saturated when exports run (measured 4.28–16.3 s/frame capture). Mitigations: ORT threads pinned to 1/sequential (one session per worker — sessions hold threadpools even idle, ORT#17011); detection at 2 Hz with `CROP_DETECT_FPS=1` degrade; every job still passes `runFfmpegLimited`; **do not** touch `QUEUE_CROP_CONCURRENCY` as a crop lever — it applies to every durable queue including exports (`pgBossDriver.ts:54`). Watch the existing `crop analysis complete {ms}` log; alert threshold: ms > 0.35× duration.
- **Memory.** +30–60 MB ORT session per worker on top of the existing ~330 MB/hour episode envelope; heavy work stays in the worker container (the 2026-08-13 OOM incident rule); the streamed-frame contract is preserved by design (P2.2's bounded single-frame copy).
- **Model misses (small faces at 320×180).** Two-shot faces are 15–30 px; YuNet's WIDER-hard AP 0.708 covers this class but P2.1's fixture AC is the real gate. If recall disappoints, the contained fix is detector-input upscale of the analysis frame (e.g. 480×270 input to the detector only, ~2.3× inference cost, still inside budget) — not a global analysis-resolution raise.
- **Rollback.** `CROP_ALGO=v1` env flip — no deploy, no data migration; v1 code stays for one release post-flip. Old crop JSONs remain valid under the frozen contract; the viewer's center fallback covers absence. The backfill is resumable and rate-limited, and re-running it after a rollback simply re-stamps rows with v1 output.
- **Side-by-side strategy.** Offline: the harness runs both algorithms on the same clips (P2.8 gate). Production canary: before the default flip, set `CROP_ALGO=v2` and manually recrop 2–3 consenting projects; compare on-device in portrait against v1 screen-recordings. Only then flip the default and start the backfill.
- **Quality-claim risk.** Human inter-annotator IoU ceiling is ~0.67 and center crop is a strong baseline — publish the harness numbers with every claim, including the flip announcement.

---

## 8. Explicitly rejected options

- **GPU or cloud inference.** No GPU exists on the host (SwiftShader confirmed it); external ML APIs add per-video cost, latency, and an availability dependency for a background nicety. The host is the ruling constraint.
- **TalkNet / LoCoNet / S3FD pipelines.** 15.7 M–34.3 M params, up to 4.86 GFLOPs; the official ASD demo stacks use S3FD (VGG16) face detection, which the FaceBoxes/CenterFace literature calls too slow for CPU outright. Only the LR-ASD *sparse escalation* (P3.5) survives, strictly gated.
- **MediaPipe on Node.** `@mediapipe/tasks-vision` has no supported server story — it runs only via a jsdom DOM-faking hack (google-ai-edge/mediapipe#5237). AutoFlip itself is deprecated (2023-03-01, OpenCV-3/Bazel-only) — we reimplement its planner logic, not its binary.
- **@vladmandic/human + tfjs-node.** A heavyweight dependency tree to reach models equivalent to a 337 KB MIT ONNX file; native ORT also beats wasm/tfjs paths on AVX2 kernels.
- **opencv4nodejs / opencv-wasm.** The original binding is unmaintained (~6 years); the fork drags a native OpenCV build per Node version; opencv-wasm is frozen at OpenCV 4.3.0, predating `FaceDetectorYN` (added 4.5.4). The Python `cv2.FaceDetectorYN` sidecar remains only as the named last-resort fallback.
- **SCRFD-0.5GF and YOLOv8n(-face).** Technically attractive, legally wrong for a SaaS: SCRFD weights are non-commercial; YOLOv8 is AGPL and measures 80.4 ms @640 on CPU anyway.
- **Raising the global analysis budget (resolution/fps).** 320×180 @ 4 fps is the deliberate CPU floor; sparse detection rides the existing stream instead. Any raise is scoped to the detector input only, and only if P2.1's recall gate fails.
- **Per-frame FaceMesh lip landmarks.** 10–25 ms per face crop to obtain what a mouth-ROI frame-difference gets for microseconds (arXiv 2206.10421 shows the cheap signal is within ~1.6 mAP of TalkNet on AVA); reconsider only inside P3.5.
- **Server-side vertical render (ffmpeg sendcmd crop).** There is no consumer: playback is client-side by design, and the linear export is hard-ruled 1920×1080 landscape (EXPORT_GRID). Building a render pipeline for a nonexistent shorts product would spend the host's scarcest resource (encode CPU) for nothing. Revisit only alongside an actual social-clips feature — the sendcmd technique is documented and cheap when that day comes.
- **OpusClip-style split layout for two-shots.** The structurally correct long-term answer to "which speaker do we frame" (two stacked static crops), but it breaks the frozen x-only JSON contract and requires viewer layout work — a separate product decision, recorded here so the door stays open after P2.
- **PP-OCR text-region protection.** 28–58 ms/frame even for the mobile det model; the catalog is talking-head-dominant and the saliency fallback plus static-crop discipline already avoids the worst text slicing. Revisit with any screenshare-layout work.
- **Kalman filtering / CineFilter convex optimization for smoothing.** The 1-euro filter lags less than Kalman at equal jitter reduction (Casiez, CHI 2012) in ~40 lines; CineConvex-style sliding-window optimization is overkill next to a per-shot stationary/tracking planner at 4 Hz.

---

*Research sources referenced throughout: Google AutoFlip (MediaPipe docs + Google Research blog, 2020); YuNet paper (Wu et al., MIR 2023) + opencv_zoo benchmarks; Hershey & Movellan, NeurIPS 1999; "Rethinking Audio-Visual Synchronization for Active Speaker Detection" (arXiv 2206.10421); Light-ASD (CVPR 2023) / LR-ASD (IJCV 2025); Casiez et al., 1-euro filter (CHI 2012); CineFilter (arXiv 1912.05636); PySceneDetect benchmarks; Tetris sparse-detection measurement (arXiv 2605.25538); LIVE-YT VC/VC++ (arXiv 2604.24947) and RetargetVid (ICIP 2021) datasets + metrics; ONNX Runtime threading docs + issues #17011/#16798; insightface#2022 (SCRFD licensing); mediapipe#5237 (no Node support); Clip Forge (MIT Node reference implementation).*
