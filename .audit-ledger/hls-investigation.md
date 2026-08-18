# HLS — transcode & delivery investigation

Branch: `fix/night-audit-2026-08-15` @ `ef651a9` (40 commits past the audit commit `2d187e3`).

**Nothing in the HLS path has changed since the audit.**
`git log 2d187e3..HEAD -- backend-api/src/services/video backend-api/src/server.ts
backend-api/src/services/storage client-web/components/viewer client-web/hooks` returns **zero
commits**. Every HLS finding from run `2026-08-15T2109` (`media-002`, `media-006`, `security-001`)
is still live, verbatim, at the same line numbers.

> **Line anchors are against committed `HEAD` (`ef651a9`), not the working tree.** While I was
> reading, another agent edited this shared worktree: `git status` shows uncommitted changes to
> `client-web/components/viewer/useProjectPlayer.ts` (+123/-16, an unrelated b-roll-revision change),
> `controllers/v1/video.controller.ts`, `deploy/docker-compose.yml` and `deploy/nginx/nginx.conf`
> (all upload-size-limit work). None of it touches anything in this report — I diffed each — but it
> shifts player line numbers by ~+110 in the working tree. Verify with
> `git show HEAD:<path>` if a citation does not land.

Scope read: `services/video/{HLSTranscoder,runVideoTranscode,hlsVersioning,hlsRetention}.ts` +
their 6 test files, `server.ts` media routes, `services/storage/{Supabase,R2,Local}StorageAdapter.ts`,
`services/buildPlayerConfig.ts`, `queue/{index,registry,pgBoss,inlineDriver}.ts`,
`client-web/components/viewer/useProjectPlayer.ts`, `client-web/hooks/useSegmentedPlaybackCore.ts`,
`deploy/{docker-compose.yml,nginx/**}`.

## Measurement rig

Several claims below are **measured, not reasoned**. Fixture: 20 s `testsrc2` 1080p30 + sine,
`ffmpeg 8.1.2` (same major as the image pin, `deploy/docker/backend.Dockerfile:52` → `ffmpeg-n8.1`),
Apple silicon. The **absolute** seconds do not transfer to the 2-vCPU x86 VM; the **ratios** and the
**pass/fail outcomes** do. Artifacts in `scratchpad/hlsprobe/`.

Per-pass CPU (user+sys), each pass including its own full decode:

| pass | CPU (s) | of which decode | encode-only |
|---|---|---|---|
| decode only (`-f null`) | 2.87 | 2.87 | — |
| 360p | 6.46 | 2.87 | 3.59 |
| 480p | 9.53 | 2.87 | 6.66 |
| 720p | 16.67 | 2.87 | 13.80 |
| 1080p | 23.55 | 2.87 | 20.68 |
| 1080p at `-preset veryfast` | 12.50 | 2.87 | 9.63 |
| **full ladder as shipped** (4 invocations, audio + HLS mux) | **65.50** | 11.48 | — |
| **same ladder, one invocation, `split=4`** | **57.10** | 2.87 | — |

The two ladders produce the same thing: 5 segments per tier in both, per-tier byte totals within
0.5 % (1860/1840, 3472/3460, 8808/8792, 16404/16400 KB).

---

# BUGS (wrong today)

## B1 — Anamorphic sources are pillarboxed AND stretched in every HLS tier
**`podcast-saas/backend-api/src/services/video/HLSTranscoder.ts:175`** — still live (this is
`media-002`; unchanged since the audit).

```ts
'-vf', `scale=${tier.width}:${tier.height}:force_original_aspect_ratio=decrease,pad=${tier.width}:${tier.height}:(ow-iw)/2:(oh-ih)/2`,
```

`grep -n setsar HLSTranscoder.ts` → no match. `grep -n 'iw\*'` → no match. The fit is computed on
**storage** dimensions, and the non-unity SAR survives into the output.

Measured on a 1440x1080 SAR 4:3 (DAR 16:9) source — an ordinary HDV/broadcast shape:

| chain | out W×H | SAR | DAR | `cropdetect` |
|---|---|---|---|---|
| **HLS tier (`HLSTranscoder.ts:175`)** | 1280×720 | **4:3** | **64:27** | **`crop=960:720:160:0`** |
| export (`ffmpegGraph.videoNormChain`, `ffmpegGraph.ts:133-142`) | 1280×720 | 1:1 | 16:9 | `crop=1280:720:0:0` |

So: 160 px of black on each side (25 % of the frame is bars), and then the surviving SAR 4:3 makes
the player stretch that composite by 4/3. Both defects, simultaneously, exactly as the sibling
module's header comment names it — `ffmpegGraph.ts:9`: *"…anamorphic input comes out both
pillarboxed and stretched — §5 of the plan, **and a live bug in HLSTranscoder.buildTierArgs**"*.
The export path was fixed; the HLS path — which is what every viewer actually streams — was not.

Fix is a one-line `-vf` change (prepend `scale=trunc(iw*sar/2)*2:ih,setsar=1,`, append `,setsar=1`)
plus updating the pinned-args test at `services/video/__tests__/hlsTranscoder.test.ts:56-81`.

## B2 — Any source that is not 8-bit 4:2:0 fails the ENTIRE HLS transcode (new; not in the audit)
**`HLSTranscoder.ts:175-179`** — the `-vf` has no `format=yuv420p` and the encoder args have no
`-pix_fmt`. The export path has both (`ffmpegGraph.ts:141` `format=yuv420p`, `ffmpegGraph.ts:466`
`-pix_fmt yuv420p`). libx264 in this build advertises 10-bit and 4:2:2 pixel formats, so ffmpeg
negotiates the *input's* format into the encoder, and then `-profile:v` rejects it:

