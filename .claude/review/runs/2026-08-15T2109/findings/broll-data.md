# B-roll placement — the DATA path (write → store → player config)

Scope: how a b-roll clip's position is written to `timeline_sections` and computed into the
PlayerConfig. Player-side rendering is `broll-player`'s column; findings here are upstream of it.

## The invariant, confirmed

Two time conventions coexist in `timeline_sections`, and `exportPlan.ts:6-11` states them verbatim:

- **`main`-track section:** `start_sec`/`end_sec` are SEGMENT-LOCAL. Absolute time = the host
  video's cumulative offset + `start_sec`.
- **`broll`/`audio` section:** `global_offset_sec` is the ABSOLUTE start on the main timeline, and
  `start_sec`/`end_sec` are the SOURCE in/out points of the b-roll clip.

Every writer honours it: `video.generate.ts:142-151` (start 0, end = source duration, offset =
`target_global_offset_sec`), `broll.controller.ts:171-180`, `audio.controller.ts:230-237`,
`ProjectDuplicationService.ts:1362-1381`. `buildPlayerConfig.ts:557-578` and
`exportPlan.ts:435-458` read it the same way. **No unit mismatch exists on this path** — every
column is `real` seconds, and no ms/frame conversion appears anywhere between the writer and the
emitted `global_offset_sec`. That hypothesis is closed.

The problem is not the convention. It is that `global_offset_sec` is an **absolute coordinate on a
timeline whose origin and length are derived at read time from mutable data**, and that the
resolution of two b-rolls occupying the same instant is left undefined.

## What the brief got wrong (report these corrections)

- **Suspect 1 is half wrong.** `video.generate.ts:150` is named as "the prime candidate" for a NULL
  offset. It cannot write NULL: it assigns `job.target_global_offset_sec`, and that column is
  `real(...).notNull()` at `schema.ts:690`, sourced from a `z.number().min(0)` at
  `broll.controller.ts:22`. `broll.controller.ts:179` and `audio.controller.ts:236` are likewise
  zod-required. The **only** writer that can leave a `track='broll'` row with a NULL offset is the
  generic `POST /sections` at `sections.controller.ts:296`. See broll-data-004.
- **`queue/pgBossDriver.ts` `singletonKeyFor` returning a key for `crop` only is still true**
  (`pgBossDriver.ts:41-44`), but the brief's implied consequence has moved: `PGBOSS_JOB_NAMES` at
  `queue/pgBoss.ts:22` is now `['crop', 'video_generate', 'project_export']`, so `video_generate`
  *is* a durable queue with `retryLimit: 2` and `expireInSeconds: 45*60`, and it is the one with no
  dedup key. Re-verify any earlier finding that said `video_generate` never reaches pg-boss.
- **`transcriptPropagation.ts` does not touch b-roll placement.** It reads `is_broll` at :51 and
  :60 only to *exclude* b-roll from the transcript, and writes nothing to `timeline_sections`.
  Closed.

---

### [P1] B-roll absolute offsets are anchored to `video_files.duration_sec`, which is overwritten after the offsets are stored
- id: broll-data-001
- location: podcast-saas/backend-api/src/services/buildPlayerConfig.ts:587
- category: data-integrity
- confidence: high
- status: confirmed
- what: `videoGlobalOffsets` is rebuilt on every read as a cumulative sum of `duration_sec` over the
  main videos (`buildPlayerConfig.ts:584-588`, `globalOff += v.duration_sec ?? 0`). A b-roll's
  stored `global_offset_sec` is an absolute number the editor computed against that same sum
  (`client-web/components/VideoEditor.tsx:484-491`, identical algorithm). `duration_sec` is
  **nullable** (`schema.ts:414`) and is written at least twice per video with different values, and
  **nothing anywhere re-anchors the stored b-roll offsets when it changes.**
- why: Three reachable sequences produce a wrong number, all of them "the b-roll jumps":
  1. **Replace a main video.** `video.controller.ts:88-101` (the `replace_video_id` branch of
     `finalizeUpload`) updates `storage_key`/`file_size`/`status` and deliberately does **not**
     touch `duration_sec`; `runVideoTranscode.ts:99` then overwrites it with the ffprobe value of
     the new media. Replacing a 30 s clip with a 60 s one shifts every b-roll positioned after it
     by 30 s, silently and permanently.
  2. **First upload with no client-measured duration.** `video.controller.ts:120` stores
     `durationSec ?? null`, where `durationSec` comes from `sanitizeDurationSec(body.duration_sec)`
     (`video.controller.ts:51-53`) — a *client-supplied* value that is dropped whenever it is
     absent, non-finite, `<= 0` or `> 86400`. Until the transcode probe lands, that video
     contributes **0** to the cumulative sum. Any b-roll placed in that window is stored against a
     zero-length predecessor and lands one whole video too early once the probe fills the value in.
     The comment at `video.controller.ts:117-118` states the overwrite as intended behaviour.
  3. **Delete a main video.** `video.controller.ts:513` deletes the row. B-roll sections reference
     the *b-roll* video via `video_file_id`, so the FK cascade does not remove them — their
     absolute offsets simply now point at content that moved earlier by the deleted duration.
  Even in the benign case the browser-reported duration and the ffprobe duration differ, so every
  b-roll after the first main video is off by that delta from the moment the transcode finishes.
