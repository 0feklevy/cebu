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

### Stage 2 — per-shot decisions (between passes)

Everything here runs **per shot**, not globally. Camera framing is only stable
within a continuous take, so a video that mixes a two-shot with B-roll and single
close-ups would, under a global model, have its head profile swamped by the
non-two-shot footage (→ one false head in the middle, crop stuck there). Shot
boundaries come from the inline gray-histogram Bhattacharyya cuts.

**Head localization** —
[`headLocator.ts`](../backend-api/src/services/crop/headLocator.ts). Within a
shot the camera is static, so we localise from that shot's summed profiles.
Person-energy = `skin·2 + saliency·0.6 + activity·1`. We take the strongest peak
in the **left half** and the **right half**, then gate a genuine two-shot on:
both peaks strong, separated by ≥ 0.20 width, and a real **valley** between them
(two people have a gap; one centred face does not). This stops animations and
single speakers from being split into two heads.

**Active speaker by audio-visual correlation** (the core mechanism) —
[`activeSpeaker.ts`](../backend-api/src/services/crop/activeSpeaker.ts). "Who is
talking" is the hard part. Per-frame motion fails — both people move, trees sway,
hands gesture. The robust signal (the basis of SyncNet/TalkNet) is **temporal
correlation between a face's motion and the audio envelope**: the speaker's
mouth/jaw moves *in sync* with the speech they produce. For each head region we
pool its motion into a time series and, over a sliding ~2.5 s window, compute the
Pearson correlation of (region motion) vs (audio RMS). The region whose motion
tracks the audio is the speaker. Background motion and the listener's idle motion
are uncorrelated with the current speech → they cancel. **This works even for two
same-gender hosts**, where pitch is useless.

**Pitch threshold + gender→side (secondary)** —
[`speaker.ts`](../backend-api/src/services/crop/speaker.ts). A self-calibrating
F0 threshold (1-D k-means valley, falls back to 160 Hz) labels each window
male/female. The AV-active series then *calibrates* gender→region (during male
speech, which region did AV flag?), so pitch can fill gaps where the correlation
is briefly ambiguous but the voice is clearly one gender.

### Stage 3 — emit crop_x (second pass, no decode)

Per shot:
- **Not a two-shot** → `crop_x = clamp(interestX)`. A single speaker is followed
  by the interest centroid (skin-dominated, so it sits on the face).
- **Two-shot** → resolve the active region by priority:
  1. **AV-correlation** — direct observation of who is speaking (primary),
  2. **gender → region** — gap-fill when the correlation is ambiguous but pitch
     is clear,
  3. **hold** (silence / ambiguous),

  then pass it through the **speaker debounce**
  ([`debounce.ts`](../backend-api/src/services/crop/debounce.ts), keyed on the
  region id): a switch only commits after **0.8 s** of the new speaker holding the
  floor, the crop **holds** through silence (1.5 s) and ambiguity, and the state
  **resets at shot boundaries**. This suppresses ping-ponging on brief
  interjections.

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

1. **Audio-visual correlation for active-speaker detection** — the headline
   change. Correlating each face's motion with the audio envelope robustly picks
   the talker, rejecting background sway and listener fidgeting, and **works for
   two same-gender hosts** (where the reference's pitch-only approach can't).
   Validated end-to-end on a synthetic two-shot with identical voices.
2. **Per-shot head localization** — the reference localised once globally, which
   collapses to a single false head when a clip mixes a two-shot with B-roll /
   single close-ups (the real failure the user hit). Localizing per shot fixes it.
3. **Self-calibrating pitch threshold** (k-means valley) instead of a fixed
   160 Hz — used now only as a secondary gap-filler.
4. **Sub-sample F0** via parabolic interpolation + **octave-error guard** —
   recovers 90–300 Hz tones to < 1 Hz.
5. **Bimodality/valley gate** on head detection — no false two-shots on
   single-speaker or animated content.
6. **Face-band-restricted motion & skin** + lowered motion floor (catches lip
   micro-movements at the 320×180 analysis resolution).
7. **Median prefilter** before Gaussian smoothing — removes one-frame glitches.
8. **4 fps** sampling (fine enough for AV correlation), **one video decode**
   (RGB → gray in JS). ~50× realtime end-to-end.

A precise face detector can still be slotted in via the `FaceHook` interface in
`sceneAnalyzer.ts` — it would replace the heuristic head locator and sharpen the
per-region motion windows; everything downstream (AV correlation, debounce,
smoothing) is unchanged.

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
  headLocator.ts    per-shot static-camera head localization (bimodality/valley gate)
  activeSpeaker.ts  audio-visual correlation — region motion vs audio envelope
  speaker.ts        pitch labelling + self-calibrating threshold (secondary signal)
  debounce.ts       region-continuity state machine
  smoother.ts       per-shot median + gaussian, hard reset at cuts
  cropProcessor.ts  per-shot orchestrator → CropMetadata
  runCropAnalysis.ts background job + triggers + status tracking
  __tests__/dsp.test.ts            11 unit tests (FFT, F0, saliency, threshold, clamp)
  __tests__/activeSpeaker.test.ts   5 unit tests (AV correlation, calibration)

client-web/components/viewer/
  useCropOverlay.ts  runtime portrait transform (object-fit cover + object-position)
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
