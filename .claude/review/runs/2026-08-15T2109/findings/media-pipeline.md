# Media pipeline — findings (run 2026-08-15T2109, commit 2d187e3)

Scope swept: `podcast-saas/backend-api/src/services/export/**` (exportPlan → resolvePlan →
ffmpegGraph → LinearAssembler → ProjectExportService, `capture/**` incl. `isolation/**` and the
UNTRACKED `capture/localCaptureProvider.ts`), `services/video/**`, `services/captions/CaptionService.ts`,
`services/crop/**`, `services/podcast/audio/**`, `services/audio/GuidanceTTSService.ts`,
`services/avatarCircles/**`, `services/ffmpegLimit.ts`.

Baseline: `pnpm -C podcast-saas --filter backend-api test` → **133 files passed, 3 skipped;
2278 tests passed, 18 skipped** (212 s). The 18 skips are the opt-in real-encode suites
(`EXPORT_REAL_ENCODE=1`, `HLS_REAL_ENCODE=1`). Local ffmpeg is 8.1.2; `deploy/docker/backend.Dockerfile:52`
pins `ffmpeg-n8.1` in the image, so the `-/filter_complex` file-form the assembler needs is present
in production.

---

### [P1] The video spine has no length guarantee, so a source one frame shorter than its plan window fails the WHOLE export at a gate
- id: media-001
- location: podcast-saas/backend-api/src/services/export/ffmpegGraph.ts:286
- category: bug
- confidence: high
- status: confirmed
- what: Every splice window is produced by `trim=start=<in>:end=<in+dur>` on the normalised branch
  and nothing pads it. `trim` cannot invent frames: if the decoded source ends before `in+dur`, that
  window emits fewer frames and the `concat` output is short by exactly that much. The audio half of
  the same module is explicitly protected against this ("`apad`+`atrim` — an under-length source can
  never shorten the timeline cumulatively (§5)", `ffmpegGraph.ts:16-17`, implemented at
  `ffmpegGraph.ts:409` and again at `:418`). The video half has no counterpart — `grep -rn "tpad"
  podcast-saas/backend-api/src` returns nothing.
- why: The audio track is pinned to exactly `totalSec`; the video track is not. A short video stream
  therefore lands as `vDur < aDur` and `assertMasterGates` throws `ExportGateError('stream-agreement')`
  (`LinearAssembler.ts:418`), which `classifyExportFailure` cannot recognise, so the row is written
  `failed / code:"unknown" / retryable:true` (`ProjectExportService.ts:112-117`) — the user is told
  "you can try again" for a condition that is deterministic and will fail identically forever.
  The window duration comes from `video_files.duration_sec`, and that value is
  `probeMediaInfo().durationSec` = **container** `format.duration`
  (`HLSTranscoder.ts:134` → `runVideoTranscode.ts:99` → `exportPlan.ts:216,230`), i.e. the max over
  streams. Any MP4 whose audio outruns its video by more than one frame (AAC encoder padding is
  routinely 23–46 ms; the tolerance is `1/30 + 1e-3` = 34.3 ms) plans a window longer than the video
  stream it trims from. Other triggers on the same path: a truncated/partially re-uploaded master, and
  a captured section clip missing a frame.
- evidence: Read `ffmpegGraph.ts:279-290` (trim, no pad) against `:393-418` (audio apad/atrim twice).
  `LinearAssembler.ts:411-423` is the gate that fires. `ProjectExportService.ts:100-118` shows the
  failure classifies as `unknown/retryable:true`. The duration provenance chain is three reads:
  `HLSTranscoder.probeMediaInfo` returns `format.duration`; `runVideoTranscode.ts:99` stores it as
  `duration_sec`; `exportPlan.ts:216` makes it the window length and `:230` the source out-point.
  No test covers a source shorter than its window (`export/__tests__/ffmpegGraph.test.ts` asserts
  graph text only; `linearAssembler.realEncode.test.ts` builds its fixtures with ffmpeg, so their
  container and video durations agree).
- fix: In `buildVideoSpine`, pad each window to its exact frame count before trimming — change the
  per-window line to
  `${from}trim=start=S:end=E,tpad=stop_mode=clone:stop_duration=<dur>,setpts=PTS-STARTPTS,trim=duration=<dur>[wN]`
  (clone-hold the last frame, then cut to the single number, mirroring the audio `apad,atrim=end=`
  discipline). Add `tpad` to `REQUIRED_FILTERS` so the fail-fast probe covers it. Add a unit test that
  a window whose source is 0.2 s short still yields `round(dur*fps)` frames, and a real-encode case
  with a source whose container duration exceeds its video stream.
- verify: new test red before, green after; `pnpm -C podcast-saas --filter backend-api test` stays green.
- effort: M

