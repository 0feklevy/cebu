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

**(b) SwiftShader's WebGL fallback was REMOVED — in M144, not M139. Stable is 151.**

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

### Verified by live measurement against real Chrome binaries

A separate pass drove CDP over `--remote-debugging-pipe` against **`chrome-headless-shell 151`** and
**`Google Chrome 151 --headless`**. These are measurements, not documentation:

| Command | headless-shell 151 | Chrome 151 `--headless` |
|---|---|---|
| `HeadlessExperimental.beginFrame` | `-32000` "BeginFrameControl is not enabled" | **`-32601` "wasn't found"** |
| `Target.createTarget{enableBeginFrameControl}` | honoured | **silently ignored** |
| `Emulation.setVirtualTimePolicy` | works | works |

**The whole `HeadlessExperimental` domain does not exist in the Chrome binary** — method-not-found,
not a permission error. Only `chrome-headless-shell` has it. This also disproves a claim circulating
in several repos that "Chromium 147 removed `beginFrame`": it is present in `main` and answered on
151 headless-shell. The accurate statement is that *Chrome* lost it at M132, when old headless was
split out.

**⚠️ macOS is a hard blocker, from Chromium source** (`headless/lib/browser/protocol/target_handler.cc`):
`#if BUILDFLAG(IS_MAC) … return Response::ServerError("BeginFrameControl is not supported on MacOS yet")`.
**Measured:** that exact error. The frame-control path is therefore **Linux containers only** — local
development on a Mac cannot run it at all, which matches `puppeteer-capture` throwing on darwin.
Plan for a container-based dev loop from day one, not as a week-three discovery.

**`--deterministic-mode` is exactly six switches and a veto**, from
`headless/lib/browser/command_line_handler.cc`. **Measured:** combining it with `--site-per-process`
makes the browser refuse to start with an explicit error. It does **not** touch scrollbars, DPI,
timer throttling, the GPU backend, or network ordering — set `--hide-scrollbars`,
`--force-device-scale-factor=1`, `--force-color-profile=srgb`,
`--disable-background-timer-throttling` and `--mute-audio` ourselves. Chromium's own web-test runner
is a better model than the chrome-launcher list.

