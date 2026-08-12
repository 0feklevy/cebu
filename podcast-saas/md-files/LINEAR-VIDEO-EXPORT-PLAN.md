# Linear Video Export — findings and plan

**Status: DRAFT FOR REVIEW. Not implementation-ready.** One scope question (§1) has to be answered
before the architecture is decidable, and it changes the size of this feature by roughly 10×.

Branch `feat/linear-video-export`, based on `douplicate` @ `e9e6273`.

Everything marked **[measured]** was verified empirically — against the real repo, or against a real
`ffmpeg 8.1.2` with synthetic sources deliberately shaped like this problem. Everything else is
reasoning, and is labelled as such. Where research could not settle a question, it says so instead
of guessing.

---

## 1. THE BLOCKING QUESTION — what counts as a simulation section?

The request contains two statements that cannot both be implemented as written.

> *"לתעד capture את הסימולציה עם הminimal ui and auto script בשניות של ה section… ה capture of the
> simulation דורש המון מחשבה שיהיה מדויק"*

> *"Simulation / Show full simulation לא יהיו חלק מהרנדור הסופי של הוידיאו. רק Upload new clip /
> Existing clip"*

**What the code actually says.** There is no per-section "simulation source" field — no `sim_source`,
no `source_mode`, nothing of that shape in `timeline_sections`, `sim_meta`, or any shared type. The
three options named are three items in the timeline's **"+" (add to end) menu**, and they produce
different section *types*:

| Menu item | `TimelinePanel.tsx` | What it creates |
|---|---|---|
| **Upload new clip** | `:2157` → `handleUploadNewClip` | **No section.** Opens the upload flow; creates a `video_files` row |
| **Existing clip** | `:2168` → `handleAppendSection('clip')` | section `type: 'clip'` |
| **Show full simulation** | `:2183` → `handleAppendSection('simulation')` | section `type: **'simulation'**` |

`timeline_sections.type` is a bare `TEXT NOT NULL` with **no enum and no CHECK** (`schema.ts:640`),
and the shared type is `type: string` (`client-v1.ts:333`). Simulation sections are also created by a
second path — `SectionEditor.tsx:813` PATCHes `type: 'simulation'` when a section is given a
generated simulation.

**So "Show full simulation" is indistinguishable in the data from every other simulation section.**
Excluding `type === 'simulation'` excludes *all* simulation capture — and with it the entire hard
half of the feature.

### The two readings

**(A) Capture embedded simulations; exclude only a "full/explorable" one.**
This matches the first paragraph. It requires a **new signal that does not exist today** — a column
or a `sim_meta` flag — plus the UI to set it, plus a backfill decision for existing sections. The
capture pipeline (§4) is the core of the work.

**(B) Exclude every simulation.**
The export becomes ffmpeg-only: clips, images, B-roll, audio. No headless browser, no time
virtualisation, no capture. Perhaps a week of work instead of a quarter.

**This document plans for (A)** because the request's technical emphasis is unambiguous, and marks
everything that (B) would delete. **Please confirm before implementation starts.** The useful
follow-up question: *as a user, how do you tell the two apart today?* If there is no way, the answer
is (A)-plus-a-new-field, and that field is the first thing to design.

---

## 2. What the export must actually contain

Composition today is **twelve CSS/DOM layers** in `HLSPlayerShell.tsx:452-772`. There is **no canvas
or video compositor anywhere in the viewer** — the browser *is* the compositor.

| # | Layer | Timing source | Offline representable? |
|---|---|---|---|
| 1 | Main video (A/B double-buffered) | concatenated `duration_sec` | yes |
| 2 | Smart portrait crop | `crop_key` keyframes → `object-position` | yes, as a filter |
| 3 | B-roll / clip overlay | `global_offset_sec` | yes |
| 4 | Image clips (Ken Burns) | `videoOffset + start_sec` | CSS `@keyframes` → `zoompan`, awkward |
| 5 | **Avatar circles** | live FFT of playing audio | **NO — see below** |
| 6 | Simulation pool | segment-local window | only by capture |
| 7 | Captions | segment-local VTT | yes, but see §5 |
| 8 | **Guidance narration** | events fired from inside the sim | **NO — see below** |
| 9 | Audio cutaways / music | `global_offset_sec` | yes |

### Three findings that change the design