```
# yuv420p10le source (HDR phone capture, HEVC Main10, ProRes → 10-bit), 360p tier args:
x264 [error]: baseline profile doesn't support a bit depth of 10
[libx264] Error setting profile baseline.
[libx264] Possible profiles: baseline main high high10 high422 high444
Conversion failed!

# yuv422p10le source (ProRes 422 HQ), same args:
x264 [error]: baseline profile doesn't support 4:2:2
[libx264] Error setting profile baseline.
```

Appending `,format=yuv420p` to the same `-vf` makes it succeed (measured, `kb/s:175.92`).

Local build advertises: `yuv420p yuvj420p yuv422p yuvj422p yuv444p yuvj444p nv12 nv16 nv21
yuv420p10le yuv422p10le yuv444p10le nv20le gray gray10le`.

**Blast radius.** It fails on the *first* tier, so nothing is uploaded and `hls_master_key` is never
set — the video simply never plays. `runVideoTranscode.ts:158-161` writes `hls_status='failed'` with
the raw ffmpeg stderr tail as `hls_error`. Because `transcode` runs on the **inline** driver (see
L1), there is no retry and no durable job row. This is a permanent dead end for the upload.

I cannot tell from the repo how often this fires — it needs a `pix_fmt` histogram over the real
`video_files` corpus. **Measurement that settles it:** `ffprobe -show_entries stream=pix_fmt` over
uploaded sources, or simply `SELECT count(*) FROM video_files WHERE hls_status='failed' AND
hls_error LIKE '%profile%'`. iPhone "HDR video" (default ON since iOS 15) decodes to 10-bit.

## B3 — The retention sweep marks a tree deleted even when the delete failed
**`hlsRetention.ts:73-84`** vs **`storage/deleteWithFallback.ts:22-30`**.

`sweepRetiredHlsRuns` documents itself at `hlsRetention.ts:57-59`: *"A row whose storage delete
throws is left unmarked and retried on a later sweep."* But `deleteWithPrefixFallback` **cannot
throw** —

```ts
await storage.deleteWithPrefix(prefix).catch((err) =>
  logger.warn({ prefix, err: … }, '[storage] primary prefix delete failed'),
);
```

— so the `try` at `hlsRetention.ts:74` never catches, `deleted_at` is stamped at `:76-79`, and the
row is filtered out of every future sweep by the `isNull(deleted_at)` predicate at `:68`. A
transient Supabase 5xx during a sweep therefore leaks that whole run tree **permanently**, with a
`warn` line as the only trace. The unit test at `__tests__/hlsRetention.test.ts` mocks the helper,
so the divergence between the doc and the helper is invisible to it.

## B4 — A failed transcode leaks its partial tree and leaves `hls_360p_key` pointing into it
**`runVideoTranscode.ts:153-167`** — still live (`media-006`; unchanged). The catch marks the row
failed and rethrows; only the `finally` at `:164-167` runs, and it deletes the **local** `workDir`.
Nothing retires `hls/{videoFileId}/{runId}/`. Only a *previously successful* tree is ever retired,
and only via `previousHlsTreeToGc(videoFileId, oldMasterKey, runId)` (`hlsVersioning.ts:43-53`),
which derives the prefix from `hls_master_key` — a failed run never became a master key, so it is
invisible to `hls_retired_runs` and to the sweep forever.

Secondarily, `onTierComplete` writes `hls_360p_key` at `runVideoTranscode.ts:74-79` **before** the
run is known good, and `buildPlayerConfig.ts:505-509` uses `hls_360p_key` as the fallback when
`hls_master_key` is null — which is exactly the post-failure state. So after a tier-2/3/4 failure
the player config points at a 360p playlist inside an unreferenced, un-swept tree.

Given B2, this is not hypothetical: every 10-bit upload fails at tier 1 (no leak, nothing uploaded
yet), but every ENOSPC / conformance / OOM failure at tier 2+ leaks 1–3 tiers of segments.

## B5 — A permanently-404 segment puts the player in an unbounded retry loop with no user signal
**`client-web/components/viewer/useProjectPlayer.ts:2462-2481`** (and the same shape at
`:2204-2210` for b-roll, and `hooks/useSegmentedPlaybackCore.ts`):

```ts
if (!d.fatal) return;
if (d.type === 'networkError') { setTimeout(() => { try { hls.startLoad(); } catch {} }, 1000); }
```

No attempt counter, no backoff growth, no terminal state, and nothing merged into player state that
the shell could render. hls.js exhausts its own `fragLoadPolicy` retries, goes fatal, this handler
waits 1 s and calls `startLoad()`, which resumes at the same position and hits the same 404 —
forever. Playback never dies (good) but never recovers and never tells anyone (bad).

The reachable trigger is the retention sweep: `HLS_RETIRE_GRACE_HOURS` default 24 h
(`hlsRetention.ts:20`), and a player config fetched before a re-transcode holds the *old* master URL.
A tab left open across a re-transcode + 24 h, or a cached/shared player config, lands here.

## B6 — Every other section starts at 360p regardless of measured bandwidth
`useProjectPlayer.ts:106` — `HLS_OPTS_STANDBY = { ...HLS_OPTS, startLevel: 0, maxBufferLength: 8 }`.

Two `Hls` instances are constructed once, at `:3470` (`new HlsLib(HLS_OPTS)`, `startLevel: -1`) and
`:3477` (`new HlsLib(HLS_OPTS_STANDBY)`, `startLevel: 0`). `prewarm` (`:2497-2503`) always loads the
next section into the **standby** instance; `swapVideos` (`:2504-2528`) then swaps the two refs and
re-applies **only** `maxBufferLength` / `maxMaxBufferLength` / `backBufferLength` (`:2516-2524`).
`config.startLevel` is never re-applied. So instance B keeps `startLevel: 0` for the life of the
session and every section it loads — sections 1, 3, 5, … — begins its first fragment at 640×360.