### [P1] HLS tiers are pillarboxed AND stretched for anamorphic sources — the sibling module names this as a live bug and it is still there
- id: media-002
- location: podcast-saas/backend-api/src/services/video/HLSTranscoder.ts:175
- category: bug
- confidence: high
- status: confirmed
- what: `buildTierArgs` scales/pads with
  `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2` and never squares the
  pixels first (`scale=trunc(iw*sar/2)*2:ih,setsar=1`) nor pins `setsar=1` after the pad. For a source
  with SAR ≠ 1 the fit is computed on storage dimensions rather than display dimensions, so the frame
  is letter/pillarboxed on the wrong axis, and the non-unity SAR survives into the output so the player
  stretches what is left.
- why: This is not a theory — `ffmpegGraph.ts:9-11` documents the export's normalisation chain as
  "the measured setsar fix: square the pixels FIRST, or anamorphic input comes out both pillarboxed and
  stretched — §5 of the plan, **and a live bug in HLSTranscoder.buildTierArgs**". The export path was
  fixed; the HLS path, which is what every viewer actually streams, was not. Anamorphic input is
  ordinary (many phone/action-cam and broadcast-sourced files).
- evidence: Read `HLSTranscoder.ts:171-196` — no `setsar`, no `iw*sar` term anywhere in the file
  (`grep -n setsar podcast-saas/backend-api/src/services/video/HLSTranscoder.ts` → no match), versus
  `ffmpegGraph.videoNormChain` at `ffmpegGraph.ts:133-142`. The export's real-encode suite asserts the
  fix matters ("the setsar fix (anamorphic content fills the frame; without it the leftmost columns are
  black — the measured signature)", `linearAssembler.realEncode.test.ts:12-14`); the HLS real-encode
  suite has no anamorphic case.
- fix: Change the `-vf` in `buildTierArgs` to
  `scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1`
  — i.e. reuse the shape of `videoNormChain` (better: export a shared builder so the two cannot drift
  again). Add a unit test pinning the tier `-vf` string, and an anamorphic case to
  `hlsTranscoder.realEncode.test.ts` asserting the probed DAR/SAR of `seg_000.ts`.
- verify: `pnpm -C podcast-saas --filter backend-api test`; `HLS_REAL_ENCODE=1` run on a 1440x1080 SAR 4:3 fixture.
- effort: S

---

### [P2] The rendering sanity gate fails 100% of simulations that draw no `<canvas>`, discarding a correct capture
- id: media-003
- location: podcast-saas/backend-api/src/services/export/capture/sanityGate.ts:123
- category: bug
- confidence: high
- status: confirmed
- what: The gate's frame samples come from an in-page sampler that returns `null` when the document
  contains no `<canvas>` (`beginFrameBackend.ts:279`, identical in `playwrightScreenshotBackend.ts:182`).
  A null sample is simply not pushed, so `frames` is `[]`; then `enoughSamples` (`frames.length >= 2`)
  is false AND `intraFrameNonUniform` (`[].some(...)`) is false, and `evaluateSanityGate` returns
  `gate: 'failed'` with two reasons. The same happens for a canvas sim that is visually static
  (`interFrameDelta` needs ≥2 distinct signatures).
- why: A DOM/SVG/CSS simulation that captured perfectly is thrown away after paying the full capture
  cost (up to `wallClockCapSec` = 600 s of container time per section,
  `containerCaptureProvider.ts:252`), and `ProjectExportService.ts:369-383` substitutes the poster
  still. The class of simulation is not exotic — nothing in the sim runtime requires a canvas.
- evidence: Read `sanityGate.ts:118-163` with `beginFrameBackend.ts:276-288` and `:488-492`
  (`if (parsed) samples.push(parsed)` — a null sample is dropped, not recorded as "no canvas"). The
  gate's own tests (`export/capture/__tests__/sanityGate.test.ts`) never exercise a zero-sample input
  from a canvas-less page.
- fix: Make "no canvas" a distinct signal rather than an implicit failure. In the sampler, fall back to
  sampling `document.documentElement` via the screenshot bytes (or return a marker `{noCanvas:true}`);
  in `evaluateSanityGate`, when no canvas exists, judge on the screenshot samples and drop the
  `intraFrameNonUniform`/`interFrameDelta` canvas checks to a PASS-with-note instead of a failure —
  keeping `simPainted` and `webglLive` as the hard checks. Add tests for (a) canvas-less page,
  (b) legitimately static canvas.
- effort: M

### [P2] Two ffmpeg spawns on the capture path bypass the global concurrency cap
- id: media-004
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:156
- category: bug
- confidence: high
- status: confirmed
- what: `encodeFramesToClip` spawns `ffmpeg` directly. It is not wrapped in `runFfmpegLimited`, so it
  is invisible to `FFMPEG_CONCURRENCY` (default 2, `ffmpegLimit.ts:8`). The dev-only
  `localCaptureProvider.ts:108` has the identical unwrapped spawn.