**Avatar circles cannot be derived from the database.** They are a radial bar visualiser drawn to a
2D canvas every rAF, fed by a live `AnalyserNode` tapping the playing `<video>`
(`lib/avatarAudioGraph.ts:31-45`, `fftSize 1024`). Speaker attribution falls back through
`speaker_timeline` → FFT pitch band → everyone. Reproducing this in ffmpeg means reimplementing the
FFT *and* the easing. **This alone pushes the architecture toward browser capture**, because the
component already does it correctly in a browser.

**Guidance narration is not schedulable.** Cues fire from `guidanceCue` postMessages emitted by the
running simulation in response to interaction, throttled at 12 s and *dropped* if one is queued
(`useProjectPlayer.ts:3160-3167`, `:1319-1330`). There is no offline timeline for it. It is either
captured live as part of the section's audio, or omitted — and omission must be a **recorded warning
in the plan**, never a silent absence.

**B-roll is silent in the viewer today.** Both b-roll `<video>` elements carry the `muted` attribute
in JSX (`HLSPlayerShell.tsx:500,514`), and `applyMediaVolume` never touches them. `broll_volume` is
stored, sent and applied to `.volume` — inaudible while `muted`. **An export that honours
`broll_volume` would produce more audio than the product plays.** That is a product decision, not a
bug to fix silently: match the viewer, or fix the viewer first.

---

## 3. The exclusion predicate, whichever reading wins

Matching what `VideoEditor.tsx:519,731,788` and `buildPlayerConfig.ts:591,622` already do:

```ts
EXCLUDE: s.type === 'simulation'                                  // reading (B), or (A)+flag
INCLUDE: s.type === 'clip' && !!s.clip_source_video_id            // trimmed library video
         s.type === 'clip' && !!s.clip_source_image_id            // still image
```

**Both halves are required.** Type alone admits unconfigured sections; the FK alone admits stale
leftovers — `SectionEditor.handleSave` only sends `clip_source_*` when `type === 'clip'`
(`:1190-1195`), so switching a section clip→simulation leaves `clip_source_video_id` populated, and
simulation→clip leaves `simulation_id`/`simulation_url`/`sim_meta` populated. The product already
treats type as authoritative (`sectionKindLabel`, `TimelinePanel.tsx:55-62`).

---

## 4. Capturing a simulation

> **PENDING — deep research on deterministic capture is still running.** This section will be
> completed with the comparison of time-virtualisation approaches (`timecut`, Remotion, CDP
> `Emulation.setVirtualTimePolicy`, `--deterministic-mode`), headless WebGL viability, and the audio
> question. What follows is what the *codebase* already constrains, which is settled.

### Constraints that are already certain

**There is no deterministic clock.** Neither the v2 bridge nor the v3 protocol has `STEP`, `SEEK` or
`SET_TIME`; there is no "script finished" event and no script duration anywhere. A section runs for
exactly `end_sec - start_sec`, an author-dragged value capped at 15 s (`TimelinePanel.tsx:26`). Sims
advance on wall-clock rAF delta — and the audit already records that **"weak FPS changes effective
simulated time"** (`SIMULATION-VIDEO-PIPELINE-DEEP-AUDIT.md:532`). A renderer slower than real time
does not merely stutter; it changes what the physics does.

**CSP pins who may frame a simulation.** `frame-ancestors ${browserOrigins()}` —
`sim-public.controller.ts:169,184`, where `browserOrigins()` is app + admin (+ localhost off-prod).
**A bespoke capture harness on any other origin renders blank.** The capture page must be served
from an approved origin, or navigate directly to the simulation as the top-level document.

**The frame is cross-origin**, so there is no DOM reach-in and no `captureStream` on its content —
everything is postMessage. `simple_ui` and `auto_script` travel as **startScript params**, not URL
params (`lib/sim/protocol.ts:71-75`), with `hideSelectors` pre-applied before first paint via the
`#simboot` fragment.

**Prior art exists, and it works headless.** `client-web/e2e/viewer-e2e.spec.ts` drives the *real*
viewer with a mocked player-config, 1700 lines of scenarios including post-roll and direct seeks
into a simulation. And `sim-canary.spec.ts:865-880` already screenshots a live sim frame
(`iframe.elementHandle().screenshot()`) and hashes pairs to detect animation, with
`deviceScaleFactor: 1` load-bearing. **This is the strongest evidence the capture is achievable**,
and the right place to start.