- evidence: Read `buildPlayerConfig.ts:582-588` and `VideoEditor.tsx:484-494` — the two cumulative
  sums are the same algorithm over the same `duration_sec`. Read `schema.ts:414`
  (`duration_sec: real('duration_sec')` — nullable, no default). Read `video.controller.ts:51-53`,
  `:88-101`, `:117-120`, `:513`. Read `runVideoTranscode.ts:96-99` (`duration_sec:
  result.durationSec > 0 ? result.durationSec : video.duration_sec`). `grep -rn "global_offset_sec"`
  over `backend-api/src` returns exactly six writer lines (`video.generate.ts:150`,
  `broll.controller.ts:179`, `audio.controller.ts:236`, `sections.controller.ts:296`,
  `ProjectDuplicationService.ts:1371`, and the PATCH spread at `sections.controller.ts:380`) — none
  of them recomputes anything, and no migration or backfill script re-anchors offsets.
  `pnpm --filter backend-api typecheck` is clean, so this is not a type-level defect.
- fix: Stop storing a coordinate whose origin is mutable. Concretely, in order of cost:
  1. **Read path, cheap and immediate:** make the basis stable by making it authoritative. In
     `runVideoTranscode.ts`, when `result.durationSec` differs from the pre-update
     `video.duration_sec` by more than a small epsilon (say 0.05 s), shift every b-roll/audio
     section of that project that starts at or after the changed video's cumulative offset by the
     delta, inside the same transaction as the `duration_sec` write. Same treatment in the
     `DELETE /videos/:videoId` handler at `video.controller.ts:513`, before the row is deleted.
  2. **Write path, the real fix:** store the anchor, not the answer — add
     `anchor_video_file_id uuid` + `anchor_offset_sec real` to `timeline_sections` so a b-roll is
     positioned *relative to a named main video*, and derive the absolute offset at read time in
     `buildPlayerConfig`/`exportPlan` from the same cumulative sum. Then a duration change moves
     the b-roll with its content instead of away from it. Expand/contract: add the columns
     nullable, backfill from the current absolute values, dual-read (anchor when present, absolute
     otherwise), then contract.
  3. Reject a `finalizeUpload` replace whose new media has a materially different duration without
     an explicit `?reflow=1`, so the destructive case is at least a decision rather than a surprise.
- backfill/repair: there is no way to recover the *intended* position of an already-displaced
  b-roll from the database alone — the original basis is gone. What is recoverable is the list of
  projects to warn about, and the anchor backfill for the fix above:
  ```sql
  -- 1. Projects whose b-roll may be displaced: a main video whose duration changed after the
  --    b-roll was created. hls_finished_at is the probe's timestamp.
  SELECT DISTINCT ts.project_id, v.id AS main_video_id, v.duration_sec, v.hls_finished_at
  FROM timeline_sections ts
  JOIN video_files v ON v.project_id = ts.project_id AND v.is_broll = false
  WHERE ts.track IN ('broll','audio')
    AND v.hls_finished_at IS NOT NULL
    AND v.hls_finished_at > ts.created_at
  ORDER BY ts.project_id;

  -- 2. B-roll that lands past the end of its own project's main timeline: displaced, and
  --    currently unreachable by the player because no playhead time ever enters its window.
  WITH tl AS (
    SELECT project_id, SUM(COALESCE(duration_sec, 0)) AS total
    FROM video_files WHERE is_broll = false GROUP BY project_id
  )
  SELECT ts.id, ts.project_id, ts.label, ts.global_offset_sec, tl.total
  FROM timeline_sections ts JOIN tl ON tl.project_id = ts.project_id
  WHERE ts.track IN ('broll','audio') AND ts.global_offset_sec >= tl.total;

  -- 3. Anchor backfill for fix (2): name the main video each b-roll currently sits inside.
  WITH offs AS (
    SELECT id, project_id,
           SUM(COALESCE(duration_sec,0)) OVER (PARTITION BY project_id ORDER BY created_at
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS off,
           COALESCE(duration_sec,0) AS dur
    FROM video_files WHERE is_broll = false
  )
  UPDATE timeline_sections ts
  SET anchor_video_file_id = o.id,
      anchor_offset_sec    = ts.global_offset_sec - COALESCE(o.off, 0)
  FROM offs o
  WHERE o.project_id = ts.project_id
    AND ts.track IN ('broll','audio')
    AND ts.global_offset_sec >= COALESCE(o.off,0)
    AND ts.global_offset_sec <  COALESCE(o.off,0) + o.dur;
  ```
- verify: new vitest in `backend-api/src/services/__tests__/` — seed a project with main videos
  A(30 s) and B(30 s) and a b-roll at `global_offset_sec = 45`; assert `buildPlayerConfig` puts it
  15 s into B; then set A's `duration_sec` to 60 and assert it is *still* 15 s into B. Red before
  the change, green after. Second test: A's `duration_sec` NULL at placement time, then set to 30 —
  the b-roll must not move relative to B.
- cross: @media-pipeline @database
- effort: L

### [P1] One section can be emitted into `broll_clips` and `clip_overlays` at two different offsets, and the player concatenates both lists
- id: broll-data-002
- location: podcast-saas/backend-api/src/services/buildPlayerConfig.ts:591
- category: bug
- confidence: high
- status: confirmed
- what: The two array filters are not disjoint. `brollClips` (`:558`) takes
  `s.track === 'broll' && !s.clip_source_audio_id`; `clipOverlays` (`:591`) takes
  `s.type === 'clip' && s.clip_source_video_id`. A row with `track='broll'` AND `type='clip'` AND
  `clip_source_video_id` set satisfies **both** and is emitted twice — once at
  `s.global_offset_sec ?? 0` (`:571`) and once at `vidOffset + s.start_sec` (`:609`) — with the
  same `id`. This is the two-formulas-one-array case the brief asked about, and it is real.
