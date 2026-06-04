# Smart Crop — Pipeline

How podcast-saas turns a 16:9 landscape podcast into a 9:16 portrait video that
keeps the **active speaker** centred, automatically and in the background.

This document is the deep-dive. The actual implementation is a dependency-free
TypeScript port that lives in
[`backend-api/src/services/crop/`](../backend-api/src/services/crop). The original
reference (Python + OpenCV + MediaPipe), which this port is derived from, is
preserved for comparison in [`./reference-python/`](./reference-python) (source
only — it is not run by podcast-saas).

---

## 1. What problem this solves

A naive centre-crop of a two-host podcast cuts both speakers in half. We want a
crop window whose horizontal position (`crop_x`, normalised `0..1`) moves over
time so that whoever is talking is framed. We compute this **offline** as a small
per-second keyframe track `[{ t, x }]`; the player interpolates it at runtime and
applies a CSS transform — no per-frame inference in the browser.

```
landscape 1920×1080                     portrait 9:16 window
┌───────────────────────────┐          ┌───────┐
│   A (talking)      B       │   →      │   A   │   crop_x ≈ A's face
│   😀               🙂       │          │  😀   │
└───────────────────────────┘          └───────┘
```

Output JSON (stored at `crop/{videoId}.json`, served as `segment.crop_url`):

```json
{ "video_id": "…", "duration": 612.3, "width": 1920, "height": 1080,
  "crop_aspect": 0.5625,
  "keyframes": [ { "t": 0, "x": 0.34 }, { "t": 0.5, "x": 0.34 }, … ] }
```

---

## 2. Why a TypeScript port (not the Python reference)

The reference needs OpenCV, MediaPipe, SciPy and a `.tflite` model. podcast-saas
deploys to a managed **Node-only** host (no Docker, no Python, outbound 80/443
only). So the algorithm is reimplemented in pure TypeScript:

- **ffmpeg** (already a system dependency for HLS) decodes frames + audio.
- All the maths — FFT, autocorrelation pitch, spectral-residual saliency,
  Gaussian/median filtering — is implemented from scratch in
  [`dsp.ts`](../backend-api/src/services/crop/dsp.ts) and unit-tested.
- Face detection (the one piece that needed MediaPipe) is replaced by a
  **face-free person locator** driven by skin-tone + saliency + motion, with an
  optional precise-detector hook (`FaceHook`) for future drop-in upgrades.

The result runs anywhere Node + ffmpeg run, and processes a 40-second clip in
~2.5 s on a laptop.

---

## 3. The pipeline, stage by stage

The orchestrator is
[`cropProcessor.ts`](../backend-api/src/services/crop/cropProcessor.ts). It is a
**two-pass** design: one decode, accumulate everything, decide globally, then
emit.

### Stage 0 — extract (one video decode + one audio decode)
[`ffmpegExtract.ts`](../backend-api/src/services/crop/ffmpegExtract.ts)
- `probeVideo` → real width/height/duration.
- `extractRgbFrames` → RGB frames at **2 fps**, downscaled to **320×180** (we
  never need full res for a 1-D signal). Grayscale is derived in JS (one decode).
- `extractMonoPcm` → the whole audio track as **16 kHz mono float32**.

### Stage 1 — per-frame profiles
[`sceneAnalyzer.ts`](../backend-api/src/services/crop/sceneAnalyzer.ts) returns,
for each frame, four 1-D column profiles (length 96) instead of a hard decision:

| signal | how | why |
|--------|-----|-----|
| **motion** | abs-diff vs previous frame, **restricted to the face band** (rows 8–78 %) | the speaking head moves (lips, nods); ignoring the lower frame drops gesturing-hand noise |
| **skin** | Kovač RGB skin rule, per column, face band only | faces are skin — the strongest "where are the people" cue without a model |
| **saliency** | spectral-residual (Hou & Zhang) on a 64×64 FFT | generic visual pop-out |
| **interestX** | weighted centroid of `center·0.5 + skin·1.5 + motion·0.6 + saliency·0.4` | the fallback crop for non-two-shot frames |

