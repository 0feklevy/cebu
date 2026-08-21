# Crop eval harness

The number every change to `src/services/crop/` has to move.

| | |
|---|---|
| `run-eval.ts` | scores the real pipeline over the synthetic fixtures — `pnpm --filter backend-api eval:crop` |
| `results/` | committed baselines, keyed `<algo>@<version>.json`; `cropEval.test.ts` holds the pipeline to them |
| `annotate.html` | the annotation tool (P0.2) — open it directly, no server, no build |
| `labels/` | hand labels for the real-footage eval set (P0.3), one JSON per clip |
| `sweep-av.ts` | parameter sweep over the AV correlation gate |

Two label sets exist and they answer different questions. The **synthetic fixtures**
(`src/services/crop/eval/fixtures.ts`) are flat-shaded discs; they measure *mechanisms* — did this
change move the defect it claims to move — and their scores are never field accuracy. The
**hand-labelled clips** described below measure the crop on real footage, and are the only set the
P2.8 go/no-go may quote.

---

## The annotation tool

```
open backend-api/scripts/crop-eval/annotate.html      # macOS; or double-click it
```

Choose a video (or drop it on the page). It is read through a blob URL in that tab and goes
nowhere else — the page ships a `Content-Security-Policy` with `connect-src 'none'`, so the browser
itself refuses every network request the page could make. Verified in a scripted Chromium run: zero
requests off `file:`/`blob:` for a full label-and-export session.

The clip is sampled at **2 fps**. Each sampled frame gets one number — `crop_x` — and one subject
state. Arrow keys nudge, drag drops the window where you point, and `.` / Space advance. The value
of the frame you were just on is carried forward as the next frame's default, so a static shot is
laboured over once and then held down through.

`Download labels JSON` writes `<clip_id>.labels.json`. Drop that file back on the page to resume.

---

## The labelling convention

**These labels are the ground truth for every crop claim this project will make.** An ambiguous
convention does not produce noisy data, it produces confidently wrong data, because two labellers
resolve the ambiguity differently and the disagreement is invisible in the score. So: the rules
below are the whole contract, and they are short on purpose.

### What `crop_x` means

`crop_x` is the **centre of the 9:16 window**, in frame-width units — `0` is the left edge of the
source frame, `1` the right. It is *not* the speaker's face position. Those differ, and when they
do, the window wins:

- Frame the person **who holds the floor** — who is talking, or who the viewer is meant to be
  watching in a beat of silence.
- Give them **the space they are looking or gesturing into**. A speaker facing right sits left of
  the window centre. Centring the face and cutting off their eyeline is a worse crop and must be
  labelled as such.
- If two people share the moment (an interruption, a laugh, a handshake), put the window where a
  human editor would: usually not centred between them, but on the one carrying the beat.
- Never label a value the crop cannot reach. The window is `height × 9/16` wide, so on 16:9 it
  spans 0.316 of the frame and `crop_x` is confined to `[0.158, 0.842]`. The tool clamps for you;
  a file with an out-of-range value is rejected by the loader.

Label what the **frame** should be, not what the algorithm could plausibly find. The set exists to
tell us where the algorithm is wrong.

### When nobody is on screen

Press `2` — **Nobody**. B-roll, slides, a title card, an empty set, a graphic with no person in it.

Ground truth for those frames becomes **the centre of the frame**, `x = 0.5`, and the `crop_x` you
happen to be showing is ignored by the scorer. This is deliberate: with no subject there is no
non-arbitrary framing, and centre is the only answer that does not encode a preference. It also
gives the null-hypothesis case (D5) a target — an algorithm that keeps tracking furniture through
a title card is *supposed* to lose points here, and it only can if these frames are labelled
`none` rather than left as `subject` with a stale carried-forward x.

Do **not** use `none` for "a person is there but I can't tell who's talking". That is the next rule.

### When the frame is genuinely undecidable

Press `3` — **Ambiguous**. Two people, both silent; a crowd with no lead; a frame where two
framings are equally defensible and you would accept either from an editor.

Ambiguous frames are **excluded from accuracy scoring entirely** — they leave the mIoU denominator
and are counted only for stability. That makes the state a loaded weapon: marking a hard frame
ambiguous does not record that it was hard, it deletes the evidence. Use it only when you could not
choose *even knowing which answer the algorithm gave*. If you can name a reason to prefer one side,
it is a `subject` frame and your reason is the label.

Expect this to be a small single-digit percentage of a clip. If a whole clip is ambiguous, it does
not belong in the eval set.