**Post-roll simulations pause the clock and wait for a click** (`useProjectPlayer.ts:1948-1957`,
`:3000-3016`). A capture host must decide what a post-roll section means in a linear video — most
likely "play for its authored `end_sec - start_sec`, then continue" — and that is a product
decision.

**Branching has no canonical linear path**, and it disables every flat overlay
(`:2349,2394,2436`). A flat MP4 needs a path-selection policy; `default_edge_id` is the obvious
default, but this must be decided explicitly rather than fall out of whatever the code happens to do.

---

## 5. Assembling the file — measured

### Splice with one `filter_complex` graph, not the concat demuxer

**[measured]** Concatenating a main video, a silent 720p25 capture, and an anamorphic 60fps B-roll
with the concat demuxer and `-c copy` **exits 0** and produces a silently corrupt file: video
`17.000s` vs audio `15.640s` — **1.36 s of A/V drift baked in** — frame geometry changing mid-stream
inside a container declaring 1920×1080, and 44.1 kHz mono packets copied into a stream declared
48 kHz stereo.

The working shape is `trim`/`atrim` + `setpts`/`asetpts` + the `concat` **filter**, over a canonical
grid every branch is normalised onto. **[measured]** that produced `12.000s` / exactly 360 frames of
video and `12.000s` of audio, both starting at 0. Zero drift.

A filter output label may be read exactly once, so the main video's normalised branch must be
`split` as many times as it is spliced — easy to miss, and it fails loudly.

**Stream copy is essentially never safe here.** **[measured]** asking for `[3.0, 5.0)` with `-c copy`
returned content starting at the keyframe at **2.0 s** — a full second of unrequested material — and
video/audio already disagreed by 53 ms on that single cut. The one worthwhile fast path is a project
with no sections and no overlays at all, which degenerates to a remux.

### Normalisation, and a bug in the existing transcoder

**[measured]** `HLSTranscoder.buildTierArgs` uses `scale=…:force_original_aspect_ratio=decrease,pad=…`
**with no `setsar`**. Applied to anamorphic input (1440×1080, SAR 4:3) it produces a frame that is
**both pillarboxed and stretched** — `SAR 4:3 / DAR 64:27`, leftmost 200 px black. The correct form
squares the pixels first:

```
scale=trunc(iw*sar/2)*2:ih,setsar=1,
scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1
```

**[measured]** that fills the frame at `SAR 1:1 / DAR 16:9`. The export must use this; **`HLSTranscoder`
deserves its own ticket.** Also note `concat` does *not* error on mismatched SAR — **[measured]** it
silently adopts the first input's, turning a mismatch into a geometry bug in one section.

### `between()` is the wrong operator, everywhere

**[measured]** `between(t,X,Y)` is a **closed** interval; the schema's windows are `[start, end)`.
For two sections sharing a boundary at 6.0 s, `between()` draws **both** on the frame at `t=6.0` —
one frame of double-exposure at every seam in the project. Use `gte(t,S)*lt(t,E)`, from a single
helper that is the only place an enable expression is constructed.

### Overlays are nearly free — if their inputs are bounded

**[measured]**, 12 s of 1080p30 with timed 240×240 RGBA overlays:

| Configuration | Wall time | vs baseline |
|---|---:|---:|
| No overlays | 1.80 s | 1.00× |
| 100 overlays, `enable=` only | 8.42 s | **4.7×** |
| 100 overlays, **input-bounded** | **2.30 s** | **1.28×** |

`enable=` is **not** an optimisation: a disabled `overlay` still runs framesync, and its input branch
keeps decoding and scaling a frame for every output frame. Bounding the input (`-t`, `setpts=PTS+start/TB`,
`repeatlast=0`, `eof_action=pass`) is what makes overlays cheap.

Two traps found while validating that: **[measured]** `-loop 1 -i file.png` defaults to **25 fps**
regardless of output rate (put `-framerate <grid>` on every image input), and `eof_action=pass` is
mandatory or the main video ends when the first overlay input does.

### Captions: render to PNG, do not use `drawtext`