- why: `stack.md` §6.2 makes "every spawn path honours the limiter" a stated invariant, and
  `LinearAssembler.ts:24` restates it. On the 2-vCPU host, a section encode running outside the cap
  adds an x264 pass on top of the two already permitted, alongside the capture container itself
  (`--cpus 2`, `containerCaptureProvider.ts:223`). Every source I checked routes through the limiter
  (`HLSTranscoder` 64/87/384, `crop/cropProcessor` 84/90/111, `captions/CaptionService` 138,
  `podcast/audio/ffmpegAudio` 28/42/236, `generateVideoMetadata` 241, `LinearAssembler` 157/200/250) —
  these two are the only exceptions.
- evidence: `grep -rn "runFfmpegLimited" podcast-saas/backend-api/src` lists every wrapped call site;
  neither capture file appears. `grep -rn "spawn(" .../services` shows the two raw `spawn('ffmpeg', …)`.
- fix: Import `runFfmpegLimited` in both files and wrap the returned promise:
  `return runFfmpegLimited(() => new Promise((resolve, reject) => { … }))`. Add an assertion test that
  greps the export tree for `spawn('ffmpeg'` outside `runFfmpegLimited`, the same way the module
  already pins the banned closed-interval enable operator.
- effort: S

### [P2] Every captured section leaks a temp directory holding a full-length mp4, forever, in the operator's work dir
- id: media-005
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:367
- category: bug
- confidence: high
- status: confirmed
- what: `clipOut = await mkdtemp(join(base, 'clip-…'))` is created deliberately OUTSIDE the `finally`
  that removes `jobDir` (line 400), and nothing ever removes it. `ProjectExportService.ts:391` reads
  `result.clipPath`, uploads it, and moves on — no unlink, and the export's own `finally`
  (`ProjectExportService.ts:549-552`) only removes its own `workDir`.
- why: The code comment says "the OS tmp reaper owns the leftovers", but `base` is
  `this.config.workDir ?? tmpdir()` and `EXPORT_CAPTURE_WORKDIR` must be a **host** bind-mount path
  (documented at `containerCaptureProvider.ts:20`) — nothing reaps that directory, and even under
  `/tmp` systemd-tmpfiles typically waits 10 days. One 30 s 1080p CRF-18 section clip is tens of MB;
  every sim section of every export accumulates. This is the disk-fill failure mode the export's own
  `assertDiskHeadroom` exists to prevent, arriving through the back door.
- evidence: Read `containerCaptureProvider.ts:363-402` — `clipOut` is not referenced in the `finally`.
  Read `ProjectExportService.ts:386-398` — the clip path is consumed and dropped.
- fix: Return the clip inside the export's own `workDir` (pass a destination in through `CaptureSpec`),
  or have `ProjectExportService` `rm` the clip's parent directory in a `finally` around the capture
  loop. Add a test asserting no `clip-*` directory survives a successful `captureSection`.
- effort: S

### [P2] A failed HLS transcode leaves its whole partial run tree in object storage, and points `hls_360p_key` into it
- id: media-006
- location: podcast-saas/backend-api/src/services/video/runVideoTranscode.ts:57
- category: bug
- confidence: high
- status: confirmed
- what: `transcodeToHLS` uploads each tier as soon as it passes conformance
  (`HLSTranscoder.ts:456-460`). If a later tier throws (conformance, ENOSPC, ffmpeg failure), the
  catch at `runVideoTranscode.ts:153` marks the row failed and rethrows — nothing deletes
  `hls/{videoFileId}/{runId}/`. Only the PREVIOUS **successful** tree is ever retired, and only via
  `previousHlsTreeToGc(videoFileId, oldMasterKey, runId)` which derives the prefix from
  `hls_master_key` (`hlsVersioning.ts:44-54`) — a failed run never became a master key, so it is
  invisible to `hls_retired_runs` and to `sweepRetiredHlsRuns` forever.
- why: Storage cost grows with every failed transcode (a 360p+480p+720p partial of a long video is
  hundreds of MB). Secondarily, `onTierComplete` writes `hls_360p_key` into the new run tree at
  `runVideoTranscode.ts:74-79` before the run is known good, so after a failure the row's early-playback
  pointer references a tree that no retention record covers.
- evidence: Read `runVideoTranscode.ts:52-82` and `:153-167` (the catch deletes only the local
  `workDir`), and `hlsVersioning.previousHlsTreeToGc`. `video/__tests__/runVideoTranscode.retention.test.ts`
  covers the success-path retirement only.
- fix: In the catch, call `retireHlsRun(video_file_id, storageKeyPrefix)` with a short grace (the tree
  is unreferenced, so `retire_after = now` is safe) so the existing hourly sweep collects it; and set
  `hls_360p_key` only from the terminal success write, or roll it back in the catch. Add a test that a
  tier-3 failure enqueues a retirement row for the failed run prefix.