The comment at `useSegmentedPlaybackCore.ts:45-46` ("Once promoted to the active slot it inherits
the ABR state") is true of the *bandwidth estimate* and false of the *first fragment*: the fragment
that is on screen at the instant of the swap was already fetched at level 0.

Cost: one segment = **4 s of 360p at the start of every other section**. In a product built from
"short simulation-interleaved sections", that is a large fraction of watch time. If sections average
20 s, it is ~10 % of all video frames at the bottom rung.

## B7 — Declared `BANDWIDTH` is below the actual peak segment bitrate on every rung
`HLSTranscoder.ts:30-33` declares 700 000 / 1 400 000 / 3 200 000 / 6 000 000. Measured peak segment
bitrate from the shipped args on the fixture:

| tier | declared BANDWIDTH | measured peak | over |
|---|---|---|---|
| 360p | 700 000 | 776 444 | +11 % |
| 480p | 1 400 000 | 1 497 187 | +7 % |
| 720p | 3 200 000 | 4 076 986 | **+27 %** |
| 1080p | 6 000 000 | 8 334 531 | **+39 %** |

Structural cause, not fixture noise: `-bufsize` is 2× `-b:v` (`HLSTranscoder.ts:187`), which lets a
4 s segment burst well over the average; the declared numbers also ignore MPEG-TS packetisation
(measured 6.8 % at the packet level on a 360p segment) and are inconsistent about audio headroom.
RFC 8216 §4.3.4.2 requires `BANDWIDTH` to be the **peak** segment bit rate; hls.js's ABR picks the
top level whose declared `BANDWIDTH` fits the measured throughput, so an understated value makes the
player switch up into a rung it cannot sustain — and the error is worst on the rung people switch
*up* into.

Caveat, stated honestly: `testsrc2` is high-entropy synthetic content, so real peaks will be lower
in absolute terms. The *sign* of the error is structural. **Measurement that settles it:** max
segment bitrate per tier across a sample of real uploads (`for f in *.ts; do echo $(stat -f%z $f)`
÷ EXTINF), then set `BANDWIDTH` to that max and add `AVERAGE-BANDWIDTH`.

## B8 — `-level` is pinned but not enforced: >30 fps sources ship a stream that lies about its level
`HLSTranscoder.ts:179` writes `-level 3.1` for the 720p tier. There is no `-r` anywhere in
`buildTierArgs`, so a 60 fps source stays 60 fps. Measured on a 720p60 source with the exact 720p
tier args:

```
[libx264] MB rate (216000) > level limit (108000)
[libx264] profile Main, level 3.1, 4:2:0, 8-bit
→ ffprobe seg_000.ts: profile=Main  level=31  r_frame_rate=60/1
```

x264 emits a warning, writes `level_idc=31` into the SPS anyway, and the conformance gate at
`HLSTranscoder.ts:293-300` passes — it compares the **declared** level to the matrix, not the level
the stream actually requires. The module's own docstring (`:24-27`) exists because the old master
"claimed avc1.42e01e for all four tiers — a lie players use for codec selection"; this is the same
class of lie, one layer down, and the gate built to catch it does not. Hardware decoders that
enforce level (older Apple TV, Roku, low-end Android) can refuse the stream.

---

# LIMITS (correct today, fail at scale)

## L1 — HLS transcode runs **inline, inside the API process**, on the 2-vCPU web tier
This is the single biggest structural fact about this pipeline.

- `queue/pgBoss.ts:22` — `PGBOSS_JOB_NAMES = ['crop', 'video_generate', 'project_export']`.
- `transcode` is **not** in it (`queue/registry.ts:23`), so `enqueueJob('transcode', …)`
  (`controllers/v1/video.controller.ts:24`, and again on the replace-media path at `:552`) falls to `getInlineQueue().enqueue(...)`
  at `queue/index.ts:53`.
- `queue/inlineDriver.ts:22-29` — `setImmediate`, rejection swallowed, **no durability, no retries**.
- `deploy/docker-compose.yml:38-39` sets `QUEUE_DRIVER: pgboss` **and** `WORKER_INLINE: 'false'` on
  the `backend` service; the dedicated `worker` container (`:62-84`) subscribes only to
  `PGBOSS_JOB_NAMES` (`queue/startWorker.ts:18`). So `transcode` runs in `backend`, the container
  nginx proxies every API request to.
- `NEVER_INLINE` (`queue/index.ts:42`) contains `project_export` only. The reasoning in its comment
  — *"Running that inline means it runs in the API process — competing with every request handler,
  holding the event loop"* — applies verbatim to the HLS ladder, which is comparable work.

**What breaks first, and at what scale.** `ffmpegLimit.ts:8` caps total ffmpeg/ffprobe processes at
`FFMPEG_CONCURRENCY` (default **2**, not set in compose) across *all* subsystems — HLS, captions,
crop, frame previews, waveform, export. On the fixture the shipped ladder costs **65.5 s CPU per
20 s of 1080p30 source = 3.3× realtime** on fast Apple-silicon cores. x264 `preset fast` on a shared
2-vCPU cloud x86 core runs roughly 2–4× slower per core, so expect **~7–13× realtime CPU** there.

Consequences at concrete N:
- **N = 1 concurrent upload.** A 10-minute 1080p upload is ~70–130 minutes of CPU, and it is
  allowed to occupy 2 of the box's 2 vCPUs (`MAX=2`, and no `-threads` cap on x264 so each pass also
  oversubscribes). API latency degrades for the entire window.