**[measured]** this ffmpeg build has **no `drawtext`, no `subtitles`, no `ass`** — built without
libfreetype and libass. Beyond availability: captions live as **segment-local WebVTT** in
`video_files.captions_vtt` and must be re-timed to absolute time *and* around every splice; and the
viewer doesn't use a `<track>` element at all — it parses VTT and renders into a styled `<div>`.
Reproducing that with `drawtext` means re-implementing wrapping, the translucent box and the font
stack, and it still won't match. **Rasterise each cue to RGBA PNG and overlay it** with the bounded
pattern above. **[measured]** cost was unmeasurable, and the styling then comes from one place.

**Probe filter availability at job start and fail fast** — otherwise this fails late, inside a
multi-minute encode. Also: `-filter_complex_script` is **deprecated** in ffmpeg 8 **[measured]**;
use `-/filter_complex <file>`. (`ffmpegAudio.ts:179` uses the old spelling today.) Writing the graph
to a file remains necessary — this graph will dwarf the podcast mixer's.

### Audio

Follow the existing `mixTimeline` (`ffmpegAudio.ts:142-180`) — `adelay` onto an absolute timeline,
`amix`, `alimiter`, two-pass `loudnorm`. Two things it already gets right that the export must not
regress:

**`amix=normalize=0`.** **[measured]** with the default `normalize=1`, adding a music bed made the
narration **5 dB quieter** (−27.1 → −32.1 dB). With `normalize=0` it stayed at −26.1 dB.

**Two-pass `loudnorm`.** Not for determinism — **[measured]** single-pass is byte-identical across
runs — but because single-pass is *dynamic* and pumps on material that swings between narration,
silence during a simulation, and music. Two-pass applies a linear gain.

Add `dropout_transition=0` (the default is a 2-second volume ramp whenever any input ends), and
`adelay=…:all=1` (without `:all=1` only the first channel is delayed and the stereo image tears).

**Ducking is a real trade-off with no clean answer.** `sidechaincompress`'s `threshold` is linear
amplitude, and **[measured]** duck depth swings from −1.6 dB to −22.4 dB across plausible values —
so it depends on the narration's absolute level and is *not* reproducible across projects unless
narration is normalised before the sidechain. The alternative, a `volume` automation expression over
the known section windows, is less natural-sounding and perfectly deterministic. For an export that
should be byte-stable, that may be the right trade.

### The silent capture is the highest-probability failure

**[measured]** referencing `[N:a]` when input N has no audio fails **loudly and immediately** — the
good outcome. The danger is under-length synthesised silence: if it is short, `concat` still advances
video by the video segment's length and audio falls behind **cumulatively**. Prefer `apad` + `atrim`
so the segment's audio length is a function of *one* number (the section window) rather than two that
must agree.

---

## 6. Long-job shape — copy `project_duplicate`, plus one thing it doesn't need

`ProjectDuplicationService` is the right template and its reasoning transfers: a dedicated table
(not the dead `jobs` table), `claim()` as a conditional UPDATE, an unref'd 15 s timer heartbeat,
fenced writes on every subsequent update, and a `plan` jsonb written before work starts. For an
export the plan is *more* valuable — it is the only way to answer "why does the master look like
that?" after the temp directory is gone. `podcast_mix_export`
(`runPodcastMixExport.ts`) is the closer structural analogue for a media export and is worth reading
whole.

Add **`cancel_requested`**: unlike a byte copy, an encode is worth interrupting.

**Progress.** `-progress pipe:1 -stats_period 1`, read **stdout** (the repo's `runProcess`
captures only stderr today). **[measured] trap: `out_time_ms` is microseconds, not milliseconds** —
at `out_time=00:00:00.500000`, `out_time_ms=500000`. A parser treating it as ms reports 1000× too
fast. Parse `out_time_us` or `out_time`. Watch `dup_frames`/`drop_frames`: non-zero means the CFR
conversion is papering over something.

**Cancellation, and the trap inside it.** **[measured]** SIGTERM makes ffmpeg finalise the container:
exit **255**, and the partial file is a **valid, playable MP4**. SIGKILL gives `moov atom not found`.
So cancel with SIGTERM, escalate after ~5 s. **But the corollary is dangerous: a cancelled export
leaves a well-formed, probeable MP4 at the output path.** Any success check of the form "does the
output exist and parse?" will publish a truncated master. Gate on **exit code 0**, then assert the
output's duration against the planned timeline within a frame — the same discipline as
`assertTierConformance` — *before* upload, and write to a versioned write-once key.

