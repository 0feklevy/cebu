### [P1] Export assembly buffers every source video fully into heap before writing it to disk
- id: perf-001
- location: podcast-saas/backend-api/src/services/export/LinearAssembler.ts:761-765
- category: perf
- confidence: high
- status: confirmed
- what: `createLinearAssembler().assemble()` materialises every storage key the export plan
  references with:
  ```
  for (const key of translated.keys) {
    const bytes = await storage.readObject(key);
    await writeFile(keyPaths.get(key)!, bytes);
  }
  ```
  `AssemblerStorage` (line 706) exposes only `readObject(key): Promise<Buffer>` — the interface
  itself forecloses streaming. `R2StorageAdapter.readObject` / `SupabaseStorageAdapter.readObject`
  (`podcast-saas/backend-api/src/services/storage/R2StorageAdapter.ts:370-381`,
  `SupabaseStorageAdapter.ts:514-524`) both fully drain the S3 `GetObjectCommand` body stream into
  `chunks: Buffer[]` then `Buffer.concat` before returning — so the whole object sits in a single
  Buffer, which is then copied again into `writeFile`'s internal buffer.
- why: **Cost is O(source file size) heap, held twice (SDK read buffer + the `Buffer` returned to
  the caller) for the duration of the write.** A project's source video is a full recording —
  realistically hundreds of MB to several GB for an hour of 1080p/4K footage — and every export of
  that project re-downloads and re-buffers it from scratch. The comment at line 759-760
  ("sequential downloads keep peak memory to one object") shows the authors reasoned about
  cross-object concurrency but not about the single object's buffering itself, so a project with
  one large source (or one long export session run back-to-back with others) spikes the worker
  process's heap by the full file size. This is exactly the anti-pattern the codebase already fixed
  once, next door: `HLSTranscoder.ts` (`uploadDir`, line 345-369) has a comment citing "perf-002" —
  reading+uploading all HLS segments at once held ~2.5 GB in heap and risked OOM — and the fix was
  bounded fan-out. `LinearAssembler.ts`'s comment at the top ("Every spawn goes through
  runFfmpegLimited... spawn arrays only, no shell") shows the same file is otherwise disciplined
  about resource bounds, but this read path was not given the same treatment.
- evidence: Read `LinearAssembler.ts:700-776` (the `AssemblerStorage` interface and `assemble()`),
  `R2StorageAdapter.ts:370-381` and `SupabaseStorageAdapter.ts:514-524` (both `readObject`
  implementations use the chunks/`Buffer.concat` pattern), and `R2StorageAdapter.ts:98-125` which
  shows a `streamObject(key, rangeHeader)` method already exists on the same adapter (used by
  `serveFile.ts` for range-request media serving) and returns `resp.Body` — the raw
  `NodeJS.ReadableStream` — with **no buffering**. The streaming primitive already exists in this
  codebase; the assembler's storage seam just doesn't expose it.
- fix: Add a `readObjectToFile(key, destPath): Promise<void>` (or expose `streamObject`) on
  `AssemblerStorage` that pipes the SDK's response body directly into a `fs.createWriteStream`
  (`stream/promises` `pipeline`), and use it in the `for (const key of translated.keys)` loop
  instead of `readObject` + `writeFile`. No change needed to the sequential-download discipline —
  only to how each object moves from network to disk.
- verify: after the change, materialising a source > 500 MB should show flat RSS growth in the
  worker process instead of a step matching the file size; `pnpm -C podcast-saas --filter
  backend-api test` (LinearAssembler has existing unit coverage) should stay green with the storage
  mock updated to the new method.
- cross: none (ffmpeg-graph correctness untouched; this is pure I/O plumbing)
- effort: M

### [P2] Captured sim-section clips are always buffered fully into heap before upload — no size gate, unlike the master output 90 lines below
- id: perf-002
- location: podcast-saas/backend-api/src/services/export/ProjectExportService.ts:391
- category: perf
- confidence: high
- status: confirmed
- what: `await this.storage.uploadFile(clipKey, await readFile(result.clipPath), 'video/mp4',
  IMMUTABLE_CACHE_CONTROL);` runs unconditionally for every captured `sim-capture` window, reading
  the whole encoded clip into a `Buffer` first.
- why: **Cost is O(clip file size) heap per section, with no upper bound.** Contrast this with the
  master-file upload 85 lines later in the same file (line 474-484): that path explicitly checks
  `size <= UPLOAD_BUFFER_MAX_BYTES` (256 MB, line 150) and falls back to
  `this.storage.uploadStream(...)` above that threshold, with a comment explaining exactly why
  ("a large master streams without it rather than transiting the heap"). The per-section clip path
  applies none of that reasoning — a long or high-resolution scripted simulation section produces a
  clip that is buffered regardless of size. Sections run sequentially within one export (bounding
  peak memory to one clip at a time for a single job), but nothing bounds it across the section loop
  cumulatively pressuring GC, nor across concurrent export jobs.
- evidence: Read `ProjectExportService.ts:150` (`UPLOAD_BUFFER_MAX_BYTES`), `:361-398` (the capture
  loop and upload call), and `:474-484` (the sibling master-upload branch that does gate on size).
  No `durationSec`/size cap on scripted sim sections was found anywhere in
  `podcast-saas/backend-api/src/services/export/*.ts`.
- fix: Apply the same `stat(result.clipPath)` + `UPLOAD_BUFFER_MAX_BYTES` branch used for the
  master upload, or simply always use `uploadStream` + `createReadStream` for section clips since
  they don't need the buffered path's cache-control override capability that the master needs.
- verify: a long/high-res sim section's clip upload should stream rather than show a heap spike
  proportional to clip size; existing export integration tests should stay green.