- why: `useProjectPlayer.ts:2350-2355` merges the two arrays (`[...broll_clips, ...clip_overlays]`)
  and picks with `.find()`. The same clip therefore appears at two positions in one list and the
  player shows whichever entry comes first, which is exactly "the b-roll is in the wrong place".
  Worse, the two formulas disagree by construction: for a b-roll `start_sec` is a SOURCE in-point,
  so `vidOffset + s.start_sec` is the host video's offset plus an in-point into a different video —
  a number with no meaning on either timeline. It also breaks the export's stated promise: at
  `exportPlan.ts:368` the `type==='clip'` branch runs first and `continue`s, so the export emits
  the section **once** at the clip formula while the player draws it twice — and
  `exportPlan.ts:4-5` promises "what a viewer sees is what is exported".
  Reachability: `POST /sections` (`sections.controller.ts:198-306`) accepts `track` and
  `clip_source_video_id` as independent fields with no cross-field validation, and
  `client-web/components/VideoEditor.tsx:199-224` (`sectionCreateBody`, used by both the undo/redo
  restore at `VideoEditor.tsx:595` and the duplicate-drop at `:1109`) copies `track` and
  `clip_source_video_id` together. I found no path in today's editor that *creates* the
  combination, so the row is reachable through the API and through any legacy/imported data rather
  than through a single click — which is why this is P1 rather than P0.
- evidence: Read `buildPlayerConfig.ts:557-616` — the two `.filter` predicates, verbatim, and the
  two `global_offset_sec` expressions at `:571` and `:609`. Read
  `client-web/components/viewer/useProjectPlayer.ts:2350-2355` — `const brollClips = [...(config.broll_clips ?? []), ...(config.clip_overlays ?? [])]`
  followed by `.find(...)`. Read `exportPlan.ts:368-390` and `:435-458` — mutually exclusive
  `continue`-terminated branches, clip before b-roll. Read `sections.controller.ts:232-306` — no
  cross-field guard.
- fix: Make the predicates disjoint at the read path and unrepresentable at the write path.
  1. `buildPlayerConfig.ts:591` → `.filter((s) => s.type === 'clip' && s.clip_source_video_id && s.track !== 'broll')`,
     and `:622` likewise for `imageOverlays`. Mirror `exportPlan`'s dispatch order so the two
     surfaces cannot disagree: one `if/else if` chain, one section, one window.
  2. `sections.controller.ts` POST and PATCH: reject `track === 'broll'` together with
     `clip_source_video_id`/`clip_source_image_id` with a 400, in the same zod schema asked for in
     broll-data-005.
  3. Add a `CHECK (NOT (track = 'broll' AND clip_source_video_id IS NOT NULL))` so it cannot be
     written by any future path either.
- backfill/repair:
  ```sql
  -- Rows that are currently emitted twice at two different offsets.
  SELECT id, project_id, label, track, type, global_offset_sec, start_sec, end_sec,
         video_file_id, clip_source_video_id
  FROM timeline_sections
  WHERE track = 'broll' AND type = 'clip' AND clip_source_video_id IS NOT NULL;
  -- Repair: keep the b-roll reading (it carries the explicit absolute offset) and drop the
  -- clip-source pointer, which is what makes the row ambiguous.
  UPDATE timeline_sections SET clip_source_video_id = NULL, type = 'broll'
  WHERE track = 'broll' AND type = 'clip' AND clip_source_video_id IS NOT NULL
    AND global_offset_sec IS NOT NULL;
  ```
- verify: unit test on `buildPlayerConfig` — insert one section with
  `{track:'broll', type:'clip', clip_source_video_id: <id>}` and assert the returned config
  contains its `id` exactly once across `broll_clips ∪ clip_overlays`. Red before, green after.
- cross: @broll-player @media-pipeline
- effort: M

### [P1] The section query has no deterministic order, and b-roll is ordered by a column that is not its timeline position
- id: broll-data-003
- location: podcast-saas/backend-api/src/services/buildPlayerConfig.ts:191
- category: bug
- confidence: high
- status: confirmed
- what: `db.query.timeline_sections.findMany({ ..., orderBy: [asc(timeline_sections.start_sec)] })`
  is the sole ordering for every array in the PlayerConfig. For a b-roll section `start_sec` is the
  SOURCE in-point, not a timeline position — and it is `0` for every AI-generated b-roll
  (`video.generate.ts:145`) and the schema/zod default for `insert-existing`
  (`broll.controller.ts:28`). So the entire b-roll set ties on the sort key, there is no tiebreak,
  and Postgres gives no stable order for tied rows. `broll_clips` order therefore varies between
  identical requests.
- why: The player resolves overlap by `.find()` (`useProjectPlayer.ts:2351`), so array order
  *is* the tie-break. Two overlapping b-rolls → which one plays changes request to request:
  intermittent, unreproducible, and exactly what "jumps" describes. Overlap is reachable by
  ordinary use: `TimelinePanel.tsx:1031` routes main-track moves through `findGap` (which refuses
  an overlapping drop) but the b-roll/audio/clip branch at `:1044` returns the raw drop position
  with no gap check, and `:979-982` PATCHes it straight in. Duplicate rows from broll-data-006 land
  in the same state.
  Second half of the same defect: the **editor** reads the same table with
  `orderBy: [asc(sort_order), asc(start_sec)]` (`editor-state.controller.ts:62`,
  `sections.controller.ts:188`) while the **player** omits `sort_order` entirely. Two canonical
  orders over one table means the editor can show one clip winning an overlap and the player show
  the other — "it looked right when I made it".
