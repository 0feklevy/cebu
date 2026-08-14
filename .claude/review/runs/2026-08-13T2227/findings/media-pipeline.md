# media-pipeline — findings

Agent: `media-pipeline-reviewer`. Scope: full audit of `services/export/**`, `services/video/**`,
`services/captions/`, `services/crop/`, `services/podcast/audio/**`, `services/avatarCircles/**`,
`services/ffmpegLimit.ts`.

**Method note.** Read `exportPlan.ts → resolvePlan.ts → ffmpegGraph.ts → LinearAssembler.ts` as one
story, then swept every `spawn(`/`execFile(` in `backend-api/src` against error propagation, temp
lifecycle, and the `runFfmpegLimited` cap.

**Baseline.** `pnpm -C podcast-saas --filter backend-api test` is **green** at review time:
`Test Files 125 passed | 3 skipped (128)`, `Tests 2185 passed | 18 skipped (2203)`, duration
1569 s. Nothing in this report is a pre-existing red test.

**The baseline's blind spot, which matters for the two P1s.** The three skipped files are the
opt-in real-encode / real-capture suites — `services/export/__tests__/linearAssembler.realEncode.test.ts`
and `services/video/__tests__/hlsTranscoder.realEncode.test.ts` (both `describe.runIf(ENABLED)` on
`EXPORT_REAL_ENCODE=1`) and `capture/__tests__/playwrightScreenshotBackend.realCapture.test.ts`.
Those are the only tests that ever run ffmpeg, so **no test in the default suite can observe a
malformed graph, a wrong geometry, or a non-zero ffmpeg exit.** A green run says the text-shape
assertions hold; it says nothing about what the encoder does with them. Both P1s below live exactly
in that gap. Worth raising with `@test-quality`: the media pipeline's only executable evidence is
off by default.

**What is already right** (recorded so the merged report does not re-litigate it): every ffmpeg spawn in
`LinearAssembler`, `HLSTranscoder`, `ffmpegAudio`, `generateVideoMetadata`, `CaptionService` and
`crop/ffmpegExtract` inspects the exit code, captures stderr, handles `error` separately from
`close`, and rejects. The two promises that only ever `resolve` (`extractWaveformPeaks`,
`extractPeaks`) are documented degrade-to-`[]` paths, not swallowed failures. Every work directory in
`ProjectExportService`, `runVideoTranscode`, `runCropAnalysis`, `CaptionService`, `PodcastRenderer`,
`runPodcastClips`, `runPodcastMixExport`, `previewTurn`, `revoiceTurn` and `generateVideoMetadata` is
removed in a `finally`. `ffmpegLimit.ts` releases its slot in a `finally` and hands the slot directly
to the next waiter, so a throwing task cannot leak it. The video spine's label discipline in
`buildVideoSpine` is sound: every window index gets exactly one branch label, `split=N` is emitted
once per multiply-consumed source, and no label is consumed twice. `driver.ts` bounds every
handshake wait by BOTH a wall clock and a virtual-frame budget and throws `CaptureTimeoutError` —
there is no infinite wait on a sim that never signals ready.

---

### [P1] Every main video contributes an audio window unchecked, so one silent source fails the whole export
- id: media-001
- location: podcast-saas/backend-api/src/services/export/exportPlan.ts:233
- category: bug
- confidence: high
- status: confirmed
- what: `buildExportPlan` pushes an `ExportAudioWindow` for **every** main video that has a duration
  and a storage key, with no check that the file actually contains an audio stream. That window
  survives `translateContractPlan` (it only rejects a missing `storageKey`, a non-positive range, or
  a silencing gain) and reaches `buildAudioMixBatch`, which emits `[<i>:a]atrim=…` for it
  (`ffmpegGraph.ts:408`).
- why: A main video with no audio track — a screen recording made without a mic, a render exported
  from another tool, any silent upload — makes ffmpeg refuse the mix graph with *"Stream specifier
  ':a' in filtergraph description … matches no streams"* and exit non-zero. `runFfmpegPass` turns
  that into `ExportGateError('ffmpeg-exit')`, which `classifyExportFailure` does not recognise, so
  the row lands as `code: 'unknown', retryable: true` with *"The export failed. No video was
  published; you can try again."* Retrying re-plans identically and fails identically: the project
  can never be exported, and the stored reason points nowhere near the cause. Nothing upstream
  guards it — there is no `has_audio` column on `video_files` (`db/schema.ts:414-430`) and no
  ffprobe of stream layout anywhere on the export path.