**Resumability: don't.** There is no checkpoint inside a single encode. Segment-level resume
reintroduces exactly the seam problems §5 avoids. Recommendation: single-graph encode, no resume,
make retry cheap. Revisit only if measured encode times make retry painful.

---

## 7. Output defaults

Consistent with the 1080p row of `TIERS` — `high@4.0`, `libx264 -preset fast`, `yuv420p`,
`-fps_mode cfr -r 30`, `-g 60 -keyint_min 60 -sc_threshold 0 -flags +cgop`, `aac 192k`,
`+faststart`. Three deliberate departures, each with a reason:

1. **CRF ~20 instead of capped bitrate** — ABR switching needs predictable per-tier bandwidth; a
   download does not, and CRF is better per byte on a timeline whose complexity varies wildly.
   (Capped is a legitimate product choice if predictable file size matters more.)
2. **48 kHz, not the ladder's 44100** — every video source here is 48 kHz. Flagged as an intentional
   inconsistency with the podcast pipeline, whose TTS sources are 44.1.
3. **No `-force_key_frames`** — a single file needs no segment alignment.

**Canonical grid from the main video**, clamped to 1080p — *not* from the highest-resolution source,
or one 4K B-roll silently promotes the whole export to a 4K encode past level 4.0. Record the chosen
grid in the plan.

---

## 8. Where the button goes

`client-web/components/ProjectHeader.tsx` — Preview is the `<a>` at **:166-180**. "Left of Preview"
means inserting between the block closing at `:164` and that anchor. Mirror its existing gate:
`noVideos = !hasMainVideo`.

Note `backend-api/src/controllers/stubs.ts:22-30` already reserves the URL space and returns 501:
`POST /projects/:id/render`, `GET /projects/:id/render/:render_id`, `POST /projects/:id/export`.

---

## 9. The five things most likely to go wrong

1. **A silent simulation capture desyncs everything after it** — the normal state for a screen
   capture, and the symptom appears only late in the file. Defence: `apad`+`atrim` from the section
   window; assert audio and video stream durations agree within a frame, as a gate before upload.
2. **A cancelled encode is published as a finished master** — SIGTERM leaves a valid truncated MP4.
   Defence: gate on exit code 0 *and* a duration assertion, then upload, then flip the pointer.
3. **One-frame glitches at every seam** from `between()`. Defence: one helper emitting
   `gte(t,S)*lt(t,E)`; never hand-write `between` in this codebase.
4. **Geometry corruption on anamorphic or off-grid sources** — three compounding, all silent: the
   SAR bug, `concat` adopting the first input's SAR, and image inputs defaulting to 25 fps. Defence:
   one shared normalisation function applied to every branch without exception.
5. **It only fails at full scale** — hundreds of graph nodes, argv overflow, the overlay cost cliff,
   multi-GB work directories, and possibly no `drawtext` on the box. Defence: bound every overlay
   input, write the graph to a file, probe filters at job start, check free disk against an estimate,
   and **build a genuine 20-minute fixture early** — none of this surfaces at 12 seconds.

---

## 10. Open questions for you

1. **§1 — the scope question.** Reading (A) or (B)? If (A), how do you distinguish a "full
   simulation" section from an embedded one today?
2. **Simulation audio (WebAudio).** Must it be in the export? Frame-locked capture breaks real-time
   audio by construction, so this is a genuine fork in the capture design.
3. **B-roll audio.** The viewer mutes it. Should the export match the viewer, or honour the stored
   `broll_volume`?
4. **Branching projects.** Which path does a linear video take? `default_edge_id`, or refuse to
   export a branching project?
5. **Post-roll simulations.** In the viewer they pause and wait for a click. In a linear video,
   presumably they play for their authored duration — confirm.
6. **Guidance narration.** Its cues are interaction-driven and undeterministic. Omit with a recorded
   warning, or capture whatever the unattended run happens to fire?

---

## 11. Honest gaps in this document

- **§4 is incomplete** — the deterministic-capture research is still running.
- **Whether the production ffmpeg has `drawtext`/`libass` is unverified.** Only this machine was
  measured. The PNG-overlay path sidesteps it entirely.
- **No estimate of encode time or cost** for a realistic project; that needs the 20-minute fixture.
- **Nothing here has been prototyped.** Every ffmpeg claim is measured on synthetic sources shaped
  like the problem, not on a real project's media.