- effort: M

### [P2] Export assembly buffers every source master fully into the heap before writing it to disk
- id: media-007
- location: podcast-saas/backend-api/src/services/export/LinearAssembler.ts:763
- category: perf
- confidence: high
- status: confirmed
- what: `for (const key of translated.keys) { const bytes = await storage.readObject(key); await
  writeFile(keyPaths.get(key)!, bytes); }` — each source object becomes one whole `Buffer` in memory
  before it reaches disk.
- why: The plan's own disk pre-flight assumes multi-gigabyte sources (`EXPORT_DISK_MULTIPLIER = 2`
  plus 1 GiB headroom, `exportPlan.ts:105-106`), so the code both anticipates large masters and then
  loads them into the heap one at a time. A 1 GB main video on the 2-vCPU host is a resident 1 GB
  allocation inside the worker process; beyond ~2 GB Node throws `ERR_STRING_TOO_LONG`/allocation
  failure and the export dies with an unclassified error. The sibling transcode path already does this
  correctly by streaming (`runVideoTranscode.ts:44-48`: presigned URL → `pipeline` → `createWriteStream`).
- evidence: Read `LinearAssembler.ts:744-772`; the comment "sequential downloads keep peak memory to
  one object" states the intent but one object is exactly the problem. `AssemblerStorage` is declared
  as `readObject(key): Promise<Buffer>` (`:706-708`), so the seam only offers the buffering API.
- fix: Widen `AssemblerStorage` to `getPresignedDownloadUrl(key, ttl)` (already on `StorageService`)
  and stream with `pipeline(res.body, createWriteStream(dest))` exactly as `runVideoTranscode` does,
  keeping `readObject` as the fallback for adapters without presigning. Test with a fake adapter that
  returns a stream and assert the file lands byte-identical.
- effort: M

### [P2] Every assembled window decodes its source from frame 0 — no input seek anywhere in the export
- id: media-008
- location: podcast-saas/backend-api/src/services/export/ffmpegGraph.ts:237
- category: perf
- confidence: high
- status: confirmed
- what: Video-file sources are opened with `inputs.push({ args: ['-i', sourcePath] })` and every window
  is cut with the `trim` **filter**. There is no `-ss` input seek in the module
  (`grep -n "'-ss'" podcast-saas/backend-api/src/services/export` → no match), so ffmpeg decodes each
  source from its first frame regardless of how little of it the timeline uses.
- why: Export runtime is the product's known bottleneck. For a b-roll or clip section that uses 5 s out
  of a 20-minute library video, the assembler decodes 20 minutes of H.264 to emit 5 s. The cost is
  linear in source length and pure waste; it also inflates the wall clock that the capture phase is
  already competing for on 2 vCPUs.
- evidence: Read `buildVideoSpine` at `ffmpegGraph.ts:235-250` (shared inputs) and `:281-288` (the
  per-window `trim`). `resolvePlan.ts:221` computes the per-window `sourceInSec`, so the seek point is
  already known at graph-build time.
- fix: Split the input strategy: a source consumed by windows that tile most of it keeps today's
  single-input + `split=N` form; a source whose used span is a small fraction gets one `-i` per window
  with `-ss <sourceInSec - keyframeSlack> -t <dur + slack>` before it and the residual offset applied in
  the `trim`. Keep the existing graph-text tests and add one asserting the seek form for a short window
  of a long source.
- effort: L

### [P2] Nothing bounds captured frame bytes against the container's tmpfs and memory caps
- id: media-009
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerRunArgs.ts:145
- category: bug
- confidence: medium
- status: suspected
- what: The capture container gets `--tmpfs /tmp:…,size=<tmpfsScratchMb>m` (default 512 MiB,
  `containerCaptureProvider.ts:226`) and `--memory <memoryMb>m` / `--memory-swap` equal (default
  2048 MiB, `:224`). The beginFrame backend writes every captured JPEG into `mkdtemp(join(base, …))`
  where `base = this.opts.workDir ?? tmpdir()` — i.e. that same tmpfs (`beginFrameBackend.ts:320-324`)
  — alongside Chrome's `--user-data-dir` (`:331`). Nothing anywhere computes
  `frameCountFor(durationSec, fps) × jpegBytes` against either cap.
- why: A 60 s section at the export grid is 1800 frames; 1080p JPEG q80 of a busy scene is commonly
  200–400 KB, i.e. 360–720 MiB — over the 512 MiB tmpfs, and charged to the 2 GiB cgroup on top of
  Chrome's own footprint. The failure surfaces as an ENOSPC write or an OOM kill, i.e. a non-zero
  container exit with a `result.json` that names a write error, and the section silently degrades to
  its poster after burning the full capture budget. `relocateArtifacts` (`backendAdapter.ts:104`) then
  copies the same bytes AGAIN to the `/output` bind mount, so the peak is briefly doubled across two
  filesystems.