- cross: none
- effort: S

### [P2] Podcast render output (master mp4 + mp3) is always buffered fully into heap on upload — same anti-pattern as perf-002, no size gate anywhere
- id: perf-003
- location: podcast-saas/backend-api/src/services/podcast/audio/PodcastRenderer.ts:115-116
- category: perf
- confidence: high
- status: confirmed
- what:
  ```
  await this.storage.uploadFile(mp4Key, await readFile(mp4Path), 'video/mp4', ...);
  await this.storage.uploadFile(mp3Key, await readFile(mp3Path), 'audio/mpeg', ...);
  ```
  Both the full rendered episode video and audio are read entirely into memory, one after the
  other, before upload. The same pattern recurs at
  `podcast-saas/backend-api/src/services/podcast/audio/runPodcastMixExport.ts:110`
  (`await storage.uploadFile(key, await readFile(outPath), fmt.mime, ...)`), and the smaller
  per-turn variants at `previewTurn.ts:85`, `revoiceTurn.ts:87`, `runPodcastClips.ts:96` (lower
  severity — those are single-turn clips, seconds long, not full episodes).
- why: **Cost is O(episode duration × bitrate) heap, held twice in sequence (mp4 then mp3) with no
  cap.** Nothing in `podcast-saas/backend-api/src/services/podcast/**` bounds episode duration
  (grepped for `MAX_DURATION`/`maxDuration`/duration caps — none found), so a multi-hour episode's
  rendered master fully buffers into the worker heap on every render and every re-render (e.g. after
  a script edit). Unlike `ProjectExportService.ts`'s master-upload path, there is no size threshold
  anywhere in this file that switches to a streamed upload.
- evidence: Read `PodcastRenderer.ts:100-120` and `runPodcastMixExport.ts:95-115`. Confirmed
  `StorageService.uploadFile` takes a `Buffer` (`StorageService.ts:16`) and `uploadStream` exists as
  an alternative (`StorageService.ts:17`, already used by `ProjectExportService.ts:483` for its
  large-file branch) — the streaming path is available, just unused here.
- fix: Same remedy as perf-002 — `stat()` the encoded output and branch to `uploadStream` +
  `createReadStream` above a size threshold (or just always stream; these outputs never need the
  buffered path's extra features beyond cache-control, which `uploadStream` could also accept if
  extended).
- verify: rendering a long synthetic episode (or an episode assembled from many turns) should show
  heap usage independent of output duration.
- cross: none
- effort: S

### [P2] Local dev capture provider's frame-encode spawn bypasses the shared ffmpeg concurrency cap — the only spawn site in the codebase that does
- id: perf-004
- location: podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts:108
- category: perf
- confidence: high
- status: confirmed
- what: `encodeFramesToClip()` calls `spawn('ffmpeg', args, ...)` directly, not wrapped in
  `runFfmpegLimited`. Every other ffmpeg/ffprobe spawn site in the backend goes through it:
  `LinearAssembler.ts` (`runFfmpegPass`/`runFfprobeJson`/`probeAvailableFilters`, all wrapped, and
  the file's own header comment says "Every spawn goes through runFfmpegLimited"),
  `HLSTranscoder.ts`, `generateVideoMetadata.ts`, `crop/cropProcessor.ts` (wraps
  `crop/ffmpegExtract.ts`'s spawns at its one call site), `captions/CaptionService.ts`, and
  `podcast/audio/ffmpegAudio.ts` all wrap every spawn.
- why: **Cost is one more concurrent ffmpeg encode per in-flight local capture, entirely outside
  the accounting the rest of the codebase relies on (`FFMPEG_CONCURRENCY`, default 2).** The
  provider is default-off (`resolveLocalCaptureProvider()` returns `null` unless
  `EXPORT_CAPTURE_LOCAL=1`, a dev-only flag per its own doc comment) — that's why this is P2, not
  P1: not reachable in a normal production deployment today. But it is now wired into the live job
  handler as of this branch's uncommitted change to
  `podcast-saas/backend-api/src/queue/registry.ts:39-40`
  (`new ProjectExportService(undefined, null, resolveLocalCaptureProvider())`), so if the flag is
  ever set in a shared environment (staging, or a misconfigured prod), every `project_export` job's
  frame-encode step, plus a full headless Chromium launch per section
  (`localCaptureProvider.ts:196-205`, also unbounded), stacks on top of whatever else is consuming
  the shared ffmpeg budget — silently defeating the one global cap the rest of the system depends
  on to avoid saturating the host.
- evidence: `grep -n "runFfmpegLimited" podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts`
  returns no matches; `grep -rln "runFfmpegLimited"` across `src/services` lists every other
  ffmpeg-spawning file except this one. Confirmed via `git diff` that
  `queue/registry.ts` wires `resolveLocalCaptureProvider()` into the real `project_export` handler
  in the current working tree (uncommitted).
- fix: Wrap the `spawn('ffmpeg', ...)` call in `encodeFramesToClip` with `runFfmpegLimited(() =>
  ...)`, matching every sibling spawn site.
- verify: with `EXPORT_CAPTURE_LOCAL=1` and `FFMPEG_CONCURRENCY=1`, two concurrent local-capture
  encodes should serialize instead of running side by side (observable via process list / timing).
- cross: [job-queue] podcast-saas/backend-api/src/queue/registry.ts:39-40 newly wires
  resolveLocalCaptureProvider() into the live project_export handler — please confirm pg-boss
  concurrency for project_export plus this dev flag can't combine into an unbounded Chromium/ffmpeg
  fan-out on a shared host. (ref perf-004)
- effort: S