- evidence: Read `buildPlayerConfig.ts:189-192` (single `asc(start_sec)`, no tiebreak) against
  `editor-state.controller.ts:62` and `sections.controller.ts:186-189` (two-key order). Read
  `video.generate.ts:142-151` — `start_sec: 0` for every generated b-roll. Read
  `broll.controller.ts:28` — `start_sec: z.number().min(0).default(0)`. Read
  `client-web/components/TimelinePanel.tsx:1026-1045` and `:975-995` — `findGap` guards main only.
  `exportPlan.ts:141` has the identical single-key order, so the export inherits the same
  nondeterminism.
- fix:
  1. Add a total order to both reads: `orderBy: [asc(sort_order), asc(start_sec), asc(id)]` in
     `buildPlayerConfig.ts:191` and the same in `exportPlan.ts:141`, so the editor, the player and
     the export agree and repeated requests are byte-identical.
  2. Sort each emitted array by the position the consumer actually uses, after the offsets are
     computed: `brollClips`, `clipOverlays`, `imageOverlays` and `audioCutaways` each
     `.sort((a, b) => a.global_offset_sec - b.global_offset_sec || a.id.localeCompare(b.id))`
     before they go into the response. `exportPlan.ts:471-472` already does exactly this for its
     own timeline — this is bringing the player config up to the export's standard.
  3. Overlap resolution then becomes a stated rule ("earliest offset wins, ties by id") instead of
     an accident of row order. Pair with broll-player-002 on the player side.
- backfill/repair: none needed — this is a read-path defect, no stored data is wrong. To find the
  projects where it is currently observable:
  ```sql
  SELECT a.project_id, a.id AS section_a, b.id AS section_b,
         a.global_offset_sec AS a_start, b.global_offset_sec AS b_start
  FROM timeline_sections a
  JOIN timeline_sections b
    ON b.project_id = a.project_id AND b.id > a.id AND b.track = 'broll'
  WHERE a.track = 'broll'
    AND a.global_offset_sec IS NOT NULL AND b.global_offset_sec IS NOT NULL
    AND a.global_offset_sec < b.global_offset_sec + (b.end_sec - b.start_sec)
    AND b.global_offset_sec < a.global_offset_sec + (a.end_sec - a.start_sec);
  ```
- verify: unit test that builds a project with two b-roll sections overlapping in global time and
  both with `start_sec = 0`, calls `buildPlayerConfig` twice, and asserts the two `broll_clips`
  arrays are deeply equal *and* sorted ascending by `global_offset_sec`. Today the equality assert
  is only accidentally true; the sortedness assert is red.
- cross: @broll-player @database @media-pipeline
- effort: S

### [P2] `global_offset_sec` is nullable with no writer-side guard, and four read sites coerce NULL to "the very start of the video"
- id: broll-data-004
- location: podcast-saas/backend-api/src/controllers/v1/sections.controller.ts:296
- category: data-integrity
- confidence: high
- status: confirmed
- what: `schema.ts:652` declares `global_offset_sec: real('global_offset_sec')` — nullable, no
  default, commented "broll/audio only: absolute start on main timeline". The generic
  `POST /api/v1/projects/:id/sections` writes `global_offset_sec: global_offset_sec ?? null`
  (`sections.controller.ts:296`) while accepting `track: 'broll'` from the same body
  (`:295`, `track ?? 'main'`) with **no cross-field validation**. The PATCH at `:380` spreads the
  raw body, so an explicit `"global_offset_sec": null` on the wire nulls an existing offset even
  though the declared TS type is `number`. All four readers then translate NULL to 0:
  `buildPlayerConfig.ts:571` (b-roll), `:653` (audio cutaways), `exportPlan.ts:426` and `:446`.
- why: A NULL is a *missing* position, not position zero. Rendering it at 0 means the clip plays
  over the opening seconds of the video with no error, no log line and nothing in the response to
  distinguish it from a deliberate placement — the failure is silent in every one of the four
  places it can occur, including the export, where it burns into the master.
- evidence: Read `schema.ts:652`, `sections.controller.ts:290-306` and `:357-405`,
  `buildPlayerConfig.ts:571` and `:653`, `exportPlan.ts:420-450`.
  **Correction to the brief:** `video.generate.ts:150` is not a NULL producer — it writes
  `job.target_global_offset_sec`, which is `notNull()` at `schema.ts:690` and validated
  `z.number().min(0)` at `broll.controller.ts:22`. `broll.controller.ts:179` and
  `audio.controller.ts:236` are equally guarded. `sections.controller.ts:296` (and its PATCH twin)
  is the only hole. Today's editor always supplies a number for b-roll
  (`VideoEditor.tsx:1103-1113` + `TimelinePanel.tsx:1044`), so I could not name a click that
  produces the NULL — hence P2, not P1. The API accepts it from any caller, and the `?? 0` is what
  makes it silent rather than loud.