- evidence: Read `exportPlan.ts:211-237` — the `audio.push({source:'main', …})` is unconditional
  inside the same loop that already special-cases `dur <= 0` and a missing `storage_key`, so the
  omission is visible against its own neighbours. Read `resolvePlan.ts:258-296`: no stream check.
  Read `ffmpegGraph.ts:393-412`: `[${i}:a]` is emitted for every window. Grepped
  `has_audio|hasAudio|audio_stream` across `backend-api/src` — only `cropProcessor.ts` has the
  concept, and it is local to crop. The real-encode suite does contain a no-audio source
  (`linearAssembler.realEncode.test.ts:177`, the 25fps silent capture) but it appears **only** on
  `timeline`, never in `audio` (fixture at `:131-155`), so this exact path is untested — and that
  suite is one of the 3 skipped by default anyway.
- fix: In `buildExportPlan`, only push the `main` audio window when the source is known to have
  audio; since nothing records that today, the cheap correct fix is in the assembler instead — in
  `createLinearAssembler().assemble`, ffprobe each materialised audio source once (it is already
  local by then) and drop windows whose file has no audio stream, appending a warning
  (`"<name>: this video has no audio track — that stretch is silent"`) so the omission is loud, per
  the plan's own rule. Both are S/M; the assembler-side check also covers audio cutaways pointing
  at a video file.
- verify: New unit test — a `ResolvedAssembly` whose `audio[0].sourcePath` is a video fixture built
  with no `-c:a` (the `capturePath` fixture already in `linearAssembler.realEncode.test.ts` is
  exactly this file) must assemble to a gated master with a silent stretch, not throw
  `ExportGateError('ffmpeg-exit')`. Red before, green after.
- cross: @test-quality
- effort: M

### [P1] HLS tiers still lack the anamorphic normalisation the export module names as a live bug
- id: media-002
- location: podcast-saas/backend-api/src/services/video/HLSTranscoder.ts:175
- category: bug
- confidence: high
- status: confirmed
- what: `buildTierArgs` filters with
  `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2` and nothing else. It
  never squares non-square pixels first (`scale=trunc(iw*sar/2)*2:ih,setsar=1`) and never pins
  `setsar=1` after the pad.