- **N = 2.** The limiter saturates (`ffmpegLimiterState().queued > 0`); the second upload's tiers
  queue behind the first's. Also — and this is the sharp edge — **captions, crop, waveform and
  frame-preview all draw from the same 2 slots**, so a single transcode starves them too.
- **N = 3+.** Uploads queue unboundedly inside the API process with no visibility. A `docker
  restart` / deploy during the window kills them: `drainInlineJobs` (`inlineDriver.ts:40`) waits at
  most 25 s, and a half-finished transcode leaves `hls_status='processing'` forever — I found **no
  reaper** for stale `processing` rows (`grep -rn hls_status` shows only the writers).

**Measurement that settles the multiplier:** run `hlsTranscoder.realEncode.test.ts` with
`HLS_REAL_ENCODE=1` on the actual VM and record wall time, or `/usr/bin/time` one production
transcode. Everything above is a ratio measured elsewhere times an assumed core-speed factor.

## L2 — The ladder is four rungs, always, even when three of them are upscales
`transcodeToHLS` iterates `for (const tier of TIERS)` at `HLSTranscoder.ts:431` with no reference to
the probed source resolution. `probeMediaInfo` (`:127-141`) reads duration and fps and **not** width
or height. A 640×360 screen recording is therefore upscaled to 854×480, 1280×720 and 1920×1080 and
encoded at 1000k / 2800k / 5500k — three rungs of pure waste that carry no information the 360p rung
does not already have, and a master playlist that advertises `RESOLUTION=1920x1080` for it.

By the table above, 720p+1080p are **62 % of the ladder's video CPU** (34.5 s of 56.2 s). Capping
the ladder at the source height is the single largest CPU lever available and costs nothing in
quality.

Is the ladder *itself* sensible? Measured average bitrates: 753k → 1.40M → 3.56M → 6.63M, i.e.
adjacent ratios **1.86× / 2.54× / 1.86×**. Apple's HLS Authoring Spec wants ~1.5–2× between rungs.
The 480p→720p step at 2.54× is too wide: a viewer whose throughput sits between 1.5 and 3.5 Mbps has
nothing to sit on and will oscillate. Resolution steps (0.23 → 0.41 → 0.92 → 2.07 MP) are fine.

## L3 — Four separate ffmpeg invocations decode the source four times
`HLSTranscoder.ts:431-445` runs one `runProcess('ffmpeg', ['-y', ...buildTierArgs(tier, …)])` per
tier, each with its own `-i ctx.inputPath` (`:174`). Measured: decode is 2.87 s of each pass, so
**8.6 s of the 65.5 s ladder (13 %) is redundant decoding**. The single-invocation `split=4`
equivalent measured **57.10 s CPU / 22.16 s wall** vs **65.50 s / 50.90 s**, producing byte-equal
output. On a 2-vCPU box the wall-clock advantage shrinks (less parallelism to exploit) but the
13 % CPU saving is pure and transfers directly.

Note the sequential loop is also what makes the per-tier progress UI (`onTierStart`/`onTierComplete`,
`hls_current_tier`, `hls_360p_key` early playback) possible — see D2.

## L4 — Early playback is locked to 360p for ~88 % of the transcode
`onTierComplete` sets `hls_360p_key` after tier 1 (`runVideoTranscode.ts:74-79`) and
`buildPlayerConfig.ts:505-509` serves it when `hls_master_key` is null. That key points at a
**single-variant** playlist, so there is no ABR and no way up. `hls_master_key` is only written at
`runVideoTranscode.ts:93-103`, after all four tiers. By the CPU table, 360p is 6.46 s of 56.2 s —
so a viewer who starts watching during transcode is pinned at 640×360 for **~88 %** of the job.

## L5 — The sweep is 20 trees/hour and runs in the web process
`hlsRetention.ts:53` — `HLS_RETIRE_SWEEP_LIMIT = 20`; `:113` — hourly; `server.ts:513` starts it in
the API process. Each tree is a `ListObjectsV2` + `DeleteObjects` loop
(`SupabaseStorageAdapter.ts:282-300`). A 30-minute video's tree is 4 tiers × ~450 segments ≈ **1 800
objects**; 20 trees ≈ 36 000 object deletes per pass, sequential, on the web tier. It keeps up as
long as re-transcodes stay under 20/hour — which they will for a long time — but the *shape* is
wrong: retention competes with request handling on the box that is already the bottleneck (L1).

## L6 — There is no way to put a CDN in front of HLS without a code change
`SupabaseStorageAdapter.ts:90` hard-derives `publicBase` from `SUPABASE_URL`:
`${origin}/storage/v1/object/public/${bucket}` — there is no `*_CDN_URL` / custom-domain override in
`.env.example:77-84` and no indirection at `getPublicUrl` (`:428-430`). Whatever caching Supabase's
public object endpoint does is what you get, and it cannot be swapped for Cloudflare/Fastly/Bunny
without editing the adapter.

---

# COSTS (works, but expensive)

## C1 — MPEG-TS costs 14–20 % more bytes than fMP4 for the identical encode
`-hls_segment_filename …/seg_%03d.ts` with no `-hls_segment_type` (`HLSTranscoder.ts:193-194`) →
MPEG-TS. Measured, same encoder args, same fixture:

| tier | TS | fMP4 (CMAF) | saving |
|---|---|---|---|
| 360p | 1860 KB | 1480 KB | **20.4 %** |
| 1080p | 16 404 KB | 14 044 KB | **14.4 %** |

Packet-level overhead on a single 360p segment: container 372 240 B vs elementary 348 548 B = 6.8 %;
the rest is ADTS vs `mp4a` sample entries plus PAT/PMT/PCR repetition. That is 14–20 % off both
Supabase storage **and** every byte of egress, forever. It costs old-device compatibility
(fMP4 HLS needs iOS 10+ / Android 4.4+ / a `#EXT-X-VERSION:7` playlist) — see D4.