- fix: All three layers, because each one alone leaves a hole.
  1. **Writer.** In the POST/PATCH zod schema (broll-data-005), require
     `global_offset_sec` to be a finite `number >= 0` whenever `track !== 'main'`, and reject
     `null` for a section that already has `track` in `('broll','audio')`. 400, not a silent write.
  2. **Schema.** Backfill, then `ALTER TABLE timeline_sections ADD CONSTRAINT
     chk_broll_offset CHECK (track = 'main' OR global_offset_sec IS NOT NULL) NOT VALID`, validate
     separately (expand/contract-safe: the previous image never writes a violating row once the
     writer guard ships).
  3. **Reader.** Replace `s.global_offset_sec ?? 0` with an explicit branch at all four sites: skip
     the section and `logger.error({ sectionId, projectId }, 'b-roll section has no global offset — omitted')`.
     Omitting a clip is honest; drawing it at 0 is a wrong answer presented as a right one. In
     `exportPlan` it becomes a `warnings` entry, which is that file's existing contract for a
     deliberate omission.
- backfill/repair:
  ```sql
  -- Find them.
  SELECT id, project_id, track, type, label, start_sec, end_sec, created_at
  FROM timeline_sections
  WHERE track IN ('broll','audio') AND global_offset_sec IS NULL;
  -- Repair: an AI-generated b-roll can recover its intended position from the job that made it.
  UPDATE timeline_sections ts
  SET global_offset_sec = j.target_global_offset_sec
  FROM video_generation_jobs j
  WHERE j.section_id = ts.id
    AND ts.track = 'broll' AND ts.global_offset_sec IS NULL;
  -- Anything still NULL has no recoverable position; park it rather than guess:
  -- UPDATE timeline_sections SET track = 'main' WHERE ... -- (owner decision; do not default to 0)
  ```
- verify: controller test — `POST /projects/:id/sections` with `{track:'broll'}` and no
  `global_offset_sec` must return 400 (currently 201). Service test — a stored NULL must be absent
  from `broll_clips` and must produce one `logger.error`, not an entry at offset 0.
- cross: @database
- effort: M

### [P2] POST/PATCH /sections have no runtime schema: the ordering guard is defeated by string numbers, and PATCH mass-assigns the raw body
- id: broll-data-005
- location: podcast-saas/backend-api/src/controllers/v1/sections.controller.ts:380
- category: bug
- confidence: high
- status: confirmed
- what: Both write routes type their body with a Fastify generic and no `schema`/zod, so nothing
  validates at runtime. Two concrete consequences on the b-roll placement path:
  (a) `if (start_sec >= end_sec)` at `:259` (POST) and `:359` (PATCH) is a **string comparison**
  when the client sends numbers as strings: `"10" >= "9"` is `false`, so `{start_sec:"10",
  end_sec:"9"}` passes the guard and Postgres accepts both into `real`. The row then has a negative
  duration, and the player's window `gt >= off && gt < off + (end_sec - start_sec)`
  (`useProjectPlayer.ts:2353`) can never match — the clip silently disappears; the export builds a
  `ClipWindow` with `endSec < startSec` (`exportPlan.ts:445-447`).
  (b) `const patch: Record<string, unknown> = { ...rest }` at `:380` goes straight into
  `db.update(timeline_sections).set(patch)`. drizzle's `mapUpdateSet`
  (`node_modules/drizzle-orm/utils.cjs:110-121`) maps **every** key present in the object, so
  `project_id`, `video_file_id`, `id` and `created_at` are all client-assignable. Reassigning
  `video_file_id` on a b-roll section changes which video plays; on a clip section it changes
  `vidOffset` (`buildPlayerConfig.ts:602`) and therefore where the overlay lands.
- why: Every other write route in this area validates (`broll.controller.ts:17-30`,
  `audio.controller.ts:208-214` both use zod). These two are the ones that carry the b-roll
  position, and they are the two with no validation — which is also what makes broll-data-002 and
  broll-data-004 reachable.
- evidence: Read `sections.controller.ts:198-313` and `:315-411` — no `schema` option on either
  route, no zod, body destructured directly from `request.body`. Read
  `node_modules/.pnpm/drizzle-orm@0.31.4_*/node_modules/drizzle-orm/utils.cjs:110-121` — the
  `Object.entries(values)` map with no allowlist. `"10" >= "9" === false` is plain JS string
  comparison. `pnpm --filter backend-api typecheck` is clean, which is the point: the generic is a
  compile-time claim about data that arrives at runtime.
- fix: One zod schema per route, parsed with `safeParse` and 400 on failure, matching
  `broll.controller.ts`'s pattern exactly:
  - `start_sec`, `end_sec`, `clip_in_sec`: `z.number().finite().min(0)`; `global_offset_sec`:
    `z.number().finite().min(0)` (`.nullable()` only for `track === 'main'`, per broll-data-004);
    `broll_volume`: `z.number().min(0).max(1)`; `track`: `z.enum(['main','broll','audio'])`;
    `type`: `z.enum([...])`.
  - `.strict()` on both schemas so an unknown key is a 400, and build `patch` from the **parsed**
    object rather than from `...rest`, which closes the mass-assignment channel by construction.
  - Keep the `start_sec < end_sec` check, but after parsing, where both operands are numbers —
    ideally as a `.refine()` so it cannot be skipped.
- backfill/repair:
  ```sql
  SELECT id, project_id, track, type, label, start_sec, end_sec
  FROM timeline_sections WHERE start_sec >= end_sec;   -- inverted/zero-length: unplayable
  ```
  (see also broll-data-007, which produces zero-length rows by a different route)