- why: For an anamorphic source (SAR ≠ 1 — common from phones, ProRes, and some screen recorders)
  `scale` fits the *storage* dimensions, not the display dimensions, so the picture is letterboxed
  or pillarboxed against the tier box AND horizontally stretched inside it. Because SAR is never
  re-pinned, the emitted stream can also carry a non-1 SAR that players re-stretch again. This is
  the live viewer path — all four tiers of every HLS transcode — and the conformance gate does not
  catch it (it checks profile/level, keyframes and EXTINF, never geometry or SAR). The sibling
  export module documents this exact defect at `ffmpegGraph.ts:7-9` ("the measured setsar fix …
  and a live bug in HLSTranscoder.buildTierArgs") and `videoNormChain` (`ffmpegGraph.ts:133-142`)
  is the corrected chain sitting a directory away.
- evidence: Read `HLSTranscoder.ts:171-196` in full — no `setsar` anywhere in the file (grepped).
  Compared against `ffmpegGraph.videoNormChain`, which squares first and pins SAR twice. The
  export's real-encode suite proves the fix matters with an anamorphic 1440x1080 SAR-4:3 fixture
  and calls the un-squared result's black leftmost columns "the measured signature"
  (`linearAssembler.realEncode.test.ts:6-13, 186-193`); `hlsTranscoder.realEncode.test.ts` has no
  anamorphic fixture, which is why the HLS side never noticed.
- fix: Prepend the squaring step and re-pin SAR in `buildTierArgs`:
  `-vf scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1`.
  Same shape as `videoNormChain`, minus the fps/timebase collapse HLS does not need.
- verify: Add an anamorphic fixture to `hlsTranscoder.realEncode.test.ts` (mirror the export's:
  `color=c=red:size=1440x1080` with `-vf setsar=4/3`) and assert the decoded 360p segment is red at
  the left edge and reports `sample_aspect_ratio=1:1`. Red before, green after.
- cross: @test-quality
- effort: S

### [P2] The Playwright capture backend keeps its frame directory unless explicitly told not to
- id: media-003
- location: podcast-saas/backend-api/src/services/export/capture/playwrightScreenshotBackend.ts:292
- category: bug
- confidence: high
- status: confirmed
- what: `captureSection` creates `framesDir` under `tmpdir()` (`:143`) and, in its `finally`, removes
  it only `if (this.opts.keepFrames === false)`. The default (`keepFrames` undefined) therefore
  never deletes it — on the success path or the throw path.
- why: A 15s section at 30fps writes 450 full-viewport PNGs; at 1920x1080 that is a few hundred MB
  per section, per export, left in `/tmp` forever. Nobody downstream removes it either:
  `ProjectExportService` only ever consumes `result.clipPath` and explicitly treats a `framesDir`
  result as unusable (`ProjectExportService.ts:369-383`), so the directory is orphaned the moment it
  is returned. A capture that times out mid-run has already written most of those frames and leaks
  them too. Over weeks of captures this is the disk-fill failure. Secondary: the directory name is
  `sim-capture-${sectionId}-${Date.now()}` rather than `mkdtemp`, so two concurrent captures of the
  same section in the same millisecond would share a directory and interleave frames.
- evidence: Read `:130-296`. The `finally` at `:290-295` closes the browser unconditionally but
  guards the `rm` on `keepFrames === false`; the option's default is undefined, not false. Grepped
  `framesDir` across `backend-api/src` — the only other removal is in
  `isolation/backendAdapter.ts`, which copies out of it and does not delete the source either.
- fix: Invert the default — remove the directory unless `keepFrames === true` — and switch `:143`
  to `mkdtemp(join(base, 'sim-capture-'))` so concurrent captures cannot collide.
- verify: `pnpm -C podcast-saas --filter backend-api test` on
  `capture/__tests__/playwrightScreenshotBackend.realCapture.test.ts`; add an assertion that the
  returned `framesDir` no longer exists after the caller has consumed it under the default options.
- effort: S

### [P2] The local capture provider reports `gate: 'passed'` without ever running the sanity gate
- id: media-004
- location: podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts:309
- category: bug
- confidence: high
- status: confirmed
- what: `LocalCaptureProvider.captureSection` returns `{ clipPath, frameCount, rendererString,
  gate: 'passed' }` unconditionally on every non-throwing run. It never calls `evaluateSanityGate`,
  and `sanityGate.js` is not imported by the file at all. It does compute the evidence — `animated =
  shots.length > 3` (`:302`) — and then spends it on a log string rather than on the verdict.
- why: This is the "silently produces static frames" outcome the capture contract exists to prevent.
  If the compositor emits nothing (a WebGL canvas that reads back blank, a sim that never animates),
  the code falls into the `shots.length === 0` branch at `:282`, takes ONE `page.screenshot()`, and
  the zero-order-hold loop at `:294-298` writes that single JPEG `frameCount` times. That frozen
  clip is encoded, returned as `gate: 'passed'`, and `ProjectExportService` — which only degrades
  when `result.gate === 'failed' || !result.clipPath` (`:369`) — uploads it and splices it into the
  master as a genuine capture. `quality_state` stays `full` and no warning is recorded, so the
  export claims a live simulation and delivers a still. The contract is explicit that `failed` must
  be trustworthy (`captureTypes.ts:91-97`); this provider makes `passed` meaningless.
- why (reachability): gated on `EXPORT_CAPTURE_LOCAL=1` (`:327`), which is a dev-only flag, so this
  is P2 by the reachability rule and not P1 — but note the gate is the env var *alone*: there is no
  `NODE_ENV` check, and `registry.ts:39-40` calls `resolveLocalCaptureProvider()` in the shipped
  `project_export` handler, so the provider is compiled into the production image and engages
  anywhere the variable is set.
- evidence: Read `:184-319` in full. Grepped the file for `evaluateSanityGate`/`sanityGate` — no
  import, no call. `:282-285` is the static-frames path; `:294-298` duplicates `shots[p].buf`.
  `:305-308` logs `'WARNING: compositor emitted almost no frames'` and then `:309` returns
  `gate: 'passed'` regardless. Cross-checked the consumer at `ProjectExportService.ts:369`.
- fix: Sample the canvas region across the captured frames and run `evaluateSanityGate` before
  returning, exactly as `playwrightScreenshotBackend.ts:280` does; return its `gate`/`reason`
  verbatim. At minimum, make `shots.length === 0` (and `animated === false`) return
  `{ frameCount: 0, rendererString, gate: 'failed', reason: 'the compositor emitted no frames' }`
  so the window degrades to its poster loudly instead of shipping a frozen clip as live.
- verify: Unit test with a fake CDP session that emits zero `Page.screencastFrame` events; assert
  the result is `gate: 'failed'` and carries no `clipPath`.
- cross: @test-quality
- effort: M

### [P2] The local provider's ffmpeg spawn is the one that bypasses the global concurrency cap
- id: media-005
- location: podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts:108
- category: perf
- confidence: high
- status: confirmed
- what: `encodeFramesToClip` calls `spawn('ffmpeg', args)` directly. It is the only ffmpeg/ffprobe
  spawn in `backend-api/src` (outside `_archive/` and `scripts/`) that is not wrapped in
  `runFfmpegLimited`.
- why: `ffmpegLimit.ts` bounds the total ffmpeg count for the whole host (`FFMPEG_CONCURRENCY`,
  default 2). A spawn outside it does not merely exceed its own budget — it runs *in addition to*
  the two the limiter thinks are the maximum, so a capture-phase encode stacks on top of a
  concurrent HLS transcode and the export's own master encode. Each section of a multi-section
  project spawns one, sequentially, so a 6-section export adds a third concurrent encoder six times.
- evidence: `grep -rn "spawn(|execFile(" backend-api/src` cross-referenced against
  `grep -rn "runFfmpegLimited"` — every other ffmpeg/ffprobe site appears in both lists
  (`LinearAssembler:157/200/250`, `HLSTranscoder:64/87/384`, `ffmpegAudio:28/42/236`,
  `generateVideoMetadata:241`, `CaptionService:138`, and the three `crop/ffmpegExtract` spawns via
  `cropProcessor:84/90/111`); `localCaptureProvider:108` appears only in the first.
- fix: `import { runFfmpegLimited } from '../../ffmpegLimit.js'` and wrap the promise body, matching
  `LinearAssembler.runFfmpegPass`.
- cross: @performance
- effort: S

### [P2] The local provider leaks its output directory on every successful capture
- id: media-006
- location: podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts:189
- category: bug
- confidence: high
- status: confirmed
- what: `captureSection` creates two temp dirs. `framesDir` is removed in the `finally` (`:317`).
  `outDir` — which holds the encoded `<sectionId>.mp4` — is removed only inside the `catch` (`:312`).
  On the success path it is never removed, by this file or any other.
- why: The inverse of the usual bug: cleanup exists on the failure path and is missing on the
  success path, which is the one that always runs. `ProjectExportService` reads the clip
  (`:391 readFile(result.clipPath)`), uploads it, and moves on without touching the directory, so
  every successfully captured section leaves a full-resolution mp4 in `/tmp` permanently.
- evidence: Read `:184-319`. `outDir` is assigned at `:189`, used at `:190`, `rm`'d only at `:312`
  in the catch. Grepped `clipPath` across `backend-api/src`: the only consumer is
  `ProjectExportService.ts:391`, which has no cleanup, and the capture contract
  (`captureTypes.ts:74-82`) does not assign ownership of the artefact either way.
- fix: Either move the `rm(outDir)` into the `finally` and have `captureSection` return the clip's
  bytes rather than its path, or — smaller and consistent with the existing seam — have
  `ProjectExportService` remove `dirname(result.clipPath)` in a `finally` around the upload. State
  the ownership rule in `CaptureResult`'s doc comment so the next backend does not re-guess it.
- effort: S

### [P2] HLS tiers never force `yuv420p`, so any non-4:2:0 upload fails the conformance gate
- id: media-007
- location: podcast-saas/backend-api/src/services/video/HLSTranscoder.ts:176
- category: bug
- confidence: medium
- status: confirmed
- what: `buildTierArgs` sets `-c:v libx264` and `-profile:v <tier>` but never `-pix_fmt yuv420p`.
  libx264 preserves the input's chroma subsampling when it can, so a 4:2:2 / 4:4:4 / 10-bit source
  (ProRes, some camera and screen-capture formats) encodes to a 4:2:2 or 4:4:4 profile.
- why: `assertTierConformance` then probes the segment and `normalizeH264Profile` returns `null` for
  `"High 4:2:2"`, so the `!== tier.profile` comparison fails and the tier throws
  `HLS conformance (360p): encoded as High 4:2:2@L… but the tier matrix requires baseline@L30`.
  The whole transcode fails and the video never becomes playable — for a source that the pipeline
  could simply have converted. The gate is doing its job; the encode arguments are what is missing.
  Note this interacts with media-002: both are one-line additions to the same `-vf`/output args.
- evidence: Read `HLSTranscoder.ts:171-196` (no `-pix_fmt`) and `:286-300` (the gate that rejects
  the result). Contrast `ffmpegGraph.masterOutputArgs:466` which does pin `-pix_fmt yuv420p`, and
  `videoNormChain` which pins `format=yuv420p` in the graph — the export path got this right.
- fix: Add `'-pix_fmt', 'yuv420p',` to the returned args in `buildTierArgs`.
- verify: Extend `hlsTranscoder.transcode.test.ts`'s arg-shape assertions to require `-pix_fmt
  yuv420p`; optionally add a `yuv422p` fixture to the real-encode suite and assert the transcode now
  succeeds.
- effort: S

### [P2] The podcast mixer still uses `-filter_complex_script` after the image was pinned to ffmpeg 8
- id: media-008
- location: podcast-saas/backend-api/src/services/podcast/audio/ffmpegAudio.ts:179
- category: bug
- confidence: medium
- status: suspected
- what: `mixTimeline` passes its graph with `-filter_complex_script <path>`. The export assembler
  uses the newer file-form `-/filter_complex` and its own header calls the script-file spelling
  "deprecated in ffmpeg 8 — measured, plan §5" (`LinearAssembler.ts:9-10`).
- why: `deploy/docker/backend.Dockerfile:52` now pins `ffmpeg-n8.1`, replacing bookworm's 5.1. That
  change was made *for* the export path — the Dockerfile comment memorialises a production incident
  where 5.1 died on `-/filter_complex` — but it moves every other pipeline onto 8.1 at the same
  time. If 8.1 has removed rather than merely deprecated `-filter_complex_script`, every podcast
  render, clips job and mix export fails at the mix step in production right now. If it is only
  deprecated, this is a scheduled break at the next pin bump, which the Dockerfile invites
  ("bump the pin deliberately").
- evidence: Read `ffmpegAudio.ts:176-179` and `LinearAssembler.ts:9-10`, `471-485`. Read
  `deploy/docker/backend.Dockerfile:45-62`. I did not run ffmpeg (read-only review), so whether 8.1
  still accepts the option is **unverified** — hence `suspected`. What is certain is the version
  skew: two spellings for the same job, one of them documented in this repo as deprecated on the
  version the image now ships.
- fix: Change `ffmpegAudio.ts:179` to `'-/filter_complex', graphPath` to match `LinearAssembler`,
  and note in the Dockerfile comment that the podcast path shares the requirement. Do this only
  after confirming ≥7 is the floor everywhere ffmpeg is invoked (it is, per the Dockerfile pin).
- verify: `docker run --rm <backend-image> ffmpeg -h full | grep -c filter_complex_script` settles
  it in one command without touching production; then run
  `pnpm -C podcast-saas --filter backend-api test` over `podcast/audio/__tests__`.
- cross: @config-deploy
- effort: S

### [P2] The podcast loudnorm apply pass trusts a measurement the export's twin explicitly validates
- id: media-009
- location: podcast-saas/backend-api/src/services/podcast/audio/ffmpegAudio.ts:206
- category: bug
- confidence: medium
- status: confirmed
- what: `loudnormTwoPass` parses the measurement JSON and, if `JSON.parse` succeeded at all, feeds
  the values straight into `measured_I=…:measured_TP=…:…:linear=true`. It never checks that the
  numbers are in the range the apply pass accepts.
- why: `loudnorm`'s apply pass rejects `measured_I` outside `[-99, 0]`, and digital silence measures
  `input_i: "-inf"`, which parses as a string and reaches ffmpeg verbatim — the pass then exits
  non-zero and `ff()` rejects, failing the whole render rather than degrading. The export's mirror
  of this function handles exactly this and says why (`LinearAssembler.ts:517-532`: the `-inf`
  branch copies through, an out-of-range measurement falls back to the single-pass dynamic form).
  The podcast version predates that fix and never received it. Reachability is genuinely limited —
  the final mix normally carries a `-56 dB` room-tone bed (`ffmpegAudio.ts:165-171`), which measures
  in range — so this needs `roomTone` off or a bed that failed to mix; hence P2, not P1.
- evidence: Read `ffmpegAudio.ts:200-213` beside `LinearAssembler.ts:495-548`. The two functions are
  the same algorithm; only the export's validates. `mixClips:133` passes `roomTone` through, so the
  bed is a caller decision, not an invariant.
- fix: Port the export's guard: treat `input_i === '-inf'` or `≤ -70` as "already silent, skip
  normalisation", and treat any non-finite / out-of-range field as "fall back to single-pass",
  which the function already implements as its `else` branch.
- verify: Unit test `loudnormTwoPass` against a digitally silent wav fixture; it must produce an
  output file rather than reject.
- effort: S

### [P2] The container capture boundary pipes stdout and stderr and never reads either
- id: media-010
- location: podcast-saas/backend-api/src/services/export/capture/isolation/captureJobBoundary.ts:437
- category: bug
- confidence: high
- status: confirmed
- what: `spawnDocker` spawns with `stdio: ['ignore', 'pipe', 'pipe']` and attaches no `data`
  listener to either stream. The rejection it builds on a non-zero exit is
  `` `export capture container exited ${code}` `` with no output attached.
- why: Two problems from one omission. (a) An unread pipe fills: once the container writes ~64 KB to
  stdout/stderr the write blocks and the container wedges until the wall-clock `hardKill` fires at
  `:446` — chrome-headless-shell is chatty on stderr, so this is a realistic hang that presents as a
  mysterious timeout rather than a crash. (b) When the container legitimately fails, its stderr —
  the only explanation of *why* the capture died inside an isolated container — is discarded, and
  the operator gets an exit code. Compare `LinearAssembler.runFfmpegPass:174-176`, which keeps a
  16 KB stderr tail precisely so a failure explains itself.
- evidence: Read `:429-476`. `proc.stdout`/`proc.stderr` are never referenced after the spawn; the
  only handlers are `error` and `close`. Note this backend is not wired into production today
  (`ProjectExportService`'s `captureProvider` defaults to null and `registry.ts` injects only the
  local provider), which is why this is P2 — but it is the intended production capture path.
- fix: Attach `data` handlers that keep a bounded tail of each stream (the `slice(-16384)` idiom
  already in `runFfmpegPass`), and include the stderr tail in the rejection message.
- cross: @observability
- effort: S

### [P2] Progress sits at 0% for the whole audio phase of an assembly
- id: media-011
- location: podcast-saas/backend-api/src/services/export/LinearAssembler.ts:681
- category: ux
- confidence: high
- status: confirmed
- what: `assembleResolved` calls `push(0)` only at `:681`, immediately before the master video
  encode. Everything before it — `buildAudioTrack`, i.e. up to `MIX_BATCH`-sized mix passes, an
  optional submix round, and a two-pass loudnorm — emits no progress at all, because
  `runGraphToWav` never passes `-progress` or an `onStdout`.
- why: `ProjectExportService`'s progress callback is the only thing that moves `objects_done` during
  `assembling` (`ProjectExportService.ts:441-458`), so the poll reports 0 for the entire audio
  stage. On a long project with many audio cutaways that is several minutes of a bar that has not
  moved, which reads as a hung job — the exact "stuck 0%" the recent commit f772242 set out to
  remove on the UI side. The video encode's own progress is honest (`ProgressParser` reads
  `out_time_us`, clamps, and is strictly monotonic), so this is a coverage gap, not a lying bar.
- evidence: Read `assembleResolved:630-699` and `buildAudioTrack:550-602`. `runGraphToWav:471-485`
  builds its args without `-progress`; `runFfmpegPass`'s `onStdout` is only supplied at `:692`.
- fix: Give `buildAudioTrack` a share of the budget — pass `-progress pipe:1 -stats_period 1` in
  `runGraphToWav` and feed a `ProgressParser` scaled into, say, `[0, 15]`, then map the video encode
  onto `[15, 99]` instead of `[0, 99]`. The existing clamp-and-monotonic `push` already guarantees
  the bar cannot move backwards across the handover.
- cross: @ui-ux
- effort: M

### [P2] A captured sim is re-labelled `clip`, dropping it two layers in the stacking order
- id: media-012
- location: podcast-saas/backend-api/src/services/export/ProjectExportService.ts:392
- category: bug
- confidence: medium
- status: confirmed
- what: When a capture succeeds, the service replaces the `sim-capture` window with a `ClipWindow`
  (`kind: 'clip'`). `resolvePlan`'s `LAYER_PRIORITY` scores `sim-capture` and `poster-fallback` at
  3, `image` at 2 and `clip` at 1 (`resolvePlan.ts:56-62`), so the substitution moves the window
  from the top layer to below images.
- why: The stacking order is meant to mirror the viewer (sim pool over image over b-roll over base).
  A successful capture therefore composites *differently* from the same section's poster fallback:
  where an image section overlaps a sim section, the poster wins today and the captured sim would
  lose. That is a visible difference between the degraded and the full export, in the direction that
  makes the better capture render less. Confidence is medium on how often sections overlap in
  practice — the planner does warn when overlays overlap (`resolvePlan.ts:156-169`), which implies
  it happens — but the priority inversion itself is plain in the code.
- evidence: Read `ProjectExportService.ts:386-398` (the `ClipWindow` construction) against
  `resolvePlan.ts:55-62` (the priority table) and `:188-199` (the winner selection, which compares
  `priority` first). Nothing else distinguishes a captured sim from ordinary b-roll: `sourceRole` is
  set to `'clip'` and is not read by `resolvePlan`.
- fix: Give the captured window a distinguishable kind or priority. Least invasive: set
  `sourceRole: 'sim'` on the substituted window and have `resolvePlan` score a `clip` whose
  `sourceRole` is `'sim'` at 3. Cleaner: add a `sim-clip` kind to the priority table at 3.
- verify: Add a `resolvePlan` test with an image window overlapping a captured-sim clip window and
  assert the sim survives the sweep.
- cross: @test-quality
- effort: S

### [P3] `force_original_aspect_ratio=decrease` is used without `force_divisible_by=2`
- id: media-013
- location: podcast-saas/backend-api/src/services/export/ffmpegGraph.ts:138
- category: bug
- confidence: low
- status: suspected
- what: Both `videoNormChain` (`ffmpegGraph.ts:138`) and `buildTierArgs`
  (`HLSTranscoder.ts:175`) scale with `force_original_aspect_ratio=decrease` and omit
  `force_divisible_by=2`. For source aspect ratios that do not divide evenly into the target box the
  scaler can land on an odd intermediate width or height.
- why: An odd dimension in a `yuv420p` chain is a chroma-plane hazard. In both call sites the odd
  value is immediately padded back to the tier/grid box, which is even, so the *encoded* output is
  even and this may well be harmless in practice — which is exactly why it is P3 and `suspected`
  rather than an asserted defect. I did not run ffmpeg, so I cannot say whether swscale warns,
  rounds, or errors for the specific ratios this product sees.
- evidence: Read both call sites. `masterOutputArgs` and the tier matrix use only even output
  dimensions, and `pad` centres with `(ow-iw)/2`, so the final frames are even in every case I could
  construct on paper.
- fix: One token at each site: `force_original_aspect_ratio=decrease:force_divisible_by=2`. It is a
  no-op when the maths already lands even, so it costs nothing to adopt.
- verify: Real-encode fixture with a deliberately awkward source ratio (e.g. 1000x563 into the 854x480
  tier); assert the tier encodes and the segment probes at exactly 854x480.
- effort: S