### Across a cut

Press `C` on the **first frame of the new shot** — the first sampled frame that shows the new
angle, not the last frame of the old one.

Marking a cut does two things. It records the cut time in `cuts[]`, which is the ground truth the
shot detector is scored against (P1.6 — the same-room reverse-angle cuts the current global
histogram cannot see). And it **stops carry-forward at that frame**: the new shot inherits nothing,
so you have to look at it and say where the window goes. That is the point. Carrying a framing
across a cut is exactly the mistake the pipeline makes today, and a label set that made the same
mistake would score the bug as correct.

At 2 fps a cut lands somewhere inside a 500 ms window and you are marking the first sample that
*shows* the new shot; that quantisation is inherent to the cadence and is accounted for when cut
detection is scored. Do not try to be more precise than the sampling.

A camera move, a zoom, or a subject walking across frame is **not** a cut. Those are one shot, and
the crop should follow smoothly — label them frame by frame and leave `cuts` alone.

### Carry-forward and "reviewed"

Every frame always has a value: an unvisited frame shows the previous frame's. `confirmed` records
whether **a human had that exact frame on screen** — nothing stronger. It is not a quality rating
and it is not a second opinion. Its only job is to distinguish frames a labeller looked at from
frames a carried value passed through, so the tool's progress badge and the export warning mean
something. A file is finished when it reads `n/n frames reviewed`.

Per R-16 the intended workflow is: an agent pre-labels a clip, the owner steps through and
corrects. Both passes leave `confirmed: true` — the correction pass is a human at every frame, and
that is the claim the field records.

---

## The file format

One JSON per clip, snake_case throughout, parsed by
[`src/services/crop/eval/labels.ts`](../../src/services/crop/eval/labels.ts):

```jsonc
{
  "schema": "flowvid.crop-labels/1",
  "clip_id": "ep12-two-shot-a",
  "category": "two_shot",
  "source": { "file": "ep12-two-shot-a.mp4", "sha256": "…64 hex…", "bytes": 18234112 },
  "width": 1920, "height": 1080,
  "duration_sec": 24,
  "sample_fps": 2,
  "crop_aspect": 0.5625,
  "labelled_at": "2026-08-21T17:45:54.194Z",
  "labeller": "ofek",
  "cuts": [4, 12.5],
  "labels": [
    { "frame_idx": 0, "t": 0, "crop_x": 0.35, "subject": "subject", "confirmed": true }
  ]
}
```

`parseLabelFile()` turns it into a clip the **real** scorer accepts — `scoreClip()` from
`metrics.ts`, the same function the synthetic harness and the committed baselines use. There is no
second scoring path for hand labels.

**What these labels can and cannot measure.** The three subject states map exactly onto the three
branches `targetX()` already had, so mIoU, IoU@0.5, jitter, travel, clamp-pinning and centre-share
are unaffected. Two metrics degrade, visibly:

- `out_of_frame` becomes a **marker**-outside-window rate, not a face-box-outside-window rate. A
  crop can contain the labelled point and still slice the speaker in half, so this is a strictly
  weaker lower bound than the LIVE-YT VC / RetargetVid metric of the same name. Do not quote it as
  that metric.
- `attribution` is **not measurable at all** and is reported as `null`. It asks which of several
  faces the crop chose, and a crop-x label does not enumerate faces. Attribution numbers can only
  come from the synthetic set, where the cast is known by construction.

## Where the clips live

**Clips never enter git** — licensing, size, and most of them are customer footage. They live in a
local directory; only `labels/*.json` is committed, and each one carries its source file's
`sha256`, so a future eval run can prove it scored the same media the labels were made against.
Keep the media directory path out of the repo too; the label file names the file, not the path.

## Regenerating the contract fixture

`src/services/crop/eval/__fixtures__/annotator-roundtrip.labels.json` is a real export from
`annotate.html`, driven in a scripted Chromium over a 12 s `testsrc2` clip, and `labels.test.ts`
round-trips it through the loader and the scorer. It is a contract fixture, not a label — it is not
part of the eval set and must not be added to `labels/`.

`annotate.html` keeps its own copy of the schema string and its own validator, because a
self-contained HTML file cannot import TypeScript. **If you change either copy, regenerate the
fixture** by labelling a short clip end-to-end in the tool and replacing the file — the test
compares the artefact's constants against the TypeScript ones, so a drift that gets regenerated is
caught, and a drift that does not get regenerated is not. That gap is the price of the tool having
no build step.