- verify: controller tests — `{start_sec:"10", end_sec:"9"}` returns 400 (currently 201);
  `PATCH {"project_id":"<other uuid>"}` returns 400 and leaves the row's `project_id` unchanged
  (currently it is written).
- cross: @security @types-contracts
- effort: M

### [P2] The b-roll section insert is not idempotent, so a re-run of an in-flight generation appends a second section instead of adopting the first
- id: broll-data-006
- location: podcast-saas/backend-api/src/jobs/video.generate.ts:142
- category: data-integrity
- confidence: high
- status: confirmed
- what: Complements the confirmed job-queue-001 / job-queue-002 by establishing the **shape of the
  duplicate row** and the server-side fix. Step 6 (`:142-151`) is a bare `INSERT ... RETURNING`
  with no uniqueness, no conditional, and no re-read of the job. The guard at `:58`
  (`status === 'ready' || 'failed'`) only stops a re-run *after* the job reached a terminal state;
  a second copy that starts while the first is still at `generating`/`downloading`/`transcoding`
  sails past it. `video_generate` is a pg-boss queue (`queue/pgBoss.ts:22`) with `retryLimit: 2`
  and `expireInSeconds: 45*60` (`:34`) — and `singletonKeyFor` (`pgBossDriver.ts:41-44`) returns a
  key for `crop` only, so neither the retry nor the recovery re-enqueue at `video.generate.ts:240`
  is deduplicated.
- why: The duplicate row is: **same `project_id`, same `global_offset_sec`** (both copies read the
  immutable `job.target_global_offset_sec`), `start_sec = 0`, `end_sec` = the independently
  re-measured duration of a **different `video_file_id`** — because step 4 (`:124`,
  `svc.downloadAndStore`) runs again and mints a second video file. `video_generation_jobs.section_id`
  is then overwritten at `:155` and points at only one of them; the other is orphaned and
  unreachable from the job.
  On its own this looks like "the clip is doubled", not "it moved" — but it is the precondition for
  broll-data-003: two b-roll sections occupying identical time, resolved by an array order that has
  no tie-break. And once the user drags one copy to a new position, the orphan stays behind and the
  clip appears to jump back to where it started.
- evidence: Read `video.generate.ts:53-58` (the terminal-only guard), `:122-151` (download → insert,
  no idempotency), `:153-156` (`section_id` written after the insert, unconditionally), `:229-249`
  (recovery re-enqueues every non-terminal job with no claim). Read `queue/pgBoss.ts:22` and `:32-36`
  and `queue/pgBossDriver.ts:29-44`. `MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS` = 20 min (`:17-18`) plus
  download plus HLS transcode can exceed the 45-minute `expireInSeconds`, at which point pg-boss
  hands the job to a second worker while the first is still running.
- fix: Make the insert conditional on the job not already having a section, in one transaction:
  ```ts
  const created = await db.transaction(async (tx) => {
    const [claimed] = await tx.update(video_generation_jobs)
      .set({ status: 'ready', finished_at: new Date() })
      .where(and(eq(video_generation_jobs.id, job_id), isNull(video_generation_jobs.section_id)))
      .returning({ id: video_generation_jobs.id });
    if (!claimed) return null;                    // another copy already produced the section
    const [section] = await tx.insert(timeline_sections).values({ ... }).returning();
    await tx.update(video_generation_jobs).set({ section_id: section.id })
      .where(eq(video_generation_jobs.id, job_id));
    return section;
  });
  if (!created) {
    logger.warn({ job_id }, 'B-roll section already created by a concurrent run — skipping duplicate insert');
    const existing = await db.query.video_generation_jobs.findFirst({ where: eq(video_generation_jobs.id, job_id) });
    return { job_id, status: 'ready', section_id: existing?.section_id };
  }
  ```
  Belt and braces, and cheap: `CREATE UNIQUE INDEX uniq_vgj_section ON video_generation_jobs (section_id) WHERE section_id IS NOT NULL;`
  Then give `video_generate` a singleton key — `singletonKeyFor` should return
  `(payload as JobPayloads['video_generate']).jobId` — so the recovery re-enqueue at
  `video.generate.ts:240` collapses into an already-pending job instead of adding a second.
  (The queue-side half of this belongs to job-queue-001/002; the transaction above is the half that
  protects the data even if the queue delivers twice.)
- backfill/repair:
  ```sql
  -- Orphaned duplicates: a b-roll section at the same offset as another, in the same project,
  -- that no video_generation_job points at.
  SELECT ts.id, ts.project_id, ts.label, ts.global_offset_sec, ts.video_file_id, ts.created_at
  FROM timeline_sections ts
  WHERE ts.track = 'broll'
    AND NOT EXISTS (SELECT 1 FROM video_generation_jobs j WHERE j.section_id = ts.id)
    AND EXISTS (
      SELECT 1 FROM timeline_sections o
      WHERE o.project_id = ts.project_id AND o.id <> ts.id AND o.track = 'broll'
        AND o.global_offset_sec = ts.global_offset_sec
        AND EXISTS (SELECT 1 FROM video_generation_jobs j2 WHERE j2.section_id = o.id))
  ORDER BY ts.project_id, ts.global_offset_sec;
  -- Review, then DELETE the listed ids and their orphaned video_files.
  ```
- verify: job test — call `runVideoGenerate(jobId)` twice concurrently against a stubbed provider
  and assert `timeline_sections` gains exactly one `track='broll'` row and
  `video_generation_jobs.section_id` matches it. Red today.