**Drop two flags entirely.** `--deterministic-fetch` was deleted in **M69 (2018)** — bisected across
mirror tags — and `--disable-threaded-scrolling` was removed in 2023 ("hasn't actually worked since
the launch of scroll unification"). Both are noise on a modern command line. The widely-copied
chrome-launcher doc that lists them is stale.

**A real risk signal: almost nobody authoritative uses `--deterministic-mode`.** Code search returns
**one** hit in all of Chromium — the definition itself; Chromium's own headless compositor tests
append the individual switches by hand. Zero hits in web-platform-tests, Puppeteer, Playwright,
Percy, Chromatic, BackstopJS, reg-suit. The visual-diffing industry stabilises at the DOM/CSS layer
instead. We would be relying on a lightly-travelled path — worth an explicit risk-register entry and
an abstraction seam in the capture layer.

**`--js-flags=--random-seed=42` measured across a top frame and two iframes:** all three produce the
*identical* sequence, reproducible run to run, and byte-identical between headless-shell and Chrome
at the same V8 version. Reproducible — and it confirms the footgun: two "independent" components
draw the same numbers in seeded mode and different ones in production.

**headless-shell already forces SwiftShader by default** (`headless/public/switches.h`, on
`--enable-gpu`: *"Headless uses swiftshader by default for consistency across headless
environments"*). That is the GL *implementation* choice and does not exempt us from the M139 WebGL
fallback removal, so `--enable-unsafe-swiftshader` is still required. It does reframe the spike:
the question is "can we override the default with llvmpipe", not "can we choose a backend".

### Two corrections to what is written above, from a seventh pass

**The milestone is M144, not M139 — and I had it wrong.** The policy YAML and chromestatus both say
M139, which is where my earlier statement came from. They are wrong. Verified three independent
ways: the commit→milestone mapping (CL 7128438 flips `kAllowSwiftShaderFallback` to *disabled*, which
lands in 144 — CL 5675974 added the flag and the warning back in **M130**); Microsoft's copy of the
same policy — *"Starting in Microsoft Edge version 144, SwiftShader is deprecated… As a result, WebGL
context creation fails"*; and a real regression report of Three.js in headless Docker **working on
143 and failing on 144**, which Ken Russell attributed to exactly this. Does not change the design —
we are on 151 either way — but it does mean anyone testing on ≤143 will not reproduce the failure.

**`--enable-unsafe-swiftshader` is not actually required — and this contradicts most published
advice, including what I wrote above.** From `ui/gl/gl_features.cc`:

```cpp
bool IsSwiftShaderAllowedByCommandLine(const base::CommandLine* command_line) {
  if (command_line->HasSwitch(switches::kEnableUnsafeSwiftShader)) return true;
  std::string angle_name = command_line->GetSwitchValueASCII(switches::kUseANGLE);
  if (angle_name == kANGLEImplementationSwiftShaderName ||
      angle_name == kANGLEImplementationSwiftShaderForWebGLName) return true;   // explicit → allowed
  return false;
}
```

**Explicitly passing `--use-angle=swiftshader` is itself sufficient.** And both headless modes
*self-append* that switch on Linux, which is why headless WebGL still works out of the box on 151.
The console warning still fires without the flag — it is noise, not an error. Keep
`--enable-unsafe-swiftshader` anyway as cheap insurance, but understand it is belt-and-braces.

### ⚠️ The trap that will actually bite us

**The flags people add to get GPU acceleration are exactly what breaks WebGL when there is no GPU.**
Chrome auto-appends `--use-angle=swiftshader-webgl` on Linux headless *only if* none of
`--use-gl`, `--use-angle` or `--enable-gpu` is present
(`chrome/browser/headless/headless_mode_init.cc`). Pass any of them, fail to acquire hardware, and
nothing permits SwiftShader — so `getContext('webgl')` returns **null**, silently, with a
transparent canvas and a 200. That is precisely the 143→144 report above, and it is the most likely
way this feature ships broken.

Related, same family: **`--disable-gpu` silently re-enables SwiftShader** and is, in Microlink's
words, *"the most-copied flag in every headless tutorial"*. Chrome's own note says it is needed only
on Windows. **Delete it.** And `--in-process-gpu` / `--single-process` kill the GL surface ANGLE
needs — never either.

### The central architectural trade, stated plainly

Mesa llvmpipe is genuinely ~2–4× faster than SwiftShader (Microlink ~24 s → ~6 s isolated, ~2× under
load, pixel-identical; botbrowser −49% CPU — SwiftShader is capped at 128-bit SIMD, llvmpipe uses
AVX2). But **`--use-angle=gl` must bind a GL surface, which needs an X display even headless** — so
llvmpipe means Xvfb, which means running **headed**, which means **losing `beginFrame`**.

So the decision is exactly this: **frame-accurate capture (headless-shell + `beginFrame`, SwiftShader
speed) versus ~2–4× throughput (Xvfb + headed + llvmpipe, no manual frame control).** Only a measured
number on a real simulation can settle it, and it should be measured before either path is built.

**Encouraging precedent for the slow-but-correct side:** Remotion Lambda's default GL backend is
`swangle` and they recommend it for Three.js on GPU-less machines. Software rendering of thousands of
frames under virtual time is the deployed norm, not an experiment.

**Two counter-intuitive scaling facts, both from Remotion issues:** adding cores to one box is a bad
lever — 14× the cores bought **1.7×** (#4949) — so scale out. And a GPU is not an automatic win in
this architecture: an L40S made a React-Three-Fiber render **3× slower** (#4955). Measure before
buying hardware.

### Two more silent failures worth designing against

**A blank frame roughly 4 seconds after navigation.** `kNewContentRenderingDelay = base::Seconds(4)`;
on expiry `ClearDisplayedGraphics()` wipes the output. Fixed by
`--disable-new-content-rendering-timeout`, which `--deterministic-mode` already implies — but it
matters if anyone assembles the flag list by hand.

**`beginFrame` has two hard preconditions, each with an explicit error:** BeginFrameControl must be
enabled, *and* `--run-all-compositor-stages-before-draw` must be present. Also, from the original
announcement: *"a BeginFrame may or may not be answered with a display update"* — several may be
needed before the first screenshot succeeds, which is the mechanism behind the warmup-frames advice.

**Tooling note:** Playwright unconditionally injects `--enable-unsafe-swiftshader`; Puppeteer injects
no GPU flags at all. So on Chrome 144+ a Puppeteer user who adds GPU flags to a GPU-less container
gets a black canvas, and a Playwright user does not.

### Decision summary — two branches, and why I would start with A

An eighth pass reached the M144 conclusion **independently**, with the same two CLs (5675974 adds the
machinery at M130; 7128438 flips the behaviour at M144). Two agents converging on that from source,
against what the official policy YAML says, is as settled as this gets.

It also corrects a simplification above: **the X requirement is per-backend, not universal.**
`--use-angle=gl` (Mesa desktop GL) must bind a GL surface and therefore needs a display →  Xvfb.
`--use-angle=vulkan` does **not** — the reference NVIDIA recipe runs `--headless=new
--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface` with **no Xvfb at all**.

| | **Branch A — deterministic** | **Branch B — real GPU** |
|---|---|---|
| Binary | `chrome-headless-shell` | full Chrome `--headless=new` |
| Frame control | **`beginFrame`** — exact | virtual time + `captureScreenshot` |
| GL | SwiftShader (auto-appended) | Vulkan on NVIDIA, no X |
| Hardware | any Linux container | GPU instance + container toolkit |
| Cost | slow, free | fast, paid |

**Start with A.** Moving to B costs `beginFrame` — the very thing that makes the capture
deterministic — so it is a downgrade in correctness bought with money. Only go there if a measured
number says software is genuinely too slow.

**And the throughput worry is smaller than the raw estimate suggests.** The extrapolation "1800
frames → 3–12 hours single-threaded" assumes a minutes-long continuous render. Our sections are
capped at **`VISUAL_MAX_SEC = 15`** (`TimelinePanel.tsx:26`), so a section is at most ~450 frames at
30 fps, and a project has a handful of them. That is a much more tractable shape — and it argues for
**sharding by section**, which the job model already suggests, rather than optimising single-stream
throughput. (Independent support: adding cores to one box bought 1.7× for 14× the cores.)

**One free safety net for either branch:** pass `--enable-unsafe-swiftshader` even on a GPU box, so a
failed hardware acquisition degrades to software instead of returning `null` contexts and a black
video.

**And a tooling accident worth knowing:** Playwright unconditionally passes
`--enable-unsafe-swiftshader` and defaults to `chromium-headless-shell` when headless — so Playwright
users are **accidentally immune** to the Chrome 144 breakage. Puppeteer passes neither. Since the repo
already has Playwright as a devDependency and drives real simulations with it in `sim-canary.spec.ts`,
that is a point in favour of building the capture host on Playwright rather than Puppeteer — with the
caveat that `puppeteer-capture` is the only ready-made `beginFrame` wrapper.

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

---

# THE DECISION (2026-08-12) — locked, implementation started

User rulings folded in: output is **1920×1080 landscape**; avatar circles / captions / Ken Burns are
**not critical — cut from v1**; device-specific fidelity is **not critical**; music/audio must be in
the export; "Show full simulation" is excluded from the render.

## Architecture: server-side deterministic capture + source splicing

1. **Main video, B-roll, clips** — never captured. Spliced from source files with the measured
   `filter_complex` graph (§5), including the `setsar` fix and VFR collapse.
2. **Scripted simulation sections** — captured server-side: `chrome-headless-shell` +
   `--deterministic-mode` + `HeadlessExperimental.beginFrame` + JS clock shim, navigating
   **top-level** to the section's served sim URL (v2 protocol, `startScript` with
   `simpleUi`/`autoScript`/`ui_hide` exactly as the viewer sends them). 30 fps, ≤15 s per section
   (`VISUAL_MAX_SEC`). PNG frames → ffmpeg. **What a viewer sees is what is captured, because it is
   the same bridge running the same script** — and at a perfect 30 fps, which a weak viewer device
   cannot even achieve.
3. **"Show full simulation" (RAW)** — excluded. Predicate verified from the player's own code
   (below), no new field required.
4. **Audio** — mixed entirely from assets: main video audio + audio cutaways/music via the
   `mixTimeline` discipline (`amix normalize=0`, two-pass loudnorm). Sim-internal WebAudio is out of
   scope v1 and recorded as a plan warning when a package is known to emit audio.
5. **Poster fallback, permanent**: any sim window whose capture fails (or before Phase 2 lands)
   renders as the section's poster still + silence — an export always completes, degraded loudly in
   the plan rather than failing silently.
6. **On-device capture (getDisplayMedia + Region Capture)** — documented v2 option; it is the only
   route to sim-internal audio. Not in v1.

## The exclusion predicate — final, verified (confidence: high)

The player computes exactly this at `useProjectPlayer.ts:1936` and calls it RAW activation
("show the full simulation", `:616-622`):

```ts
import { variantParamOf } from 'shared/src/sim/simIdentity';

const isFullSimulation = (s: SectionRow): boolean =>
  s.type === 'simulation' &&
  (!s.simulation_url || variantParamOf(s.simulation_url) === null) &&
  (!s.sim_script || s.sim_script === 'main');

// EXCLUDE from the render:  isFullSimulation(s)
// CAPTURE:                  s.type === 'simulation' && !isFullSimulation(s)
// SPLICE:                   s.type === 'clip' && (clip_source_video_id || clip_source_image_id)
```

Stored-vs-served is safe (`resolveSimulationUrl` appends the stored query verbatim). One known
hole: legacy rows from before the `?section=` era — the repo already ships the repair tool.

## Implementation phases

**Phase 1 — the pipeline without capture (ships value alone: poster-stills for sims).**
- Migration `058_project_exports`: table modelled on `project_duplications` (status CHECK,
  `updated_at`, progress, `plan` jsonb, `error`, `cancel_requested`, partial unique in-flight
  index).
- `buildExportPlan(projectId)`: timeline resolution (global offsets, both time conventions), the
  predicate above, poster/caption/branching warnings, canonical grid decision, estimated bytes +
  disk pre-flight. Stored in `plan` before any work.
- `LinearAssembler`: the measured graph — normalise every branch (`setsar=1`, `fps=30`,
  `format=yuv420p`, `settb`), `trim/atrim`+`concat`, `apad`+`atrim` audio discipline,
  `gte/lt` enable helper (never `between`), `-/filter_complex` file, `-progress pipe:1`
  (`out_time_us`!), SIGTERM cancel + **exit-0 + duration gates before upload**, versioned
  write-once output key, 6-hour presigned download.
- Queue job `project_export` (inline driver), CAS claim + heartbeat + fenced writes + phase-coded
  `classifyDuplicationFailure`-style failures — copy the duplication discipline verbatim.
- Endpoints replacing the 501 stubs: `POST /projects/:id/export`, `GET /projects/:id/exports/:eid`,
  `POST …/cancel`. Owner-gated like duplicate.
- Client: button left of Preview (`ProjectHeader.tsx:166`), `useProjectExport` (bounded poll like
  `useProjectDuplication`), progress strip, download when `ready`, honest per-warning display.
- Branching projects: **refused** (`retryable:false`) with a clear message, v1.

**Phase 2 — the capture worker (needs the Linux container; scaffolded now, verified in-container).**
- `SimCaptureWorker`: headless-shell launcher (flag set from §4 incl. the six
  `--deterministic-mode` switches spelled out, `--use-angle=swiftshader`,
  `--enable-unsafe-swiftshader` belt-and-braces, `--force-device-scale-factor=1`,
  `--hide-scrollbars`, `--disable-dev-shm-usage`), clock shim + seeded PRNG (from `configHash`)
  injected at document start, v2 handshake (`SIM_READY` → `startScript` → `SCRIPT_APPLIED` →
  `SIM_PAINTED`), ~30 warmup frames, exactly `round(duration×30)` beginFrame captures, WebGL
  context + `UNMASKED_RENDERER_WEBGL` + frame-1 non-uniformity + frame-count assertions — every
  silent failure mode from §4 gated loudly.
- Dockerfile: `chrome-headless-shell` pinned + fonts; dev loop is container-only (macOS cannot run
  beginFrame — measured).
- Integration: captures land in the export work dir; `LinearAssembler` swaps poster stand-ins for
  captures when present.

**Phase 3 — polish (post-v1): overlay stage (alpha capture is verified real), sim-internal audio
via on-device capture, branching path selection, admin visibility.**

## Contracts (both build agents implement against these)

- `project_exports.status`: `queued | planning | capturing | assembling | uploading | ready | failed`.
- Storage: `exports/{projectId}/{exportId}/master.mp4` (+ `sections/{sectionId}.mp4` captures),
  immutable cache headers, never overwritten across exports.
- `ExportPlan` jsonb: `{ grid: {w:1920,h:1080,fps:30}, timeline: [...resolved windows with absolute
  times, kind: 'video'|'sim-capture'|'clip'|'image'|'poster-fallback'], audio: [...asset windows],
  warnings: string[], failure?: {code, retryable, phase, detail} }`.