Per-second audio is reduced to raw pitch features (`analyzeChunk` → `{rms, f0,
conf}`) using FFT **autocorrelation** (not raw FFT peak — autocorrelation locks
onto the true period, not a harmonic).

### Stage 2 — global decisions (between passes)

**Head localization** —
[`headLocator.ts`](../backend-api/src/services/crop/headLocator.ts). Podcast
cameras are static, so we localise **once** from the summed profiles rather than
per frame (no wobble). Person-energy = `skin·2 + saliency·0.6 + activity·1`. We
take the strongest peak in the **left half** and in the **right half**, then gate
a genuine two-shot on three tests:
- both peaks strong (≥ 45 % of the max),
- separated by ≥ 0.22 of the width,
- a real **valley** between them (two people have a gap; one centred face does
  not).

This gate is what stops animations and single speakers from being wrongly split
into two heads.

**Pitch threshold (self-calibrating)** —
[`speaker.ts`](../backend-api/src/services/crop/speaker.ts). Instead of a
hard-coded 160 Hz male/female split, we 1-D **k-means** the confident F0 samples
into two clusters and put the threshold at the valley between them — adapting to
the actual two voices. Falls back to 160 Hz when the voices aren't separable
(same-gender hosts).

**Gender → side, by voting** — for every confident-gender frame we ask *which
head is moving while this gender speaks* and tally a confidence-weighted vote.
Majority wins. This is dramatically more stable than averaging positions (which
collapses to centre whenever the active head flips), and conflicts (both genders
voting the same head) are resolved by giving the contested head to the stronger
voter.

### Stage 3 — emit crop_x (second pass, no decode)

For each frame:
- **Not a two-shot** → `crop_x = clamp(interestX)`. A single speaker is followed
  by the interest centroid (skin-dominated, so it sits on the face).
- **Two-shot** → resolve the active-speaker head by priority:
  1. **calibrated** gender → side (from the vote),
  2. **motion** — the head with the most motion this frame,
  3. **midpoint** of the two heads (last resort),

  then pass it through the **speaker debounce**
  ([`debounce.ts`](../backend-api/src/services/crop/debounce.ts)): a switch only
  commits after **1 s of continuous speech**, the crop **holds** through silence
  (1.5 s) and ambiguous pitch, and the state **resets at shot boundaries**. This
  suppresses ping-ponging on brief interjections.

### Stage 4 — smoothing
[`smoother.ts`](../backend-api/src/services/crop/smoother.ts). Per shot: a
**median** prefilter (kills one-frame glitches) then a **Gaussian** (σ ≈ 1.5 s,
removes jitter while preserving slow pans). **Hard reset at every cut** — never
blend a crop across a shot boundary. Shot boundaries come from gray-histogram
Bhattacharyya distance computed inline during pass 1.

### Runtime (browser)
[`client-web/components/viewer/useCropOverlay.ts`](../client-web/components/viewer/useCropOverlay.ts)
binary-searches the keyframes at `currentTime`, applies a light EMA, and — **only
in portrait orientation** — widens the active `<video>` and `translateX`-es it so
`crop_x` lands at centre. Landscape is untouched (letterboxed as before).

---

## 4. Improvements over the reference

1. **Self-calibrating pitch threshold** (k-means valley) instead of a fixed
   160 Hz — the single biggest source of gender misclassification.
2. **Sub-sample F0** via parabolic interpolation of the autocorrelation peak, and
   an **octave-error guard** (prefer the shortest strong period) — verified to
   recover 90–300 Hz tones to < 1 Hz.
3. **Global static-camera head localization** with a bimodality/valley gate —
   far steadier than per-frame face peaks, and it no longer mis-fires on
   single-speaker or animated content.