- evidence: Read `containerRunArgs.ts:143-155`, `containerCaptureProvider.ts:219-231`,
  `beginFrameBackend.ts:314-330,486-487`, `backendAdapter.ts:94-113`. Marked `suspected` because the
  per-frame JPEG size is content-dependent and I cannot measure it here; what IS confirmed is that no
  code relates the two numbers. Confirming run: capture a 60 s section in the container and compare
  `du -sh` of the frames dir against `EXPORT_CAPTURE_TMPFS_MB`.
- fix: (a) Write frames straight to the `/output` bind mount instead of tmpfs — pass `workDir` into
  `BeginFrameBackend` from the container entrypoint's `outputDir`, which also deletes the
  `relocateArtifacts` copy entirely; (b) in `buildCaptureSpec`/`ContainerCaptureProvider`, refuse (or
  raise `tmpfsScratchMb`) when `frameCount × 400 KB` exceeds the configured scratch, with a named error
  rather than an ENOSPC.
- effort: M

### [P2] Cancelling an export cannot stop a running capture container
- id: media-010
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:351
- category: bug
- confidence: high
- status: confirmed
- what: `this.boundary.runCapture(containerSpec, { inputDir, outputDir }, new AbortController().signal)`
  — a freshly-constructed controller whose signal is never aborted. `DockerCaptureBoundary.spawnDocker`
  has full cancellation support keyed on that signal (`captureJobBoundary.ts:492-500`: `docker stop`
  then escalate to `docker kill --signal=KILL`), and it is unreachable.
- why: The export service polls `cancel_requested` every 15 s and drives an `AbortController`
  (`ProjectExportService.ts:279-286`), but `SimCaptureBackend.captureSection` takes no signal, so a
  cancel during the capture phase is only honoured at the next `throwIfCancelRequested` between
  windows (`:348`). With `wallClockCapSec` up to 600 s per section, a user who cancels waits out the
  full remaining capture of the current section — and a whole project's worth of them if the flag is
  only re-checked between windows.
- evidence: Read `containerCaptureProvider.ts:348-352` and `captureJobBoundary.ts:462-517`.
- fix: Add an optional `signal?: AbortSignal` to `CaptureSpec` (or a second parameter on
  `captureSection`), pass `abort.signal` from `ProjectExportService.ts:362`, and forward it to
  `runCapture` instead of the throwaway controller. Add a test that aborting mid-capture spawns
  `docker stop <name>`.
- effort: S

### [P2] Capture re-downloads the entire simulation package once per section, and runs one container per section
- id: media-011
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:331
- category: perf
- confidence: high
- status: confirmed
- what: `captureSection` calls `fetchPackageFiles(this.storage, source)` on every invocation, which
  does a `listObjects(prefix)` plus a `readObject` per file (up to `MAX_PACKAGE_BYTES` = 256 MiB) and
  then `writeCaptureInput` writes all of them to a fresh input mount. Nothing caches by
  `source.packageRoot`. `ProjectExportService.ts:338-413` then drives sections strictly sequentially,
  and each one is an independent `docker run` (container create + Chrome cold start + loopback server
  + navigation).
- why: This is the throughput blocker's structural half. A project with N scripted sections against
  the same simulation pays N× (package list + download + disk write + container start + browser cold
  start) on top of N× the frame loop. On the 2-vCPU host each of those fixed costs is seconds to tens
  of seconds, and the per-section budget is `min(600, 90 + dur*6)` (`containerCaptureProvider.ts:252`) —
  the 90 s constant is exactly the fixed-cost allowance, spent N times.
- evidence: Read `containerCaptureProvider.ts:287-402` (no memoisation of `fetchPackageFiles`, one
  `boundary.runCapture` per call) and `ProjectExportService.ts:336-413` (`for … await`).
- fix: Two independent wins. (1) Memoise the staged input directory per `packageRoot` for the lifetime
  of one export run: stage once, bind-mount the same read-only `inputDir` for every section of that
  package, and vary only `capture-spec.json` (write it into a small per-section dir mounted at a second
  path, or regenerate just that file). (2) Extend the container contract to accept a LIST of sections
  in one `capture-spec.json` and capture them in one browser process, so the container/Chrome start
  cost is paid once per package rather than once per section. Both are testable against the existing
  pure `buildCaptureSpec`/`buildContainerRunArgv` suites.
- effort: L