## C2 — Legacy unversioned trees are never reclaimed
`previousHlsTreeToGc` (`hlsVersioning.ts:43-53`) returns `null` unless the old master parses as
`hls/{id}/{runId}/master.m3u8`. Legacy keys (`hls/{id}/master.m3u8`) return `null` deliberately —
the comment at `:39-42` is right that deleting `hls/{id}/` would take the *new* tree with it. The
consequence is that the first re-transcode of any pre-versioning video strands its old tree
permanently, invisible to `hls_retired_runs`. Bounded (one per legacy video) but never zero.
**Measurement:** list `hls/` prefixes and diff against `video_files.hls_master_key`.

## C3 — `hls_retired_runs` never prunes swept rows
`sweepRetiredHlsRuns` stamps `deleted_at` and moves on; nothing deletes the row. The partial index
`idx_hls_retired_runs_due … WHERE deleted_at IS NULL` (migration `053_hls_retired_runs.sql:34-35`)
keeps the sweep an index scan, so this is table bloat only, not latency. Small.

## C4 — `preset fast` on a 2-vCPU host
`HLSTranscoder.ts:177`. Measured on the 1080p tier: `fast` = 23.55 s, `veryfast` = 12.50 s — **1.9×**
for one preset step. Whether that is the right trade is a product call, not a code fact (D3).

---

# DELIVERY — what is actually in front of the segments

Answering the question directly, because the code has three paths and only one of them is production:

- **Production is Supabase, and media does NOT pass through the API.**
  `deploy/docker-compose.yml:48` and `:80` pin `STORAGE_BACKEND: supabase`;
  `getStorageAdapter.ts:95-99` selects `SupabaseStorageAdapter`; `getPublicUrl` (`:428-430`) returns
  `https://<ref>.supabase.co/storage/v1/object/public/media/hls/{id}/{runId}/…`, and
  `buildPlayerConfig.ts:505-509` puts exactly that in `hls_url`. **The 2-vCPU box serves zero media
  bytes.** The hard ceiling you were worried about is not present in the deployed configuration.
- **`/hls-proxy` (`server.ts:322-365`) is the R2 path, and it is not used in production.** Its
  purpose is stated at `:315-316`: `pub-*.r2.dev` ignores `PutBucketCorsCommand`, so R2 HLS has to
  be re-served with `Access-Control-Allow-Origin`. `R2StorageAdapter.getPublicUrl` (`:316-324`)
  routes every `hls/` key through it with a media token in the path. It streams
  (`Readable.fromWeb`, not `arrayBuffer` — a fixed OOM) but it is still every segment byte through
  Node. **If anyone ever flips this deployment to R2, that becomes the ceiling immediately.**
- **`/hls-public` (`server.ts:300-320`) is local disk, dev only** — production refuses local storage
  at `getStorageAdapter.ts:70-84`.
- **nginx does no media work.** `deploy/nginx/nginx.conf` has no `proxy_cache`, and
  `nginx/templates/app.conf.template` has exactly three `location /` proxy blocks (client, api,
  admin) — no HLS location, no cache zone. It is not in the media path at all.
- **Manifests and segments are cacheable, correctly.** `HLS_IMMUTABLE_CACHE_CONTROL =
  'public, max-age=31536000, immutable'` (`hlsVersioning.ts:9`) is applied to **every** object in a
  run tree including the master (`HLSTranscoder.ts:366-368`, `:482-484`), which is sound because the
  run tree is write-once and the mutable pointer is the DB row. It reaches storage: `uploadWithFallback`
  → `SupabaseStorageAdapter.uploadFile` → `PutObjectCommand{ CacheControl }` (`:166-175`).
- **What I cannot tell from the repo:** whether Supabase's public object endpoint is actually
  edge-cached for this project's plan, and what its cache hit ratio is. **Measurement:**
  `curl -sI '<hls_url>'` on a real segment twice and read `cf-cache-status` / `x-cache` / `age`.

Request volume, for sizing: 4 s segments × 4 tiers. A 10-minute video is **150 segments per tier**,
600 objects + 5 playlists per run tree. A 60-minute video is 900/tier, 3 605 objects.

---

# THE PLAYER — what happens on the interactions that matter

Config, `useProjectPlayer.ts:86-108`: `enableWorker: true`, `startLevel: -1`,
`capLevelToPlayerSize: true`, `startFragPrefetch: false`, `maxBufferLength: 45`,
`maxMaxBufferLength: 90`, `backBufferLength: 10`, `abrEwmaDefaultEstimate: 500_000`,
`abrEwmaFastHalf: 2`, `fragLoadingTimeOut: 20_000`, `manifestLoadingTimeOut: 10_000`,
`maxBufferHole: 0.5`, `nudgeMaxRetry: 10`. hls.js `^1.6.16`. The editor uses a *different* set
(`hooks/useSegmentedPlaybackCore.ts:30-43`: 15/30/5, `nudgeMaxRetry: 5`) despite its own comment at
`:26` saying "Must match useProjectPlayer.ts exactly" — a documented invariant that is false.
Four instances exist concurrently: active, standby, b-roll, b-roll standby (`:3470`, `:3477`,
`:2226`, `:2261`).

**Startup.** Three sequential round-trips before the first frame: master → variant → segment. With
`startFragPrefetch: false` there is no overlap of the first fragment with manifest parsing.
`abrEwmaDefaultEstimate: 500_000` × hls.js's default 0.95 factor = 475 kbps, which is below the
360p rung's declared 700 000, so **every cold start begins at 640×360** and needs 2–3 fragments
(8–12 s of media) to climb. 500 kbps is a very conservative 2026 default.

