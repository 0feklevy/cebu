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

### The two facts that decide the architecture

**(a) Deterministic frame control and GPU WebGL are mutually exclusive in Chrome.** From Chromium's
own CDP definition of `Target.createTarget`:

> `enableBeginFrameControl` — "Whether BeginFrames for this target will be controlled via DevTools
> (**headless shell only**, not supported on MacOS yet, false by default)."
> — [Target.pdl, chromium/main](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/public/devtools_protocol/domains/Target.pdl)

`chrome-headless-shell` is the old headless architecture and does not use a hardware GPU. So
deterministic capture ⇒ **software WebGL**. Our deployment is a GPU-less AWS VM, so we lose nothing
we had.

**(b) SwiftShader's WebGL fallback was REMOVED in Chrome M139. Stable is 151.**

> "SwiftShader has been used to support WebGL on systems without GPU acceleration such as headless
> systems or virtual machines but has been deprecated due to security issues. **Starting in M139,
> WebGL context creation will fail** when it would have otherwise used SwiftShader. … This is a
> temporary policy which will be removed in the future."
> — [EnableUnsafeSwiftShader.yaml, chromium/main](https://raw.githubusercontent.com/chromium/chromium/main/components/policy/resources/templates/policy_definitions/Miscellaneous/EnableUnsafeSwiftShader.yaml)

**A WebGL simulation on a GPU-less box gets a failed context and renders nothing — no crash, no
non-zero exit, just a black canvas.** Our generated simulations almost certainly do not test for
context-creation failure. `--enable-unsafe-swiftshader` defers it, and Chromium says that escape
hatch is explicitly temporary. This needs a monitored dependency and a pinned Chrome, not a flag
someone sets once.

### Navigate directly to the simulation, do not capture the iframe

You **cannot** draw an iframe into a canvas at all — the HTML spec's `CanvasImageSource` typedef is
exhaustive and includes neither `HTMLIFrameElement` nor `Window`. CDP capture works because it
operates at the compositor, below the security boundary. But the clean move is to make the
simulation the **top-level document**: it removes the cross-origin problem, the `frame-ancestors`
problem (§4 constraints) and the fragile "inject before the child's own scripts" problem in one step.

**Verified against our v2 protocol:** the child listens on `window` and replies via
`window.parent.postMessage(…, '*')` (`SimulationService.ts:255,273,706,772`). Loaded top-level,
`window.parent === window`, so the capture host can send `startScript` and receive
`SIM_READY`/`SCRIPT_APPLIED`/`SIM_PAINTED` on the same window. The `?section=&v=` query and the
`#simboot=` fragment must be preserved or we lose dispatch and the pre-paint UI cloak.

⚠️ **The v3 protocol will NOT initiate top-level.** `simRuntimeChild.ts:1198` guards with
`if (win.parent && win.parent !== win)`, so the MessagePort handshake never starts. The capture host
must speak **v2** — which is what every stored package speaks anyway, but it means the render path
deliberately uses the older protocol and someone will eventually "fix" that unless it is documented.

### Time virtualisation needs BOTH halves

Chromium engineer Eric Seckler, answering exactly this question on headless-dev:

> "You can use virtual time together with a manual rendering mode to render animations at a custom,
> deterministic frame rate."
> — [headless-dev](https://groups.google.com/a/chromium.org/g/headless-dev/c/s8ttGCh8jzM)

- **Virtual time** — a JS shim over `Date`, `performance.now`, `setTimeout`/`setInterval`, `rAF`.
  Governs the page's logic.
- **Manual rendering** — `HeadlessExperimental.beginFrame({frameTimeTicks, interval, screenshot})`.
  Governs the compositor: CSS animations, transitions, and the pixel readback.

**Both are required for us specifically.** Only the shim (timesnap/timecut, CCapture) leaves CSS
animations on the real clock — and our image overlays are CSS `@keyframes`. Only `beginFrame` leaves
`setTimeout` on the real clock — and **our Auto Script loop is `setInterval`-based**
(`SimulationService.ts:854`: *"Use setInterval for animation: step 0.1–0.3, intervalMs 30–150ms"*).

`Emulation.setVirtualTimePolicy` alone is not the answer: it fast-forwards to the *next delayed
task*, not "advance exactly 33.33 ms", and has documented hang reports. Every serious implementation
uses a JS shim instead.

### The comparison

| Approach | Determinism | WebGL headless | Audio | Maturity | Licence |
|---|---|---|---|---|---|
| **`beginFrame` + clock shim** (`puppeteer-capture`) | **Highest** — clock *and* compositor driven | software only | none | v1.58.0, 2026-08-07, CI | **MIT** |
| clock shim + `captureScreenshot` (`timecut`) | rAF/timers only; **CSS animations drift** | yes | none | **stale** — npm 2022, 33 open issues | BSD-3 |
| **Remotion** | highest, but content must be a **pure function of frame number** | yes | assets only | very mature | **proprietary dual-licence** |
| CCapture.js v2 | good | n/a (**canvas only**) | offline analysis | v2.0.0, 2026-07 | MIT |
| `startScreencast`, Playwright video | **none** — real-time, droppable | yes | none | mature | MIT / Apache-2.0 |

**Remotion is out**, and not because of the licence (free only for orgs ≤3 employees). Its model
requires content to be a pure function of frame index — it renders frames across threads in any
order. Our simulations are **stateful**: physics, particle accumulation, `setInterval` automation
with internal position. Adopting it means rewriting the simulation generation contract, not adding
an export.

**CCapture is out** because it captures only the canvas, and Minimal UI deliberately *shows* the
relevant DOM control while hiding the rest.

**Recommendation: start from `puppeteer-capture` (MIT).** It implements the flag set, the frame loop
and the ffmpeg piping already. It **throws on macOS** by design, so local dev needs a Linux container.

### Audio: out of scope for v1, and this is structural

Frame-locked capture and WebAudio are incompatible by construction. `BaseAudioContext.currentTime`
is *"updated by the rendering thread in uniform increments"* — a hardware timestamp
([spec](https://webaudio.github.io/web-audio-api/#rendering-loop)). Virtualise the main thread and
render 1800 frames in 4 minutes of wall time, and the graph produces **4 minutes of audio for 60
seconds of video**.

Every tool surveyed records **no audio at all**. The one project that attacked it (Replit) solved
*asset playback* by intercepting `fetch` and reconstructing an ffmpeg chain — and states its residual
gap plainly: *"Audio from programmatically generated sources (OscillatorNode, AudioWorkletNode) …
remain uncaptured."* Synthesised WebAudio is unsolved by anyone I could find.

Our main video, B-roll, audio cutaways and guidance TTS are all **assets with known timing** — those
mix in ffmpeg, which we already do. Simulation-synthesised audio is the only casualty. Say so in the
export UI rather than shipping a silent gap.

### Determinism of the simulation itself

**No capture tool seeds the PRNG.** I read `puppeteer-capture`'s injector: it hooks `Date`,
`performance.now`, the timers and `rAF` — **not `Math.random`**. Inject a seeded PRNG at document
start, seeded from something stable; **`configHash` is the natural choice**, since it already
participates in the identity discipline this codebase enforces. Inline a ~10-line mulberry32 rather
than depending on `seedrandom` (2019, licence not auto-detected).

**Good news:** zero uses of `Math.random` in `backend-api/src/services/simulation/`. The exposure is
in generated bodies and any library they pull.

### The repo-specific hazard I would flag hardest

Our bridge **already wraps `window.requestAnimationFrame`** — `__SIM_RAF_GATE__` keeps `raw` and
`sys` handles so system scripts schedule on the *unwrapped* rAF while sims use the wrapped one
(`SimulationService.ts:330-352, 636-640`). A capture clock shim installed at document start becomes
the thing the gate then wraps, so the gate's "unwrapped" handles will in fact be **virtual too**.

That is probably what we want — but it is an ordering-dependent interaction between two rAF
wrappers, and the `SIM_PAINTED` paint gate sits on top of it. **This is where a "sim never signals
painted, capture hangs" bug will live.** Design the injection order explicitly and test it.

### Throughput — estimate only

CDP screenshots have long been reported at 60–90 ms each. At 30 fps a 30-second section is 900
frames → order of **2–5 minutes wall-clock per section**, more on heavy scenes under SwiftShader.
Fine for a background job with progress; **not** for anything synchronous. Mirror the
`FFMPEG_CONCURRENCY` limiter for browser instances — Replit runs render concurrency 1.

**⚠️ The #1 spike before committing to any of this:** Mesa llvmpipe via `--use-angle=gl` measured
**24 s → 6 s** versus SwiftShader on a WebGL-heavy page
([microlink](https://microlink.io/blog/webgl-without-a-gpu)) — but *both* published llvmpipe
benchmarks ran with a display surface (Xvfb/headed). **Whether `chrome-headless-shell`, which has no
display surface, can drive llvmpipe at all is unverified**, and it directly determines throughput.
Also from that write-up: `--disable-gpu` silently forces SwiftShader back on, and `--in-process-gpu`
kills the GL surface ANGLE needs. Neither flag, ever.

### Corrections and additions from a second research pass

**`--deterministic-mode`'s exact expansion**, from `headless/lib/browser/command_line_handler.cc`
(not from documentation): it implies `--enable-begin-frame-control`,
`--run-all-compositor-stages-before-draw`, `--disable-new-content-rendering-timeout`,
`--disable-image-animation-resync`, `--disable-threaded-animation`, `--disable-checker-imaging`.
It does **not** imply `--disable-threaded-scrolling` (that flag no longer exists in `main`) or
`--deterministic-fetch` (removed from Chromium years ago — preload assets and gate on them instead).

**Two hard constraints nobody documents:** it **refuses to start with `--site-per-process`**
(explicit `LOG(ERROR)` + `return false`), and it only works in `chrome-headless-shell` — the flag is
handled in `HeadlessContentMainDelegate::PreBrowserMain()`, which regular Chrome never runs.

**CCapture is not stale — it was rewritten 16 days ago.** v2.0.0 published 2026-07-27 (previous
release was 2018), MIT, 0 open issues. It is now `TimeWarp` (a reusable virtual clock) + `FrameWrap`
(WebCodecs → mp4). Its documented gap is the one that matters to us: **it cannot step CSS/Web
Animations**, and our image overlays are CSS `@keyframes`.

**A codec trap that would bite late.** WebCodecs H.264 is gated on `proprietary_codecs`
(`media/media_options.gni`): **Chrome for Testing has `avc1.*`; vanilla Chromium — including
Playwright's bundled build — does not.** Any in-page WebCodecs path must either use Chrome for
Testing or emit VP9/AV1 and transcode server-side. Also note `VideoEncoder` has **no alpha support**.

**`preserveDrawingBuffer` is a spec-level constraint, not a CCapture quirk.** WebGL 1.0 spec: with
it `false` (the default), using the context as a source image *after the rendering function returns*
is undefined behaviour. That hits `new VideoFrame(canvas)` exactly as hard as `toDataURL`. It is
**not** a problem for `beginFrame` compositor capture — one more reason to prefer it.

**A third viable architecture** worth costing alongside the recommendation: **WebCodecs +
[mediabunny](https://github.com/Vanilagy/mediabunny) + Playwright's [Clock API](https://playwright.dev/docs/clock)**.
Playwright's Clock is a built-in, maintained time shim covering more surface than TimeWarp
(`requestIdleCallback`, `Event.timeStamp`), and mediabunny (MPL-2.0, v1.53.0, 2.19M weekly) has
**superseded `mp4-muxer`**, which now carries a deprecation banner. This owns no third-party capture
dependency at all — attractive for something we maintain long-term — at the cost of building the
frame loop ourselves and inheriting the H.264 issue above.

**[HyperFrames](https://github.com/heygen-com/hyperframes)** (Apache-2.0, 40.7k stars, created
2026-03-10) is the other `beginFrame` implementation, and notably it already does **GPU-completion
gating** — the exact black-frame problem in failure mode 1. But it is five months old at v0.7.x with
roughly two releases a day; worth reading, risky to depend on.

**Physics determinism, checked in the actual bundles:** `cannon-es` has **zero** `Math.random`
occurrences. `Matter.js` has zero and ships its own seeded LCG (`Common._seed`). **Rapier documents
full cross-platform determinism** for its WASM build — if a physics engine is ever chosen for
generated simulations, that is the one.

**`--js-flags=--random-seed=N` works but is the wrong primary mechanism.** V8 seeds xorshift128+ via
`MurmurHash3(seed)`, and every native context reads the *same* flag — so **every frame and every
iframe gets a byte-identical `Math.random()` stream**. Reproducible, but two "independent" components
would produce identical sequences. Use an injected per-context seed as the real mechanism and treat
the flag as a backstop.

**`crypto.getRandomValues` is not seedable by any spec mechanism** — monkey-patch it in the init
script or ban it. (Three.js `generateUUID()` uses `Math.random()`, so patching that covers it.)

### Capture failure modes, ordered by damage

1. **Black frame from failed WebGL context creation** (M139+). Silent — a valid MP4 of nothing.
   *Defence:* `--enable-unsafe-swiftshader`, assert `getContext('webgl2') !== null` in the init
   script, and check frame 1 for non-uniform pixels.
2. **Silent degradation to a 2D fallback** when the GL surface is missing. Output looks plausible and
   is wrong. *Defence:* assert `UNMASKED_RENDERER_WEBGL` matches the expected backend and record it
   in the job row.
3. **`beginFrame` returns no `screenshotData`** — CDP warns capture "can fail … during renderer
   initialization". *Defence:* retry, and **count frames** so a missing one cannot silently shorten
   the clip.
4. **Compositor staleness on the first frames.** *Defence:* ~30 discarded warmup frames (Replit's
   number).
5. **rAF wrapper collision** with `__SIM_RAF_GATE__` → hang. *Defence:* explicit ordering + a bounded
   timeout that fails loudly.
6. **Wrong Chrome binary** → `'HeadlessExperimental.beginFrame' wasn't found`. *Defence:* assert the
   executable is `chrome-headless-shell`. (A widely-cited claim that `beginFrame` was "removed in
   Chromium 147" is **wrong** — the reporter was using system Chromium, not headless shell. Verified
   un-deprecated in `main` today.)
7. **Web Worker / WebAudio loops escaping the virtual clock** — already a documented gap in our own
   `simPause` (`SimulationService.ts:603`).
8. **`/dev/shm` too small in Docker** → renderer crash. *Defence:* `--disable-dev-shm-usage`.
9. **`--enable-unsafe-swiftshader` eventually removed.** Pin Chrome in the image; risk-register it.

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

- **Nothing in §4 has been spiked.** The llvmpipe-under-headless-shell question is unresolved and
  determines throughput; per-frame timing is extrapolated, not measured.
- **Whether the production ffmpeg has `drawtext`/`libass` is unverified.** Only this machine was
  measured. The PNG-overlay path sidesteps it entirely.
- **No estimate of encode time or cost** for a realistic project; that needs the 20-minute fixture.
- **Nothing here has been prototyped.** Every ffmpeg claim is measured on synthetic sources shaped
  like the problem, not on a real project's media.