- cross: @job-queue @database
- effort: M

### [P2] The cut-to-fit clamp can collapse a section to zero length, which removes a b-roll from the player without a trace
- id: broll-data-007
- location: podcast-saas/backend-api/src/services/video/runVideoTranscode.ts:117
- category: bug
- confidence: high
- status: confirmed
- what: The clamp sets both bounds: `end_sec: LEAST(end_sec, durationSec)` **and**
  `start_sec: LEAST(start_sec, durationSec)`, filtered by `end_sec > durationSec`. When a section
  lies entirely past the new duration (`start_sec >= durationSec`), both columns become
  `durationSec` and the row ends up with `start_sec === end_sec`.
- why: `start_sec < end_sec` is an invariant every writer enforces (`sections.controller.ts:259`,
  `:359`, `broll.controller.ts:167`) and this is the one write that breaks it. For a b-roll,
  `end_sec - start_sec` is the clip's on-timeline duration, so the player's window
  `gt >= off && gt < off + 0` (`useProjectPlayer.ts:2352-2354`) is empty and the clip never plays —
  it is still in the editor, still in the config, and simply never appears. Reached by replacing a
  main video with a shorter one, which is also scenario (1) of broll-data-001, so a single replace
  can both displace some b-roll and silently disable other b-roll.
- evidence: Read `runVideoTranscode.ts:108-123`. Read `sections.controller.ts:259` and
  `broll.controller.ts:167-169` for the invariant the rest of the codebase enforces. Read
  `useProjectPlayer.ts:2351-2355` for the empty-window consequence.
- fix: Delete the section instead of collapsing it, or leave it and report it — never write a
  zero-length row. Narrow the clamp to rows that still have room, and handle the rest explicitly:
  ```ts
  await db.update(timeline_sections)
    .set({ end_sec: sql`LEAST(${timeline_sections.end_sec}, ${result.durationSec})` })
    .where(and(eq(timeline_sections.video_file_id, video_file_id),
               gt(timeline_sections.end_sec, result.durationSec),
               lt(timeline_sections.start_sec, sql`${result.durationSec} - 0.05`)));
  const orphaned = await db.select({ id: timeline_sections.id }).from(timeline_sections)
    .where(and(eq(timeline_sections.video_file_id, video_file_id),
               gte(timeline_sections.start_sec, sql`${result.durationSec} - 0.05`)));
  if (orphaned.length) logger.warn({ video_file_id, sectionIds: orphaned.map(o => o.id) },
    'timeline sections fall entirely past the new source duration — left intact, not clamped');
  ```
- backfill/repair:
  ```sql
  SELECT id, project_id, track, type, label, start_sec, end_sec, global_offset_sec
  FROM timeline_sections WHERE end_sec <= start_sec;
  ```
  These are unplayable by construction; review with the owner and delete or restore from the
  source video's current duration.
- verify: unit test on the clamp — a section at `start_sec=40, end_sec=50` against a new
  `durationSec=30` must not end up with `start_sec === end_sec`. Red today.
- cross: @media-pipeline
- effort: S

### [P2] Nothing prevents or defines overlapping b-roll, so its resolution is an implementation detail of whichever consumer reads it
- id: broll-data-008
- location: podcast-saas/backend-api/src/db/schema.ts:634
- category: data-integrity
- confidence: high
- status: confirmed
- what: `timeline_sections` has no uniqueness, no exclusion constraint, and no application-level
  overlap check for `(project_id, track='broll', [global_offset_sec, global_offset_sec + (end_sec -
  start_sec)))`. The table declaration at `:634-666` has no third-argument constraint block at all,
  unlike `sim_posters` (`:601-605`), which does. The application enforces non-overlap for
  main-track sections only, and only in the browser (`TimelinePanel.tsx:139` `findGap`, applied at
  `:1031` behind `isMainSection`).
- why: Overlap is therefore representable, and each consumer resolves it differently and by
  accident: the player takes the first `.find()` hit over an unordered array
  (`useProjectPlayer.ts:2351`), the export sorts by `startSec` and lets ffmpeg layer them
  (`exportPlan.ts:471`), and the editor picks by a third order
  (`editor-state.controller.ts:62`, `sort_order` first). "Which b-roll is playing right now" has
  three answers. If overlapping b-roll is *not* a product feature, this is the constraint whose
  absence lets broll-data-006's duplicates and broll-data-003's nondeterminism become visible.
- evidence: Read `schema.ts:634-666` (no constraint block). Compared against `schema.ts:601-605`,
  which shows this file does declare `unique()`/`index()` where they are wanted. Read
  `TimelinePanel.tsx:126-145` and `:1026-1045` — `findGap` is gated on `isMainSection`. Read the
  three consumer orderings cited above.