**Segment duration = 4 s** (`HLSTranscoder.ts:37`), enforced within +0.5 s by the conformance gate
(`:44`, `:310-320`), which is a genuinely good guard — it is what catches the regression the header
comment describes ("8.3s at default keyint 250"). Keyframes **are** aligned: `-g`/`-keyint_min` =
`round(fps × 4)`, `-sc_threshold 0`, `-force_key_frames expr:gte(t,n_forced*4)`, `+cgop`
(`:172`, `:180-184`), and `assertTierConformance` proves segment 0 starts on a keyframe (`:302-308`).
For this product 4 s is a defensible middle: seek granularity is 4 s worst case, and switching is
clean because GOPs are closed and aligned. It is on the long side for a seek-heavy product (D5).

**Backward seek across a section boundary — two round-trips where one would do.**
`endScrub` (`:3609`) routes a cross-section target to `loadSegment(targetIdx, localTime, …)`
at `:3652` (`loadSegment` itself at `:2530`). That calls `prewarm(idx)` (`:2566`) → `attachHlsSource` (`:2483-2495`) →
`hls.loadSource(url); hls.attachMedia(el)` — which starts hls.js at **position 0** of that section,
because nothing passes a start position. `doSwap` (`:2589`) then waits for `canplay`/`readyState>=3`
on the standby element — i.e. **waits for the fragment at t=0 to download** — and only then sets
`sv.currentTime = localTime` (`:2586`), which triggers a **second** fetch at the real target, waits
for `seeked`, and finally swaps. So every backward seek across a boundary pays: fetch segment at
t=0 → decode enough to fire `canplay` → seek → fetch segment at t=target → `seeked` → swap. One of
those two segment fetches is pure latency, and the wasted one is the first, so it is also on the
critical path. Their own e2e suite has felt this: `e2e/sim-pool.spec.ts:46-48` — *"backward seeks
can re-buffer, which briefly stalls timeupdate"*.

Within a section, `backBufferLength: 10` evicts anything more than 10 s behind, so a >10 s backward
seek re-fetches — but from the browser HTTP cache, since segments are `immutable, max-age=1y`. That
part is fine.

**Recovery.** Non-fatal errors are ignored (correct). Fatal `networkError` → `startLoad()` after 1 s
(unbounded, B5). Fatal `mediaError` → `recoverMediaError()`. Any other fatal → `recoverMediaError()`
then assigns `fallback_url` **only if it differs from the HLS URL** — and the comment at `:2466-2469`
explains why that guard exists: `fallback_url === hls_url` (`buildPlayerConfig.ts:510`), so without
the guard the "fallback" set `el.src` to an `.m3u8` Chrome/Firefox cannot play natively and turned a
recoverable stall into a permanent freeze. That guard is correct — but it also means **there is no
progressive fallback at all**; `fallback_url` is dead weight in every config this backend emits.

**Buffer memory.** Active instance at 45 s / 90 s cap. At the 1080p rung's measured ~6.6 Mbps that is
~37 MB in one SourceBuffer, plus standby (8 s), b-roll (10 s) and b-roll standby (20 s) —
four MSE buffers on one page. hls.js does handle `QuotaExceededError` by shrinking, so this is a
degradation risk on low-end mobile, not a crash. I have not measured it.

---

# What is genuinely good here (so it does not get "fixed")

- The **conformance gate** (`HLSTranscoder.ts:286-323`) runs *before* upload and *before* the master
  exists, so a non-conformant tier can never become the tree viewers see. `CODECS` in the master is
  built from **probed** bytes (`:428-429`, `:450`, `:469-475`), not from the request.
- **Versioned run trees + deferred retirement** (`hlsVersioning.ts`, `hlsRetention.ts`, migration
  053) is the right design, and the reason it exists — mid-session viewers holding old segment URLs
  — is exactly right.
- **Bounded upload fan-out** at `HLSTranscoder.ts:328-343` (12 in flight) with a settled-results
  check that fails the tier if any object failed (`:371-375`).
- The **immutable Cache-Control on the master** is unusual and correct here, because the mutable
  pointer is the DB row.

---

# DILEMMAS

## D1 — Where should the HLS ladder run?
**Problem.** `transcode` is the heaviest recurring job in the system and it runs inline in the API
container on a 2-vCPU box, with no durability and no retry (L1).

**Verified.** `PGBOSS_JOB_NAMES = ['crop','video_generate','project_export']` (`queue/pgBoss.ts:22`);
`transcode` absent → `queue/index.ts:49-53` → `inlineDriver.ts:22-29` (`setImmediate`, swallowed
rejection). `docker-compose.yml:38-39` `QUEUE_DRIVER: pgboss` + `WORKER_INLINE: 'false'`; the
`worker` container subscribes only to `PGBOSS_JOB_NAMES` (`startWorker.ts:18`). `ffmpegLimit.ts:8`
`MAX = FFMPEG_CONCURRENCY ?? 2`, shared with captions/crop/waveform/preview/export. Measured 3.3×
realtime CPU for the ladder on fast cores.