### [P2] Reported export progress goes 0 → 100 → 0, then sits at 0 for the whole audio pipeline
- id: media-012
- location: podcast-saas/backend-api/src/services/export/ProjectExportService.ts:343
- category: ux
- confidence: high
- status: confirmed
- what: Two separate distortions of the same counter. (a) During `capturing`, `objects_done` is
  incremented once per timeline window against `objects_total = plan.timeline.length`
  (`ProjectExportService.ts:302, 336-346`), so the bar walks to 100%; entering `assembling` it is
  reset with `{ status: 'assembling', objects_done: 0 }` (`:423`) and climbs again. (b) Inside
  `assembleResolved`, the first `push(0)` happens at `LinearAssembler.ts:681` — AFTER
  `buildAudioTrack` has run every mix pass plus the two-pass loudnorm (`:671`). Those passes each read
  the full timeline and are not instrumented at all (`runGraphToWav` passes no `onStdout`), so the bar
  is frozen at 0% for the entire audio phase.
- why: The user-visible contract is a percentage. Moving backwards reads as a restart; freezing at 0%
  for minutes reads as a hang and drives the "cancel and retry" behaviour that costs another full
  encode.
- evidence: Read `ProjectExportService.ts:299-302, 336-346, 415-423, 441-460` and
  `LinearAssembler.ts:656-692` (`push` is only wired to the video pass's `-progress pipe:1`).
- fix: Give the phases disjoint bands of one monotonic 0–100 scale: capture 0–40 (weight by window
  count), audio 40–55 (emit a step per completed mix/loudnorm pass — `buildAudioTrack` already knows
  `batches.length`), video 55–99, gates → 100. Remove the `objects_done: 0` reset. Add a test that the
  sequence of values written to `objects_done` across a whole run is non-decreasing.
- effort: M

### [P2] `ContainerCaptureProvider.isAvailable()` caches a `false` forever, so a late image pull degrades every export until restart
- id: media-013
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:270
- category: bug
- confidence: high
- status: confirmed
- what: `if (this.available !== null) return this.available;` memoises both outcomes. The provider is
  constructed per job (`queue/registry.ts:41`), so in the queue path the cache is per job — but
  `ProjectExportService` calls `isAvailable()` once per RUN and then trusts it for every window
  (`ProjectExportService.ts:330`), and any caller that holds a provider across jobs (a future shared
  instance, or a worker that constructs it at startup) pins the negative result for the process
  lifetime.
- why: The natural deploy order is "start the stack, then pull/build the export-worker image". Every
  export that starts in that window learns `false`, logs "worker image not runnable on this host", and
  ships posters — and, for a long-lived provider, keeps doing so after the image arrives. Nothing in
  the log tells an operator to restart.
- evidence: Read `containerCaptureProvider.ts:269-285`; the docker probe is a single `image inspect`
  whose result is stored unconditionally.
- fix: Cache only the positive result, or attach a short TTL (`{ value, at }`, re-probe after ~60 s).
  `docker image inspect` is cheap and runs once per export, not once per window.
- effort: S

### [P2] The untracked local capture provider is unreachable — `EXPORT_CAPTURE_LOCAL=1` wires nothing
- id: media-014
- location: podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts:326
- category: bug
- confidence: high
- status: confirmed
- what: `resolveLocalCaptureProvider()` has **zero callers**. The only place a capture backend is
  injected is `queue/registry.ts:41`, which passes `resolveConfiguredCaptureProvider()` (the container
  provider, gated on `EXPORT_CAPTURE_IMAGE`). `run-local-capture.sh:22` starts the backend with
  `EXPORT_CAPTURE_LOCAL=1` and `LOCAL-CAPTURE-README.md` documents the behaviour, but nothing reads the
  flag beyond the unreachable factory.
- why: Two things at once. First, on the brief's question — the file **cannot** engage in production,
  because it cannot engage anywhere; that is stronger containment than intended but it means the
  documented dev workflow silently produces poster fallbacks and a developer will read that as
  "capture is broken". Second, if it is later wired, it carries a real hazard: `shots` accumulates
  EVERY screencast frame as a Buffer in memory for the whole capture
  (`localCaptureProvider.ts:258,265`) — 30 fps × 60 s of 1080p JPEG q92 is several hundred MB with no
  bound — and its `outDir` (`:189`) is only removed on the failure path, leaking a clip dir per section
  on success (same shape as media-005).
- evidence: `grep -rn "localCaptureProvider" podcast-saas/backend-api/src` returns only the file
  itself; `grep -rn "resolveLocalCaptureProvider"` returns only its definition and its own doc comment.
  Read `queue/registry.ts:34-41`.
- fix: Decide one way. Either wire it —
  `new ProjectExportService(undefined, null, resolveLocalCaptureProvider() ?? resolveConfiguredCaptureProvider())`
  in `queue/registry.ts`, plus a hard `NODE_ENV !== 'production'` guard inside
  `resolveLocalCaptureProvider` so the env flag alone can never enable it on a server — and fix the
  unbounded `shots` buffer (cap frames and drop/subsample once the cap is hit) and the `outDir` leak;
  or delete the file and the shell script and stop advertising the workflow.
- effort: S

### [P2] `split` + `concat` can buffer a large source span when a source's windows are not in source order
- id: media-015
- location: podcast-saas/backend-api/src/services/export/ffmpegGraph.ts:247
- category: perf
- confidence: medium
- status: suspected
- what: A source used by N windows gets one decode and `split=N`, and each branch trims its own span.
  `concat` pulls its segments strictly in timeline order. When the timeline order matches the source
  order (the common case — base video windows resume at absolute time, `resolvePlan.ts:219-228`) the
  branches stay in lockstep and nothing accumulates. When it does NOT — e.g. two `clip` sections cut
  from the same library video where the later timeline position uses the earlier `clip_in_sec`, which
  nothing forbids — the branch feeding the later concat segment receives in-range frames while concat
  is still on an earlier segment, and those raw frames queue in the filter link.
- why: Raw 1080p yuv420p is ~3 MB/frame; a 10 s out-of-order span is ~900 MB of filter-queue memory
  inside one ffmpeg process on a 2-vCPU host. Marked `suspected` because libavfilter's queueing
  behaviour under `split`→`concat` is an ffmpeg-internal property I cannot prove from this repo.
- evidence: Read `ffmpegGraph.ts:222-250` (shared input + `split`) and `:281-290` (per-window trim,
  concat in timeline order). `resolvePlan.ts` sorts windows by `startSec` only — it never checks that a
  shared source's spans are monotonic. Confirming run: build a two-clip out-of-order plan against a
  long source and watch ffmpeg RSS during `assembleResolved` (`EXPORT_REAL_ENCODE=1`).
- fix: Detect non-monotonic source spans in `buildVideoSpine` — when a shared source's window
  `sourceInSec` values are not non-decreasing in timeline order, give those windows separate `-i`
  inputs (with `-ss`, which media-008 wants anyway) instead of `split` branches. This is a pure change
  to input planning and is unit-testable on the emitted graph text.
- effort: M

---

### [P3] The podcast mixer uses `-filter_complex_script`, deprecated in the pinned ffmpeg
- id: media-016
- location: podcast-saas/backend-api/src/services/podcast/audio/ffmpegAudio.ts:179
- category: maintainability
- confidence: high
- status: confirmed
- what: `mixTimeline` passes the graph with `-filter_complex_script <path>`. The export module uses the
  current spelling `-/filter_complex <path>` and documents the reason
  ("the script-file spelling of old is deprecated in ffmpeg 8 — measured, plan §5",
  `LinearAssembler.ts:9-10`). The image pins ffmpeg 8.1
  (`podcast-saas/deploy/docker/backend.Dockerfile:52`), where the old form still works but warns.
- why: Works today, breaks the whole podcast render the day the option is removed, and the two
  sibling modules disagree about the supported spelling.
- evidence: `ffmpeg -h full | grep filter_complex_script` → `deprecated, use -/filter_complex instead`;
  running it emits `-filter_complex_script is deprecated, use -/filter_complex … instead` and then
  proceeds. Read `ffmpegAudio.ts:176-179` against `LinearAssembler.ts:478-484`.
- fix: Change to `'-/filter_complex', graphPath` in `mixTimeline` (the pinned ffmpeg is ≥ 7, which is
  when the file-form was introduced). Update the mocked-spawn assertions in
  `podcast/audio/__tests__` that pin the argv.
- effort: S

### [P3] The fail-fast preflight probes filters but not the ffmpeg feature the assembler actually depends on
- id: media-017
- location: podcast-saas/backend-api/src/services/export/LinearAssembler.ts:272
- category: maintainability
- confidence: high
- status: confirmed
- what: `assertRequiredFilters()` runs `ffmpeg -filters` at job start so a deficient build "fails FAST
  with a named list, not minutes into an encode". It does not check the ffmpeg VERSION, and the
  assembler's load-bearing dependency is a version feature, not a filter: `-/filter_complex`
  (`:479`, `:686`) exists only from ffmpeg 7. Debian bookworm's apt ffmpeg is 5.1 — the Dockerfile says
  so explicitly at `deploy/docker/backend.Dockerfile:45-52` and works around it by installing a static
  8.1 build.
- why: Production is covered by the Dockerfile, so this is P3 — but any host that runs the backend
  outside that image (a bare-metal worker, a developer, a rescue box) passes the filter probe and then
  fails every export with an opaque "Unrecognized option" from a `ffmpeg-exit` gate.
- evidence: Read `LinearAssembler.ts:246-281` — the probe parses only filter names — and
  `deploy/docker/backend.Dockerfile:45-62`.
- fix: In `probeAvailableFilters`, also capture the banner version (drop `-hide_banner`, or run
  `ffmpeg -version` in the same limited slot) and throw a named error when major < 7, listing the
  required minimum. Unit-test the version parser against real `ffmpeg -version` first lines.
- effort: S

### [P3] Per-section capture clips are uploaded to the export's key space and never cleaned up
- id: media-018
- location: podcast-saas/backend-api/src/services/export/ProjectExportService.ts:390
- category: maintainability
- confidence: high
- status: confirmed
- what: Each captured section is uploaded to `exports/{projectId}/{exportId}/sections/{sectionId}.mp4`
  purely so the assembler can download it again by key like any other source (a deliberate and good
  design choice). Nothing deletes those intermediates after the master is published, and no retention
  record is created for them — unlike HLS, which has `hls_retired_runs` + `sweepRetiredHlsRuns`.
- why: An export of a 5-section project stores 5 intermediate clips plus the master forever. Deleting
  an export (or a project) has no path that reaches them since only `output_key` is recorded on the row.
- evidence: Read `ProjectExportService.ts:386-398` and the terminal write at `:495-509` (only
  `output_key` is persisted). `grep -rn "exports/" podcast-saas/backend-api/src/services` shows no
  deletion of the `sections/` prefix.
- fix: Delete the `exports/{projectId}/{exportId}/sections/` prefix in the same `finally` that removes
  `workDir` (after the master upload succeeds), or record the prefix on the row so the project-delete
  path can purge it with the master.
- effort: S

---

## Explicitly checked and clean

- **`ffmpegLimit.ts` slot accounting** — `runFfmpegLimited` releases in a `finally`, and `release()`
  hands the slot directly to the next waiter without touching `active`, so a throwing task cannot leak
  a slot and a queued waiter cannot be double-counted (`ffmpegLimit.ts:21-38`).
- **Child-process error propagation in the assembler** — `runFfmpegPass` inspects the exit code,
  keeps a 16 KiB stderr tail and surfaces it on failure, handles `error` (with a distinct ENOENT
  message) separately from `close`, and rejects rather than resolving (`LinearAssembler.ts:155-196`).
  Same shape in `HLSTranscoder.runProcess` (63-83) and `podcast/audio/ffmpegAudio.ff` (27-39).
- **Temp-dir lifecycle** — every work dir I found is removed in a `finally`: `ProjectExportService:549`,
  `runVideoTranscode:165`, `CaptionService:306`, `runCropAnalysis:137`, `PodcastRenderer:133`,
  `runPodcastClips:137`, `runPodcastMixExport:126`, `revoiceTurn:112`, `previewTurn:92`,
  `beginFrameBackend:550/556`. Paths are `mkdtemp`-unique, so two concurrent exports cannot collide.
  The two exceptions are media-005 and media-014.
- **Cancellation → truncated master** — the SIGTERM→SIGKILL escalation is correct and, crucially, the
  gates run after exit 0 and check duration FIRST, so the valid-but-truncated MP4 a SIGTERM leaves
  behind is rejected rather than published (`LinearAssembler.ts:165-196, 382-404`), and `output_key`
  is written only in the terminal `ready` update.
- **`-c copy` misuse** — there is none. Every path re-encodes; the export module documents the measured
  reason the concat demuxer + `-c copy` was rejected (1.36 s of baked-in A/V drift, `ffmpegGraph.ts:13-14`).
- **faststart** — `-movflags +faststart` is set for the export master (`ffmpegGraph.ts:478`) and the
  podcast mp4 (`ffmpegAudio.ts:217`), and the export additionally verifies moov-before-mdat by walking
  the actual top-level boxes rather than trusting the flag (`LinearAssembler.ts:294-344`).
- **Even dimensions / pixel format** — the grid is 1920×1080 and the anamorphic squaring uses
  `trunc(iw*sar/2)*2`, so no odd width can reach libx264; `format=yuv420p` is in the chain and
  re-asserted at the output (`ffmpegGraph.ts:133-142, 466`).
- **Half-open enable intervals** — `enableExpr` is the single producer of `gte(t,S)*lt(t,E)` and a test
  scans the source for the banned closed-interval form (`ffmpegGraph.ts:116-119`).
- **Crop pipeline** — `streamRgbFrames` is genuinely streaming with pipe backpressure and a
  copied sub-frame remainder; all three crop spawns are wrapped by the limiter at the call sites
  (`cropProcessor.ts:84,90,111`).
- **HLS conformance gate** — profile/level/keyframe/EXTINF are all probed from emitted bytes BEFORE
  any upload, and the master playlist's `CODECS` is built from the probe rather than the request
  (`HLSTranscoder.ts:286-323, 463-477`). That gate is the reason media-002 is a rendering bug and not
  a container-conformance one — SAR is not among the things it checks.