- fix: First get a ruling: is stacked b-roll a feature (picture-in-picture) or an accident? If an
  accident:
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE timeline_sections ADD CONSTRAINT excl_broll_overlap
    EXCLUDE USING gist (
      project_id WITH =,
      numrange(global_offset_sec::numeric,
               (global_offset_sec + (end_sec - start_sec))::numeric, '[)') WITH &&
    ) WHERE (track = 'broll' AND global_offset_sec IS NOT NULL);
  ```
  (deploy after the broll-data-006 repair, or it will fail to validate on existing duplicates), plus
  the same `findGap` treatment for the b-roll branch of `computeDuplicatePlacement` and the drag
  handler so the editor refuses the drop rather than the database rejecting it.
  If it *is* a feature: state the layering rule (e.g. highest `sort_order` wins, ties by `id`), and
  implement that one rule in `buildPlayerConfig`, `exportPlan` and the editor — which is
  broll-data-003's fix with a different comparator.
- backfill/repair: the overlap-detection query in broll-data-003 lists every pair that would
  violate the constraint; it must return zero rows before the `ALTER TABLE` can validate.
- verify: migration applies cleanly against a copy of production after the repair; a controller
  test asserting that a second b-roll overlapping the first returns 409 rather than 201.
- cross: @database @broll-player
- effort: M

### [P3] Clip and image overlay offsets ignore branch `sequence_order`, so they are computed against an ordering the player never uses
- id: broll-data-009
- location: podcast-saas/backend-api/src/services/buildPlayerConfig.ts:585
- category: bug
- confidence: medium
- status: confirmed
- what: `videoGlobalOffsets` is built by iterating `mainVideos` in `created_at ASC` order
  (`:184-188`, `:585-588`). In a branched project the player's segments are grouped per sequence
  and sorted by `sequence_order` then `created_at` (`:730-745`, `orderInSequence`), and each
  sequence's timeline starts at zero. `clip_overlays` and `image_overlays` are nonetheless
  positioned at `vidOffset + s.start_sec` (`:609`, `:630`) using the flat cross-project cumulative
  sum, which corresponds to no timeline that exists in a branched project.
- why: Inert in the viewer today — `useProjectPlayer.ts:2349` and `:2393` both return early with
  `if (branching) return;`, so flat overlays are not drawn in branching mode. It stays a live
  correctness hazard because the numbers are emitted anyway (any other consumer of the config gets
  wrong values) and because `exportPlan.ts` computes `videoGlobalOffsets` the same way.
- evidence: Read `buildPlayerConfig.ts:184-188`, `:582-588`, `:602`, `:626`, `:730-745`; read
  `useProjectPlayer.ts:2349` and `:2393` for the early return that makes it currently harmless.
- fix: Either compute `videoGlobalOffsets` per sequence when `sequenceRows.length > 0` (using
  `orderInSequence`, so the offset is sequence-local and matches the segments the player builds),
  or emit `clip_overlays`/`image_overlays` as empty in branching mode and say so in a `warnings`
  field, so the config never carries a number that means nothing.
- backfill/repair: none — read-path only.
- verify: unit test on a branched project asserting `clip_overlays` offsets are sequence-local (or
  that the array is empty), rather than cross-sequence cumulative.
- effort: S

### [P3] The API returns main videos newest-first while the canonical timeline order is oldest-first
- id: broll-data-010
- location: podcast-saas/backend-api/src/controllers/v1/editor-state.controller.ts:61
- category: bug
- confidence: high
- status: confirmed
- what: `GET /editor-state` (`:61`) and `GET /videos` (`video.controller.ts:466`) both order
  `video_files` by `desc(created_at)`. The main timeline's canonical order is `asc(created_at)` —
  that is what `buildPlayerConfig.ts:187` uses to build segments, what `:585-588` uses to compute
  the offsets a b-roll's absolute position is measured against, and what `exportPlan.ts:6` names as
  the rule.
- why: Every consumer of the list endpoints must re-sort to recover the timeline. Today's editor
  does (`VideoEditor.tsx:484-486` sorts ascending by `created_at` before building its own cumulative
  offsets), so this is latent rather than live — but it is a trap: a consumer that trusts the
  response order builds a **reversed** timeline, and any b-roll offset computed against it is wrong
  by the length of every other main video. Given b-roll offsets are absolute and permanent
  (broll-data-001), one such consumer would corrupt data rather than merely display it oddly.
- evidence: Read `editor-state.controller.ts:61`, `video.controller.ts:463-467`,
  `buildPlayerConfig.ts:185-188` and `:582-588`, `VideoEditor.tsx:484-486`, `exportPlan.ts:6`.
- fix: Return main videos in `asc(created_at)` from both list endpoints — the order the timeline
  actually has — and let the UI reverse for display if it wants newest-first. If the DESC order is
  deliberate for a picker, split it: keep the timeline order on `editor-state` (which is the
  timeline bootstrap) and leave DESC on the library listing, with a comment naming which is which.
- backfill/repair: none — read-path only.
- verify: controller test asserting `GET /editor-state` returns main videos in ascending
  `created_at`, matching the order `buildPlayerConfig` assumes.
- cross: @types-contracts
- effort: S

---

## Ranked by how well each explains "b-rolls jump in the wrong place"

1. **broll-data-001** — the only cause that moves a b-roll to a *specific wrong time* on its own,
   deterministically, with no second actor. Replace or re-probe a main video and every b-roll after
   it shifts by the duration delta. Complete explanation end to end.
2. **broll-data-002** — the same clip drawn at two positions in one array. Complete explanation, but
   needs a row shape I could not produce from today's editor UI.
3. **broll-data-003** — explains the *intermittent, unreproducible* character of the complaint, and
   explains "it looked right in the editor". Needs an overlap to exist, which broll-data-006 and
   ordinary b-roll dragging both supply.
4. **broll-data-006** — supplies the overlap that (3) then resolves at random, and produces the
   "it jumped back to where it was" variant after the user moves one copy.
5. **broll-data-004** — would put a clip at 0:00 exactly. Only reachable via the API today, so it
   explains the symptom only for a caller outside the editor or for legacy data.