**Options.**
1. *Add `transcode` to `PGBOSS_JOB_NAMES`.* Smallest diff; moves the ladder to the worker container;
   gains durability + retries + a visible queue. **But** the worker container shares the same 2
   vCPUs, so total CPU is unchanged — this buys isolation of the *event loop* and durability, not
   throughput. It also crosses the transaction-pooler problem you already know about (pg-boss with
   `useListenNotify` off, polling default) and makes `transcode` at-least-once, which requires the
   handler to be idempotent — `runVideoTranscode` mints a fresh `runId` from `Date.now()` per
   attempt (`:55`), so a duplicate delivery produces **two** trees and the loser leaks (B4's cousin).
   Would need a `singletonKey: videoFileId` like `enqueueProjectExport` uses (`queue/index.ts:81`).
2. *Add it to `NEVER_INLINE` too*, so a queue outage returns an honest error instead of silently
   running on the web tier. Consistent with the `project_export` reasoning at `queue/index.ts:33-41`.
3. *Move transcode off the box entirely* (a second small VM, or a managed transcoder). Fixes
   throughput, not just isolation. Real money and real ops.
4. *Do nothing structural; just make the ladder cheaper* (L2 + L3 + D3 below, together plausibly
   2–3× less CPU). Cheapest, and it does not fix durability or the `processing`-forever rows.

**I lean toward (1)+(2) with a `singletonKey`, done together with (4)**, because (1) alone moves the
CPU rather than removing it, and (4) alone leaves uploads unrecoverable across a deploy. (3) is the
honest answer if concurrent uploads are ever expected to exceed ~1.

**Evidence that would decide it.** The arrival distribution: how many uploads per hour at peak, and
p95 source duration. If peak is <1 upload/hour, (4) is enough. If uploads cluster (a customer
onboarding a back catalogue), (3) is forced. Also: is there any monitoring of
`ffmpegLimiterState().queued`? If not, nobody currently knows.

## D2 — Single-invocation `split=4` vs the per-tier progress UI
**Problem.** Collapsing the four ffmpeg invocations into one saves 13 % CPU and 2.3× wall on a
multi-core host (L3) — but the sequential loop is what feeds `onTierStart`/`onTierComplete`,
`hls_current_tier`, and the 360p early-playback pointer.

**Verified.** `HLSTranscoder.ts:431-460` — the loop calls `onTierStart` (→ `hls_current_tier`,
`runVideoTranscode.ts:66-69`), then encodes, then gates, then uploads, then `onTierComplete` (→
`hls_360p_key` for tier 1, `:74-79`). Measured: 4 invocations 65.50 s CPU / 50.90 s wall; one
invocation `split=4` 57.10 s / 22.16 s, byte-equal output.

**Options.**
1. *Keep the loop, drop upscaled tiers (L2).* No UI change, removes the largest waste for
   small sources, leaves the 13 % redundant-decode cost.
2. *Two invocations: 360p alone first (for early playback), then 480p+720p+1080p in one `split=3`.*
   Keeps the "360p ready" moment, recovers most of the decode saving, and shrinks the window in
   which viewers are pinned to 360p (L4). Progress becomes 2 steps instead of 4.
3. *One invocation for everything.* Maximum saving; loses per-tier progress entirely and loses
   early playback (nothing is uploadable until the whole thing finishes) — which makes L4 worse, not
   better, for the first-view experience.
4. *One invocation, but parse ffmpeg's `-progress` output* to drive the UI. Best of both; most work,
   and the tier-by-tier conformance gate would have to become an after-the-fact pass over four
   directories instead of a barrier per tier.

**I lean toward (2)+(1)**: it preserves the one product-visible behaviour (early playback), recovers
most of the CPU, and the conformance gate still runs per directory before the master is written.

**Evidence.** `hls_current_tier` IS rendered — `client-web/components/VideoEditor.tsx:445` maps it
into per-video upload status (`{ currentTier, is360pReady }`), fed by
`controllers/v1/video.controller.ts:526`. So the per-tier progress is a real, shipped affordance and
(3) would regress it. What I could not determine is whether anyone *watches* it — i.e. whether the
upload UI's tier readout is load-bearing for users or just decoration. That, plus whether early
360p playback is actually used during transcode (RUM: play events while `hls_master_key` is null),
decides between (2) and (4).

## D3 — `preset fast`, and how many rungs the ladder should have
**Problem.** Preset and rung count are the two dials that set transcode cost, and both are currently
set for quality on a host that cannot afford it.

**Verified.** `-preset fast` at `HLSTranscoder.ts:177`. Measured 1080p tier: `fast` 23.55 s CPU,
`veryfast` 12.50 s (1.9×). Full ladder 65.50 s CPU for 20 s of source. 720p+1080p = 62 % of the
ladder's video CPU. Adjacent measured bitrate ratios 1.86× / 2.54× / 1.86× — the 480p→720p gap is
too wide for smooth switching, the other two are textbook.

**Options.**
1. *`veryfast` for 720p/1080p, keep `fast` for 360p/480p.* ~35 % off the ladder. Costs ~10–15 %
   bitrate efficiency at the same quality, i.e. you pay some of it back in egress (C1's opposite).
2. *Drop 1080p; ladder becomes 360/540/720.* ~37 % off. Closes the 2.54× gap if the middle rung is
   re-centred at ~540p/1800k. Product decision: is 1080p a promised feature?
3. *Keep four rungs but cap at source height (L2).* Free for small sources, no change for 1080p
   sources.
4. *Switch the rate control from capped-CBR to CRF with a cap* (`-crf 23 -maxrate X -bufsize X`),
   which is what the export path does (`ffmpegGraph.ts:467` `-crf 20`). Usually cheaper *and*
   smaller for easy content; makes segment sizes more variable, which interacts with B7.

**I lean toward (3)+(1)** first — both are near-free in quality terms — and treating (2) as the real
question, which is a product call about whether 1080p delivery is promised.

**Evidence.** The viewport distribution of actual viewers. `capLevelToPlayerSize: true`
(`useProjectPlayer.ts:89`) already caps the level to the player's rendered size, so if the viewer is
embedded at, say, 720 px wide, **the 1080p rung is never selected and its CPU is 100 % wasted**. I
could not determine the rendered player size from the repo. Measure: RUM the `<video>` element's
`clientWidth × devicePixelRatio` distribution, or read the level-switch histogram from hls.js. That
one number decides whether 1080p should exist at all.

## D4 — MPEG-TS or fMP4/CMAF?
**Problem.** TS costs a measured 14–20 % more bytes than fMP4 for the identical encode (C1), on both
storage and egress, forever.

**Verified.** `HLSTranscoder.ts:193-194` uses `-hls_segment_filename …%03d.ts` with no
`-hls_segment_type`. Measured 360p 1860 → 1480 KB (20.4 %), 1080p 16 404 → 14 044 KB (14.4 %).
Packet-level TS overhead 6.8 %.

**Options.**
1. *Stay on TS.* Zero risk, maximum device compatibility, keeps paying the 14–20 %.
2. *Switch to fMP4 (`-hls_segment_type fmp4`).* Requires `#EXT-X-VERSION:7`, an `init.mp4` per tier,
   and `hlsVersioning.parseVersionedHlsKey`/`hlsCacheControlForKey` still work unchanged (they are
   shape-based, not extension-based) — but `server.ts:307-308` and `:346-348` both decide
   `Content-Type` by `!key.endsWith('.m3u8') → 'video/mp2t'`, which would mislabel `.m4s`/`.mp4`, and
   `uploadDir` at `HLSTranscoder.ts:359-361` does the same. Three small call sites. Drops iOS <10,
   Android <4.4 and some smart TVs.
3. *Both, selected per request.* Doubles storage and transcode. Not worth it here.

**I lean toward (2)** — the compatibility floor it drops is a 2016-era device set, and 14–20 % of
every byte is a permanent, compounding line item. But this is a product/audience call, not mine.

**Evidence.** The user-agent distribution of actual viewers, and whether any customer distributes to
TVs or kiosks. If the audience is desktop + modern mobile browsers (which the sim-iframe,
WebGL-heavy design already implies — `browserFloor.ts` enforces a modern floor for simulations), the
compatibility argument for TS is already void.

## D5 — 4-second segments in a seek-heavy, section-interleaved product
**Problem.** 4 s is a good default for streaming efficiency and a mediocre one for a product whose
"most common interaction" is a backward seek across a section boundary.

**Verified.** `SEGMENT_SEC = 4` (`HLSTranscoder.ts:37`), enforced ≤4.5 s by the gate (`:44`,
`:310-320`), keyframes aligned to it (`:180-184`). Cold start needs 3 sequential round-trips and
begins at 360p (`abrEwmaDefaultEstimate: 500_000`). Cross-section seek costs **two** segment fetches
because `prewarm` starts at position 0 (B-adjacent; see the player section). 10-min video = 150
segments/tier.

**Options.**
1. *Keep 4 s and fix the seek path instead* — start the standby at the target position
   (`hls.startLoad(localTime)` after `MANIFEST_PARSED`, or `config.startPosition`) so a cross-section
   seek costs one fetch, not two. This is the highest-value change and is independent of segment
   duration.
2. *Drop to 2 s.* Halves worst-case seek granularity and startup latency; doubles request count
   (300/tier for 10 min), doubles playlist size, and adds ~2–4 % bitrate (more keyframes). Also
   doubles the object count the retention sweep has to delete (L5).
3. *Drop to 2 s only for the 360p rung* (the startup/seek rung), keep 4 s above. Asymmetric ladders
   are legal but the rungs must still be keyframe-aligned to switch cleanly — 2 s and 4 s GOPs *are*
   mutually aligned at 4 s boundaries, so this works.
4. *Keep 4 s, and raise `abrEwmaDefaultEstimate`* from 500 kbps to something like 3–5 Mbps so cold
   start does not begin at the bottom rung.

**I lean toward (1)+(4) and NOT changing the segment duration.** (1) removes a whole round-trip from
the interaction you named as most common; (4) removes the 8–12 s of 360p at every cold start. Both
are small, local, and independently testable. (2) trades a real cost (requests, bitrate, sweep load
on a box that is already the constraint) for a benefit (1) delivers more directly.

**Evidence.** Median section length in real projects (`SELECT percentile_cont(0.5) … FROM
timeline_sections`). If sections are shorter than ~15 s, segment duration starts to dominate and (3)
becomes attractive; if they are 30 s+, (1)+(4) is clearly enough. Also worth capturing: the
distribution of seek distances from RUM — the design assumption is "frequent backward seeks across
boundaries" and I could only find it asserted, never measured.

## D6 — Does anything verify that the retention grace period is long enough?
**Problem.** `HLS_RETIRE_GRACE_HOURS` defaults to 24 h with a 1 h floor (`hlsRetention.ts:20-34`).
The comment at `:21` reasons "no viewer session should outlive an hour of grace". But the failure it
guards is not session length — it is **player-config staleness**: a `hls_url` handed to a browser
(or cached in an SSR page, or embedded in a share link's payload) points at a specific run tree, and
nothing re-validates it. B5 says the player will then retry that 404 forever.

**Verified.** `previousHlsTreeToGc` → `retireHlsRun` → sweep after `retire_after`
(`runVideoTranscode.ts:129-136`, `hlsRetention.ts:40-89`). `buildPlayerConfig.ts:505-509` mints
`hls_url` from the current row at request time; I found no revalidation, and no client-side handling
that distinguishes "this tree is gone" from "transient network error".

**Options.**
1. *Leave it.* Re-transcodes are rare; the window is 24 h.
2. *Make the player treat a 404 on the master specifically as "reload the player config"* rather
   than as a network error to retry. Small, and it also fixes half of B5.
3. *Never delete retired trees; keep them forever.* Trades storage for correctness. Given C1's
   numbers, a run tree is not cheap.

**I lean toward (2)**, because it makes the grace period a performance knob rather than a
correctness one. **Evidence:** how often re-transcodes actually happen (`SELECT count(*) FROM
hls_retired_runs`), and whether any player config is cached/SSR'd anywhere with a TTL >1 h.