4. **Vote-based gender→side** mapping — robust to active-head flicker, where the
   reference's position-averaging collapsed to centre.
5. **Face-band-restricted motion & skin** — ignores hands / lower-thirds.
6. **Median prefilter** before Gaussian smoothing — removes one-frame glitches
   the reference could smear into a visible wobble.
7. **2 fps** sampling (vs 1 fps) for snappier switching, still cheap.
8. **One video decode** (RGB → gray in JS) instead of separate passes.

A precise face detector can still be slotted in via the `FaceHook` interface in
`sceneAnalyzer.ts` to replace the heuristic head locator — everything downstream
is unchanged.

---

## 5. How it runs in the background

Triggering is centralised in
[`buildPlayerConfig.ts`](../backend-api/src/services/buildPlayerConfig.ts), which
is the one function behind **preview** (`/projects/:id/player-config`),
**single-video share** (`/share/:token`) and **playlist** play-configs. Whenever
a player config is built it:

1. emits `crop_url` for each segment whose crop is `ready`, and
2. fire-and-forgets `enqueueCropForProject(projectId)`.

[`runCropAnalysis.ts`](../backend-api/src/services/crop/runCropAnalysis.ts) then:

- runs on `setImmediate` (never blocks the request, never touches the editor),
- is guarded by an in-process set so concurrent preview+share triggers don't
  double-run,
- is **content-hash idempotent**: the source hash (`storage_key` + size +
  duration) is stored on the `video_files` row; a `ready` row with a matching
  hash is a no-op, so polling preview every 5 s is free,
- **re-runs automatically when the video changes** (new upload → new
  `storage_key` → new hash → recompute),
- tracks `crop_status` (`none|processing|ready|failed`), `crop_key`,
  `crop_source_hash`, `crop_error` on the row (migration `022_smart_crop.sql`),
- downloads the source, runs `processVideoCrop`, uploads `crop/{videoId}.json`,
  flips status to `ready`.

So: open a preview or create a share link → the crop computes in the background →
the finished portrait crop "lights up" (`crop_url` populated) on a subsequent
poll, without the editor ever waiting.

---

## 6. Files

```
backend-api/src/services/crop/
  dsp.ts            FFT, autocorr F0, spectral-residual saliency, gaussian/median, bhattacharyya
  ffmpegExtract.ts  probe + RGB frames + mono PCM (spawn ffmpeg)
  sceneAnalyzer.ts  per-frame motion/skin/saliency/interest profiles (+ optional FaceHook)
  headLocator.ts    global static-camera head localization + per-frame active head
  speaker.ts        pitch labelling + self-calibrating threshold
  debounce.ts       speaker-continuity state machine
  smoother.ts       per-shot median + gaussian, hard reset at cuts
  cropProcessor.ts  two-pass orchestrator → CropMetadata
  runCropAnalysis.ts background job + triggers + status tracking
  __tests__/dsp.test.ts   11 deterministic unit tests (FFT, F0, saliency, threshold, clamp)

client-web/components/viewer/
  useCropOverlay.ts  runtime portrait transform (no-op in landscape)
```

## 7. Verifying

```bash
# Unit tests (no video needed)
cd backend-api && npx vitest run src/services/crop/__tests__/dsp.test.ts

# Ad-hoc run against a real file
#   npx tsx -e "import('./src/services/crop/cropProcessor.js').then(async m => \
#     console.log((await m.processVideoCrop('id','/path/to.mp4')).stats))"
```

Tuning knobs worth knowing: `DEFAULT_SAMPLE_INTERVAL` (fps) and the interest
weights in `cropProcessor.ts`/`sceneAnalyzer.ts`; `MIN_SEPARATION` / `VALLEY_RATIO`
(two-shot strictness) in `headLocator.ts`; `MIN_SPEAKER_DURATION` (switch latency)
in `debounce.ts`.
