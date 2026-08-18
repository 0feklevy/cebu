# B-roll data census — what the rows actually look like, from CODE and SCHEMA

Wave 3, read-only phase. Branch `fix/night-audit-2026-08-15`.
**No database was connected to.** Every claim below is derived from the schema DDL, the Drizzle
table definitions, and the read/write sites in the source tree. Every SQL statement here is a
`SELECT`; nothing in this file mutates, and nothing here should be run against production without
the read-only wrapper in §0.

---

## 0. How to run this safely

The queries are written for the real (Postgres) schema, standalone — each repeats the CTEs it
needs so it can be pasted alone. Run them inside a read-only transaction:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
-- <paste one census query>
ROLLBACK;
```

Two shared derivations recur, both reconstructions of things the *application* computes in memory
and the database does not store:

```sql
-- MAIN OFFSETS — the anchor buildPlayerConfig.ts:585-588 and exportPlan.ts:272-277 compute:
--   a running sum of video_files.duration_sec over the NON-broll videos, created_at ASC.
-- NOTE: the code orders by created_at ONLY (buildPlayerConfig.ts:187). Ties are resolved
-- arbitrarily by Postgres there; the `, vf.id` tiebreak below makes THIS query deterministic,
-- so wherever two main videos of a project share created_at, this CTE is one plausible ordering
-- and the app may be using another. Count such projects first:
--   SELECT project_id, created_at, count(*) FROM video_files WHERE NOT is_broll
--   GROUP BY 1,2 HAVING count(*) > 1;
WITH main_offsets AS (
  SELECT vf.id, vf.project_id, vf.duration_sec,
         COALESCE(SUM(COALESCE(vf.duration_sec, 0)) OVER (
           PARTITION BY vf.project_id ORDER BY vf.created_at, vf.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS global_offset_sec
  FROM video_files vf
  WHERE vf.is_broll = false
),
main_total AS (
  SELECT project_id, SUM(COALESCE(duration_sec, 0)) AS total_sec
  FROM video_files WHERE is_broll = false GROUP BY project_id
)
```

Reminder from the verified ground truth: `video_files.duration_sec` is client-seeded at upload
(`video.controller.ts:120`, from `sanitizeDurationSec(body.duration_sec)`) and then **overwritten**
with the real ffprobe value at transcode (`runVideoTranscode.ts:99`). `main_offsets` therefore
reproduces today's anchor, not the anchor that was in effect when any given row was authored. That
is the D-01 root cause and is out of scope here; the census measures the current state, it does not
re-anchor anything.

---

## 1. The three row shapes, as exact column predicates

All three live in one table, `timeline_sections`, and are told apart only by column combinations —
there is no discriminator column and no constraint (see §2).

### Shape 1 — True b-roll (the V2 overlay lane)

```sql
track = 'broll'
AND clip_source_audio_id IS NULL     -- otherwise it is an audio cutaway, not a visual b-roll
AND clip_source_video_id IS NULL     -- otherwise it is Shape 3
-- type is normally 'broll'; see the type caveat below
```

* **Source:** `video_file_id` → `video_files`, expected `is_broll = true`.
* **Position:** `global_offset_sec` is the ABSOLUTE start on the main timeline.
  `start_sec` / `end_sec` are SOURCE in/out points inside the b-roll clip, *not* timeline
  coordinates. Displayed length is `end_sec - start_sec`.
* **Written by:** `video.generate.ts:142-150` (AI generation, `type:'broll'`),
  `broll.controller.ts:171-181` (Use Existing, `type:'broll'`), `sections.controller.ts:277-306`
  (generic POST, any `track`), `ProjectDuplicationService.ts:1363-1381` (verbatim copy).
* **Read by:** `buildPlayerConfig.ts:557-578` → `broll_clips[]`; `exportPlan.ts:516-539` →
  `ClipWindow{sourceRole:'broll'}`; editor `VideoEditor.tsx:474-475`, `TimelinePanel.tsx:123`.

**Type caveat — `type` is NOT reliable on this track.** `SectionEditor.tsx:168-173` forces the
editor's type state to `'video'` for any `track='broll'` row, and `handleSave` posts that state
back (`SectionEditor.tsx:1175-1197`). So opening a generated b-roll section and pressing Save
rewrites `type` from `'broll'` to `'video'`. Both values are in the wild. **Nothing downstream
reads `type` for the b-roll lane** — `buildPlayerConfig.ts:558` and `exportPlan.ts:516` both branch
on `track` alone — which is precisely why the mismatch went unnoticed, and precisely why Shape 3
(where `type` DOES matter, at `buildPlayerConfig.ts:591`) is a live defect. Census queries below
therefore key on `track` and `clip_source_*`, never on `type` alone.

### Shape 2 — Main "Existing Visual" overlay (the clip section)

```sql
track = 'main'
AND type  = 'clip'
AND clip_source_video_id IS NOT NULL
```

* **Source:** `clip_source_video_id` → `video_files` (a normal uploaded library video,
  `is_broll` typically false). `video_file_id` is the HOST main segment, not the source.
* **Position:** HOST-LOCAL. `start_sec` / `end_sec` are seconds within the host video; the absolute
  position is DERIVED as `main_offsets(video_file_id) + start_sec`
  (`buildPlayerConfig.ts:602,609`; `exportPlan.ts:450,461-462`).
  `clip_in_sec` is the in-point inside the SOURCE video; source out is
  `clip_in_sec + (end_sec - start_sec)` (`buildPlayerConfig.ts:604,610-611`).
  `global_offset_sec` is unused and legitimately NULL for this shape.
* **Written by:** `sections.controller.ts:277-306` / `:380-405` (the editor's create + save),
  `TimelinePanel.tsx:1250-1256` (Add → "Existing clip"), `SectionEditor.tsx:1190-1195`.
* **Read by:** `buildPlayerConfig.ts:590-616` → `clip_overlays[]`; `exportPlan.ts:448-471` →
  `ClipWindow{sourceRole:'clip'}`; editor `VideoEditor.tsx:518-534`.

The sibling `type='clip' AND clip_source_image_id IS NOT NULL` is the still-image variant
(`buildPlayerConfig.ts:621-640`), same positioning rules.

### Shape 3 — The malformed hybrid (double-emission)

```sql
track = 'broll'
AND type  = 'clip'
AND clip_source_video_id IS NOT NULL
```

This row satisfies **both** read filters, which are not disjoint:

| Site | Filter | Offset it emits |
|---|---|---|
| `buildPlayerConfig.ts:557-558` | `track='broll' && !clip_source_audio_id` | STORED `global_offset_sec ?? 0` (`:571`) |
| `buildPlayerConfig.ts:590-591` | `type==='clip' && clip_source_video_id` | COMPUTED `main_offsets(video_file_id) + start_sec` (`:602,609`) |

Both arrays are returned in the same payload (`buildPlayerConfig.ts:857-858`), and the viewer
concatenates them into ONE array and `.find()`s over it
(`useProjectPlayer.ts:2351-2355`: `[...broll_clips, ...clip_overlays].find(...)`). So one row plays
**twice, at two different times**, and the b-roll copy wins any overlap because it is first in the
concatenation. It also plays with two different source semantics: the b-roll copy sources
`video_file_id` and treats `start_sec/end_sec` as source in/out; the clip copy sources
`clip_source_video_id` and treats them as host-local.

**Not symmetric downstream:**
* The **export** emits it ONCE. `exportPlan.ts` is an if/`continue` chain and the clip branch
  (`:448`) is tested before the b-roll branch (`:516`), so a hybrid is exported as a
  `sourceRole:'clip'` window at the computed offset and never as b-roll.
* The **editor preview** shows it ONCE, as B-ROLL: `VideoEditor.tsx:536`
  `activeBrollSection ?? clipSectionAsOverlay` — the b-roll interpretation wins.

So all three surfaces disagree about a single hybrid row: viewer plays it twice, export renders the
clip reading, editor previews the b-roll reading.

**Residue variant** — after any Save from `SectionEditor` a hybrid becomes
`track='broll' AND type='video' AND clip_source_video_id IS NOT NULL` (the type is rewritten per
the caveat above; the clip fields are NOT cleared because `handleSave` only sends them when
`type==='clip'`, `SectionEditor.tsx:1190`). That row stops double-emitting (`:591` needs
`type='clip'`) but keeps a dangling source pointer that will start double-emitting again the moment
anything sets `type` back to `'clip'`. Query C2b counts it.

### Adjacent shapes the census must not confuse with the above

| Shape | Predicate | Read as |
|---|---|---|
| Audio cutaway | `clip_source_audio_id IS NOT NULL` (any track) | `audio_cutaways[]`, `buildPlayerConfig.ts:645-646`; excluded from b-roll at `:558` |
| Legacy b-roll-track audio | `track='broll' AND clip_source_audio_id IS NOT NULL` | audio only — NOT a visual b-roll |
| Image overlay | `type='clip' AND clip_source_image_id IS NOT NULL` | `image_overlays[]`, `:621-622` |
| Main simulation | `track='main' AND type='simulation'` | per-segment `simulations[]`; `exportPlan.ts:372` |

---

## 2. What the code guarantees, and what it does not

### The database guarantees essentially nothing

From `004_video_editor.sql`, `010_broll_generation.sql`, `014_clip_source.sql`,
`017_broll_audio.sql`, `018_image_clips.sql`, `020_audio_files.sql` — the complete set of
migrations that touch `timeline_sections`:

* **No CHECK constraint anywhere on the table.** `track` is a bare `TEXT NOT NULL DEFAULT 'main'`
  (010:5) — `'main' | 'broll' | 'audio'` is a comment (010:8-9), not a constraint. `type` is a bare
  `TEXT NOT NULL` (004) with no enum at all.
* **`global_offset_sec REAL` is nullable with no rule** (010:6). Nothing requires a `track='broll'`
  row to carry a position, and nothing forbids a negative one.
* **No uniqueness of any kind.** No natural key, no partial unique index — so nothing stops two
  identical b-roll rows at the same offset (see C8).
* **FKs do not enforce same-project.** `video_file_id → video_files(id) ON DELETE CASCADE` and
  `clip_source_video_id/image_id/audio_id → … ON DELETE SET NULL` all check *existence only*; a row
  may point at another project's asset without violating any constraint. (The duplication service
  knows this and re-checks it by hand, `ProjectDuplicationService.ts:1577-1593` — evidence that the
  DB does not.)
* **`ON DELETE SET NULL` silently creates orphans.** Deleting a source video turns a live
  `type='clip'` row into `type='clip', clip_source_video_id=NULL`, which matches NO branch in
  `buildPlayerConfig` (`:591` requires non-null) and NO branch in `exportPlan` (`:448` requires
  non-null, and a `track='main'` row never reaches `:516`) — it vanishes from both with **no
  warning at all**. Query C7c.
* Indexes exist for reads only: `idx_sections_track(project_id, track)` (010:11),
  `idx_timeline_sections_project`, `idx_timeline_sections_video` (004).

### The API layer guarantees very little

| Write path | Runtime validation | Can produce |
|---|---|---|
| `POST /projects/:id/sections` (`sections.controller.ts:277-306`) | **NONE** — hand-rolled presence check only (`:256-261`): `video_file_id, start_sec, end_sec, type` required, `start_sec < end_sec`. No zod. `track` accepted verbatim (`:295`), `global_offset_sec ?? null` (`:296`), `clip_source_video_id ?? null` (`:297`) — no rule tying them together | every shape incl. **Shape 3**, NULL offsets, negative offsets |
| `PATCH /projects/:id/sections/:sid` (`:380-405`) | **NONE**. `track` rides in `...rest` (`:357,380`); `clip_source_video_id` applied separately (`:394`) — the two can be set independently, in either order | **Shape 3** from either direction |
| `POST /broll/insert-existing` (`broll.controller.ts:146-183`) | zod `InsertExistingSchema` (`:25-30`): `global_offset_sec: z.number().min(0)` **required** | Shape 1 only — and it CANNOT produce a NULL or negative offset |
| `POST /broll/generate` → `video.generate.ts:142-150` | zod `GenerateBodySchema` (`:17-23`), `target_global_offset_sec: z.number().min(0)`; column is `NOT NULL` | Shape 1 only, offset always ≥ 0 |
| `POST /audio/cutaway` (`audio.controller.ts:206-243`) | zod, `global_offset_sec: z.number().min(0)` | audio cutaway only |
| Project duplication (`ProjectDuplicationService.ts:1363-1381`) | copies `track`, `type`, `global_offset_sec`, `clip_source_*` **verbatim** | propagates whatever malformation the source had |

**Consequence for the census:** a NULL or negative `global_offset_sec` on a b-roll row can only
have come from the generic sections API (or a duplicate of one), never from the b-roll panel. That
narrows the blast radius and it is why C1 is worth counting separately from C2.

### The read layer's silent failures

Four sites coerce a missing position to second zero — `buildPlayerConfig.ts:571`,
`buildPlayerConfig.ts:653`, `exportPlan.ts:506`, `exportPlan.ts:526-527`. A b-roll row with a NULL
offset therefore does not error and does not warn: it silently plays over the first frames of the
video.

Two sites drop a b-roll row **silently, with no warning and no log**:
`buildPlayerConfig.ts:560-561` (source not in the `is_broll` map → `return null`) and `:562-567`
(no `hls_master_key` and no `hls_360p_key` → `return null`), both swallowed by `.filter(Boolean)` at
`:578`. The export's equivalent path at least says so (`exportPlan.ts:519`, `:537`). There is **no
test anywhere that asserts on `broll_clips`** — `grep -rl broll_clips` over `backend-api/src`
returns only `buildPlayerConfig.ts` itself.

### Ordering: two surfaces, two orders

`buildPlayerConfig.ts:191` and `exportPlan.ts:218-220` both order sections by `asc(start_sec)`
alone. For b-roll, `start_sec` is a source in-point — almost always 0 — so every b-roll row of a
project ties and Postgres may return them in any order, run to run. The editor asks for
`(sort_order, start_sec)` (`sections.controller.ts:188`). Order matters wherever a `.find()` takes
the first match: `useProjectPlayer.ts:2352` (which overlapping clip plays) and the concatenation
order in `:2351`. This is why the duplicate/overlap symptoms are intermittent.

---

## 3. The census queries

Every query returns one row per offending section (or per pair), keyed by `project_id` and
`section_id` so results can be joined back together. Counts-only rollup is C0.

### C0 — Rollup: one row per project, all classes at once

```sql
SELECT
  ts.project_id,
  count(*) FILTER (WHERE ts.track = 'broll' AND ts.clip_source_audio_id IS NULL)                          AS broll_rows,
  count(*) FILTER (WHERE ts.track = 'broll' AND ts.clip_source_audio_id IS NULL
                     AND ts.global_offset_sec IS NULL)                                                    AS c1_null_offset,
  count(*) FILTER (WHERE ts.track = 'broll' AND ts.clip_source_audio_id IS NULL
                     AND ts.global_offset_sec < 0)                                                        AS c1_negative_offset,
  count(*) FILTER (WHERE ts.track = 'broll' AND ts.type = 'clip'
                     AND ts.clip_source_video_id IS NOT NULL)                                             AS c2_hybrid,
  count(*) FILTER (WHERE ts.track = 'broll' AND ts.type <> 'clip'
                     AND ts.clip_source_video_id IS NOT NULL)                                             AS c2b_residue,
  count(*) FILTER (WHERE ts.track = 'broll' AND ts.clip_source_audio_id IS NULL
                     AND vf.id IS NOT NULL AND vf.is_broll = false)                                       AS c5_non_broll_source,
  count(*) FILTER (WHERE ts.track = 'broll' AND ts.clip_source_audio_id IS NULL
                     AND vf.id IS NOT NULL
                     AND vf.hls_master_key IS NULL AND vf.hls_360p_key IS NULL)                            AS c5b_no_hls,
  count(*) FILTER (WHERE ts.end_sec <= ts.start_sec)                                                      AS zero_or_negative_length,
  count(*) FILTER (WHERE ts.type = 'clip' AND ts.clip_source_video_id IS NULL
                     AND ts.clip_source_image_id IS NULL)                                                 AS c7c_orphan_clip
FROM timeline_sections ts
LEFT JOIN video_files vf ON vf.id = ts.video_file_id
GROUP BY ts.project_id
HAVING count(*) FILTER (WHERE ts.track = 'broll') > 0
    OR count(*) FILTER (WHERE ts.type = 'clip')  > 0
ORDER BY c2_hybrid DESC, c1_null_offset DESC, c5_non_broll_source DESC;
```

### C1 — NULL or negative offsets on rows that are POSITIONED by offset

A row that carries its own absolute position: b-roll and audio. Main-track rows are positioned by
`start_sec` within their host video and legitimately have no global offset — they are **excluded**
here by design (this is the REFUTED audit claim; `TimelinePanel.tsx:1041` returning null for the
main branch is correct).

```sql
SELECT ts.project_id, ts.id AS section_id, ts.track, ts.type, ts.label,
       ts.global_offset_sec, ts.start_sec, ts.end_sec,
       CASE WHEN ts.global_offset_sec IS NULL THEN 'null_offset_read_as_zero'
            ELSE 'negative_offset' END AS finding,
       -- what the four coercion sites will actually play it at
       GREATEST(COALESCE(ts.global_offset_sec, 0), 0) AS effective_start_sec
FROM timeline_sections ts
WHERE (ts.track IN ('broll','audio') OR ts.clip_source_audio_id IS NOT NULL)
  AND (ts.global_offset_sec IS NULL OR ts.global_offset_sec < 0)
ORDER BY ts.project_id, ts.id;
```

Read sites that coerce: `buildPlayerConfig.ts:571`, `:653`, `exportPlan.ts:506`, `:526-527`.
A NULL here means the clip plays from second 0 of the video in both the viewer and the export.

### C2 — The malformed hybrid (double-emission)

```sql
WITH main_offsets AS (
  SELECT vf.id, vf.project_id,
         COALESCE(SUM(COALESCE(vf.duration_sec,0)) OVER (
           PARTITION BY vf.project_id ORDER BY vf.created_at, vf.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS global_offset_sec
  FROM video_files vf WHERE vf.is_broll = false
)
SELECT ts.project_id, ts.id AS section_id, ts.label,
       ts.track, ts.type,
       ts.video_file_id, ts.clip_source_video_id,
       ts.start_sec, ts.end_sec, ts.clip_in_sec,
       -- copy A: buildPlayerConfig.ts:557-571 (broll reading, STORED offset)
       COALESCE(ts.global_offset_sec, 0)                       AS emitted_at_as_broll,
       -- copy B: buildPlayerConfig.ts:590-609 (clip reading, COMPUTED offset)
       COALESCE(mo.global_offset_sec, 0) + ts.start_sec        AS emitted_at_as_clip,
       abs(COALESCE(ts.global_offset_sec,0)
           - (COALESCE(mo.global_offset_sec,0) + ts.start_sec)) AS ghost_gap_sec
FROM timeline_sections ts
LEFT JOIN main_offsets mo ON mo.id = ts.video_file_id
WHERE ts.track = 'broll'
  AND ts.type  = 'clip'
  AND ts.clip_source_video_id IS NOT NULL
ORDER BY ghost_gap_sec DESC NULLS LAST;
```

`ghost_gap_sec` is how far apart in the finished timeline the two ghosts of one row appear. A gap
near 0 means the duplicate is invisible-but-wasteful; a large gap is the user-visible "the clip
plays twice" report.

### C2b — Residue: b-roll row still carrying a clip source pointer

```sql
SELECT ts.project_id, ts.id AS section_id, ts.label, ts.type,
       ts.video_file_id, ts.clip_source_video_id, ts.clip_in_sec,
       'dormant_hybrid_reactivates_if_type_set_to_clip' AS finding
FROM timeline_sections ts
WHERE ts.track = 'broll'
  AND ts.type <> 'clip'
  AND ts.clip_source_video_id IS NOT NULL
ORDER BY ts.project_id, ts.id;
```

### C3 — Cross-project sources

The FKs check existence, not tenancy. This mirrors the by-hand integrity checks the duplication
service runs (`ProjectDuplicationService.ts:1577-1593`), applied to the whole table.

```sql
SELECT ts.project_id, ts.id AS section_id, ts.track, ts.type, ts.label,
       'video_file_id' AS column_name, ts.video_file_id AS ref_id, vf.project_id AS ref_project_id
FROM timeline_sections ts JOIN video_files vf ON vf.id = ts.video_file_id
WHERE vf.project_id IS DISTINCT FROM ts.project_id
UNION ALL
SELECT ts.project_id, ts.id, ts.track, ts.type, ts.label,
       'clip_source_video_id', ts.clip_source_video_id, vf.project_id
FROM timeline_sections ts JOIN video_files vf ON vf.id = ts.clip_source_video_id
WHERE vf.project_id IS DISTINCT FROM ts.project_id
UNION ALL
SELECT ts.project_id, ts.id, ts.track, ts.type, ts.label,
       'clip_source_image_id', ts.clip_source_image_id, imf.project_id
FROM timeline_sections ts JOIN image_files imf ON imf.id = ts.clip_source_image_id
WHERE imf.project_id IS DISTINCT FROM ts.project_id
UNION ALL
SELECT ts.project_id, ts.id, ts.track, ts.type, ts.label,
       'clip_source_audio_id', ts.clip_source_audio_id, af.project_id
FROM timeline_sections ts JOIN audio_files af ON af.id = ts.clip_source_audio_id
WHERE af.project_id IS DISTINCT FROM ts.project_id
UNION ALL
SELECT ts.project_id, ts.id, ts.track, ts.type, ts.label,
       'simulation_id', ts.simulation_id, sim.project_id
FROM timeline_sections ts JOIN simulations sim ON sim.id = ts.simulation_id
WHERE sim.project_id IS DISTINCT FROM ts.project_id
ORDER BY 1, 2;
```

A cross-project `video_file_id` on a b-roll row is also a **leak**: `buildPlayerConfig` resolves the
source through `brollVideoMap`, built only from THIS project's videos (`:225,:556`), so it drops —
but `exportPlan.ts:268` builds `videoById` from this project's videos too, so it warns and skips
(`:519`). The row is inert today; it becomes a cross-tenant read the moment either map is widened.

### C4 — Overlapping b-roll

Overlap is not an error the code detects; the viewer's `.find()` (`useProjectPlayer.ts:2352`)
takes the FIRST match in array order, and array order comes from an `ORDER BY start_sec` that ties
for every b-roll row (§2). Two overlapping b-roll clips therefore render non-deterministically.

```sql
SELECT a.project_id,
       a.id AS section_a, b.id AS section_b,
       a.label AS label_a, b.label AS label_b,
       COALESCE(a.global_offset_sec,0) AS a_start,
       COALESCE(a.global_offset_sec,0) + (a.end_sec - a.start_sec) AS a_end,
       COALESCE(b.global_offset_sec,0) AS b_start,
       COALESCE(b.global_offset_sec,0) + (b.end_sec - b.start_sec) AS b_end,
       LEAST(COALESCE(a.global_offset_sec,0) + (a.end_sec - a.start_sec),
             COALESCE(b.global_offset_sec,0) + (b.end_sec - b.start_sec))
         - GREATEST(COALESCE(a.global_offset_sec,0), COALESCE(b.global_offset_sec,0)) AS overlap_sec
FROM timeline_sections a
JOIN timeline_sections b
  ON b.project_id = a.project_id
 AND b.id > a.id                                     -- each unordered pair once
 AND b.track = 'broll' AND b.clip_source_audio_id IS NULL
WHERE a.track = 'broll' AND a.clip_source_audio_id IS NULL
  AND a.end_sec > a.start_sec AND b.end_sec > b.start_sec
  AND GREATEST(COALESCE(a.global_offset_sec,0), COALESCE(b.global_offset_sec,0))
    < LEAST(COALESCE(a.global_offset_sec,0) + (a.end_sec - a.start_sec),
            COALESCE(b.global_offset_sec,0) + (b.end_sec - b.start_sec))
ORDER BY overlap_sec DESC;
```

Swap the two `track='broll'` predicates for `clip_source_audio_id IS NOT NULL` to get the same
census for audio cutaways, which stack in the same way.

### C5 — B-roll sourced from a NON-`is_broll` uploaded video (the parity bug — see §4)

```sql
SELECT ts.project_id, ts.id AS section_id, ts.label,
       ts.type, ts.video_file_id,
       vf.filename, vf.is_broll, vf.hls_status,
       (vf.hls_master_key IS NOT NULL OR vf.hls_360p_key IS NOT NULL) AS has_hls,
       COALESCE(ts.global_offset_sec,0) AS plays_at_sec,
       ts.end_sec - ts.start_sec        AS length_sec,
       'viewer_omits_export_renders'    AS finding
FROM timeline_sections ts
JOIN video_files vf ON vf.id = ts.video_file_id
WHERE ts.track = 'broll'
  AND ts.clip_source_audio_id IS NULL
  AND vf.is_broll = false
ORDER BY ts.project_id, plays_at_sec;
```

### C5b — B-roll whose source has no playable HLS (silently dropped by the viewer only)

Same family, different cause: `buildPlayerConfig.ts:562-567` returns null when the source has
neither `hls_master_key` nor `hls_360p_key`, while `exportPlan.ts:528-529` uses `storage_key` and
renders it anyway.

```sql
SELECT ts.project_id, ts.id AS section_id, ts.label,
       vf.filename, vf.is_broll, vf.hls_status, vf.hls_error,
       vf.storage_key IS NOT NULL AS export_can_render,
       COALESCE(ts.global_offset_sec,0) AS plays_at_sec
FROM timeline_sections ts
JOIN video_files vf ON vf.id = ts.video_file_id
WHERE ts.track = 'broll'
  AND ts.clip_source_audio_id IS NULL
  AND vf.hls_master_key IS NULL
  AND vf.hls_360p_key   IS NULL
ORDER BY ts.project_id, plays_at_sec;
```

### C6 — Out-of-range trims (start/end outside the source duration)

Three sub-populations, because the "source" and the meaning of `start_sec/end_sec` differ per shape
(§1). Note `runVideoTranscode.ts:108-119` clamps `start_sec/end_sec` for rows matched on
`video_file_id` only — so b-roll and main rows get cut to fit after a re-transcode, and **clip rows
keyed on `clip_source_video_id` never do**.

```sql
-- C6a: b-roll — start_sec/end_sec are in/out points inside video_file_id
SELECT ts.project_id, ts.id AS section_id, ts.label, 'broll' AS shape,
       vf.duration_sec AS source_duration_sec, ts.start_sec, ts.end_sec,
       CASE WHEN vf.duration_sec IS NULL          THEN 'unknown_source_duration'
            WHEN ts.end_sec   > vf.duration_sec + 0.05 THEN 'out_point_past_source_end'
            WHEN ts.start_sec > vf.duration_sec + 0.05 THEN 'in_point_past_source_end'
            WHEN ts.start_sec < 0                 THEN 'negative_in_point'
       END AS finding
FROM timeline_sections ts JOIN video_files vf ON vf.id = ts.video_file_id
WHERE ts.track = 'broll' AND ts.clip_source_audio_id IS NULL
  AND (vf.duration_sec IS NULL
       OR ts.end_sec   > vf.duration_sec + 0.05
       OR ts.start_sec > vf.duration_sec + 0.05
       OR ts.start_sec < 0)

UNION ALL

-- C6b: clip — the window inside clip_source_video_id is [clip_in_sec, clip_in_sec + (end-start))
SELECT ts.project_id, ts.id, ts.label, 'clip',
       src.duration_sec, COALESCE(ts.clip_in_sec,0),
       COALESCE(ts.clip_in_sec,0) + (ts.end_sec - ts.start_sec),
       CASE WHEN src.duration_sec IS NULL THEN 'unknown_source_duration'
            WHEN COALESCE(ts.clip_in_sec,0) + (ts.end_sec - ts.start_sec)
                 > src.duration_sec + 0.05   THEN 'clip_window_past_source_end'
            WHEN COALESCE(ts.clip_in_sec,0) < 0 THEN 'negative_clip_in'
       END
FROM timeline_sections ts JOIN video_files src ON src.id = ts.clip_source_video_id
WHERE ts.type = 'clip'
  AND (src.duration_sec IS NULL
       OR COALESCE(ts.clip_in_sec,0) + (ts.end_sec - ts.start_sec) > src.duration_sec + 0.05
       OR COALESCE(ts.clip_in_sec,0) < 0)

UNION ALL

-- C6c: main-track — start_sec/end_sec are host-local, so they must fit the HOST video
SELECT ts.project_id, ts.id, ts.label, 'main',
       host.duration_sec, ts.start_sec, ts.end_sec,
       CASE WHEN host.duration_sec IS NULL             THEN 'unknown_host_duration'
            WHEN ts.start_sec > host.duration_sec + 0.05 THEN 'starts_past_host_end'
            ELSE 'ends_past_host_end' END
FROM timeline_sections ts JOIN video_files host ON host.id = ts.video_file_id
WHERE ts.track = 'main'
  AND ts.type <> 'simulation'          -- sim post-roll past the host end is DELIBERATE (exportPlan.ts:379-381)
  AND (host.duration_sec IS NULL
       OR ts.start_sec > host.duration_sec + 0.05
       OR ts.end_sec   > host.duration_sec + 0.05)
ORDER BY 1, 2;
```

The 0.05 s tolerance absorbs float REAL rounding; tighten to 0 for an exact audit.

### C7 — Unreachable sections

Four distinct ways a stored row can never reach a viewer.

```sql
-- C7a: b-roll / audio positioned at or past the end of the main timeline.
--      The viewer's global clock never reaches it (useProjectPlayer.ts:2352 window test).
WITH main_total AS (
  SELECT project_id, SUM(COALESCE(duration_sec,0)) AS total_sec
  FROM video_files WHERE is_broll = false GROUP BY project_id
)
SELECT ts.project_id, ts.id AS section_id, ts.track, ts.type, ts.label,
       COALESCE(ts.global_offset_sec,0) AS starts_at_sec,
       mt.total_sec                     AS main_timeline_ends_at_sec,
       'starts_after_main_timeline_ends' AS finding
FROM timeline_sections ts
LEFT JOIN main_total mt ON mt.project_id = ts.project_id
WHERE (ts.track IN ('broll','audio') OR ts.clip_source_audio_id IS NOT NULL)
  AND COALESCE(ts.global_offset_sec,0) >= COALESCE(mt.total_sec, 0)
ORDER BY ts.project_id;
```

```sql
-- C7b: any section hosted by a video that is not a MAIN video of the project.
--      buildPlayerConfig builds segments from mainVideos only (:224,:549) and
--      videoGlobalOffsets from mainVideos only (:585-588); exportPlan warns and skips (:375-377).
SELECT ts.project_id, ts.id AS section_id, ts.track, ts.type, ts.label,
       ts.video_file_id, vf.is_broll AS host_is_broll,
       vf.project_id AS host_project_id,
       CASE WHEN vf.id IS NULL             THEN 'host_video_missing'
            WHEN vf.is_broll               THEN 'host_is_a_broll_source'
            WHEN vf.project_id IS DISTINCT FROM ts.project_id THEN 'host_in_another_project'
       END AS finding
FROM timeline_sections ts
LEFT JOIN video_files vf ON vf.id = ts.video_file_id
WHERE ts.track = 'main'
  AND (vf.id IS NULL OR vf.is_broll OR vf.project_id IS DISTINCT FROM ts.project_id)
ORDER BY ts.project_id;
```

```sql
-- C7c: orphaned clip — the ON DELETE SET NULL hole. Matches no branch in either reader,
--      and unlike every other exclusion, NOTHING warns.
SELECT ts.project_id, ts.id AS section_id, ts.track, ts.type, ts.label,
       ts.start_sec, ts.end_sec,
       'clip_with_no_source_silently_dropped_everywhere' AS finding
FROM timeline_sections ts
WHERE ts.type = 'clip'
  AND ts.clip_source_video_id IS NULL
  AND ts.clip_source_image_id IS NULL
  AND ts.clip_source_audio_id IS NULL
ORDER BY ts.project_id;
```

```sql
-- C7d: zero-length or inverted windows. The APIs reject start >= end on write
--      (sections.controller.ts:259, broll.controller.ts:167) but the transcode clamp
--      (runVideoTranscode.ts:114-119) can drive start_sec and end_sec to the same value.
SELECT ts.project_id, ts.id AS section_id, ts.track, ts.type, ts.label,
       ts.start_sec, ts.end_sec, ts.end_sec - ts.start_sec AS length_sec
FROM timeline_sections ts
WHERE ts.end_sec <= ts.start_sec
ORDER BY ts.project_id;
```

### C8 — Duplicate generated sections from retried `video_generate` jobs

**Mechanism, from the code.** `video.generate.ts` step 6 (`:142-150`) does an unconditional
`INSERT` with no idempotency key and no "does this job already have a section" check; step 7
(`:154-156`) then records `section_id` on the job, so a job that inserted twice keeps only the
LAST id and the earlier section becomes an untracked orphan. The `:58` guard
(`status === 'ready' || 'failed' → return`) only stops a retry of an already-FINISHED job; a retry
that starts while the first attempt is between step 4 and step 7 sails past it. Two amplifiers:
`videoGenerateTask` retries (`:174`, `maxAttempts: 2`), and — per the verified ground truth —
`PGBOSS_JOB_NAMES` now includes `video_generate` (`pgBoss.ts:22`) while
`singletonKeyFor` returns a key for `'crop'` ONLY (`pgBossDriver.ts:60-63`), so duplicate
`video_generate` sends are never collapsed. Because the resume path re-polls the same external task
and `downloadAndStore` inserts a **fresh** `video_files` row every call
(`VideoGenerationService.ts:317-329`), the two sections point at two DIFFERENT video files holding
the same generated bytes — so `video_file_id` cannot be the dedup key. `target_global_offset_sec`
and the prompt-derived `label` can.

```sql
-- C8a: b-roll sections that collide at the same offset with the same label — the retry signature.
SELECT ts.project_id,
       ts.global_offset_sec,
       ts.label,
       count(*)                       AS copies,
       array_agg(ts.id ORDER BY ts.created_at)            AS section_ids,
       array_agg(ts.video_file_id ORDER BY ts.created_at) AS video_file_ids,
       array_agg(ts.created_at ORDER BY ts.created_at)    AS created_ats,
       max(ts.created_at) - min(ts.created_at)            AS spread
FROM timeline_sections ts
WHERE ts.track = 'broll' AND ts.clip_source_audio_id IS NULL
GROUP BY ts.project_id, ts.global_offset_sec, ts.label
HAVING count(*) > 1
ORDER BY copies DESC, spread ASC;
```

A small `spread` (seconds to minutes) and distinct `video_file_ids` is a retry. A large spread is
more likely a user deliberately placing the same clip twice — which is legal. Do not treat C8a as
proof on its own; cross it with C8b.

```sql
-- C8b: generated b-roll sections that NO job row claims. Every section created by the generator
--      is pointed to by exactly one video_generation_jobs.section_id (video.generate.ts:154-156);
--      an AI-sourced b-roll section with no claimant is a section the generator created and then
--      lost track of — the earlier copy of a double insert.
SELECT ts.project_id, ts.id AS section_id, ts.label,
       ts.global_offset_sec, ts.video_file_id, ts.created_at,
       vf.is_broll, vf.filename
FROM timeline_sections ts
JOIN video_files vf ON vf.id = ts.video_file_id AND vf.is_broll = true
WHERE ts.track = 'broll'
  AND ts.clip_source_audio_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM video_generation_jobs j WHERE j.section_id = ts.id)
ORDER BY ts.project_id, ts.created_at;
```

Caveat: `video_generation_jobs.section_id` is `ON DELETE SET NULL` (010) and job rows are user-
deletable (`broll.controller.ts:124-141`), so C8b also catches sections whose job row was deleted.
Both C8b interpretations are benign-to-fix; the ranking signal is the intersection of C8a and C8b.

```sql
-- C8c: jobs whose target offset has more b-roll sections than the job created — the cross-check.
SELECT j.project_id, j.id AS job_id, j.status, j.target_global_offset_sec,
       j.section_id AS claimed_section_id,
       count(ts.id) AS sections_at_that_offset,
       array_agg(ts.id) AS section_ids
FROM video_generation_jobs j
LEFT JOIN timeline_sections ts
       ON ts.project_id = j.project_id
      AND ts.track = 'broll'
      AND ts.clip_source_audio_id IS NULL
      AND abs(COALESCE(ts.global_offset_sec,0) - j.target_global_offset_sec) < 0.01
GROUP BY j.project_id, j.id, j.status, j.target_global_offset_sec, j.section_id
HAVING count(ts.id) > 1
ORDER BY sections_at_that_offset DESC;
```

---

## 4. The viewer-parity claim: **CONFIRMED**

> *"'Use Existing' b-roll sourced from a normal uploaded video is accepted by the editor and the
> export but OMITTED by buildPlayerConfig because `is_broll` is false."*

Confirmed end to end. The chain, with file:line:

**The editor offers non-b-roll videos.** `VideoEditor.tsx:1315` passes `videos={allVideos}` to
`BrollPanel` — `allVideos` is the unfiltered list (`VideoEditor.tsx:268,374`), while `videos`
(main-only) exists right beside it and is what is passed everywhere else (e.g. `:1755`).
`BrollPanel.tsx:141` filters that list only by `hls_status === 'ready' || duration_sec != null` —
no `is_broll` filter — and `BrollPanel.tsx:297` renders an "AI" badge *only when* `v.is_broll`,
which is direct evidence the list is expected to contain non-AI videos.

**The API accepts it.** `broll.controller.ts:159-161` validates *only* that the video exists and
belongs to the project; there is no `is_broll` predicate. `:171-181` then inserts
`track:'broll', type:'broll', video_file_id:<the main video>`.

**The editor plays it.** `VideoEditor.tsx:474-475` classifies b-roll by `track` alone;
`TimelinePanel.tsx:850-851` resolves the source through `allVideos`; `VideoEditor.tsx:391-395`
seeds `hlsUrls` from *every* video, so `:539` `brollHlsUrl` resolves and the overlay renders.

**The export renders it.** `exportPlan.ts:268` builds `videoById` from `allVideos` (not from a
b-roll-only map), so the b-roll branch at `:516-517` resolves the source and `:522-533` emits a
`ClipWindow{sourceRole:'broll'}` with `storageKey: src.storage_key`. No warning, because from the
export's point of view nothing is wrong.

**`buildPlayerConfig` drops it — silently.** `:225` `brollVideos = allVideos.filter(v => v.is_broll)`;
`:556` `brollVideoMap` is built from `brollVideos` ONLY; `:560-561`
`const brollVid = brollVideoMap.get(s.video_file_id); if (!brollVid) return null;` — and `:578`
`.filter(Boolean)` removes it from `broll_clips`. **No log line, no warning field, no counter.** The
row is not rescued by the clip path either: `:591` requires `type==='clip' && clip_source_video_id`,
and this row has `type='broll'` with a NULL `clip_source_video_id`.

**Net effect:** the user marks a region, picks one of their own uploaded clips, sees it in the
editor preview, exports a video that contains it — and the shared/published player shows nothing at
that timestamp. Silently, with no diagnostic anywhere.

**Scope of the fix (for the next phase, not done here):** this is a read-side omission with two
candidate repairs — widen the b-roll source map to all project videos (matching `exportPlan.ts:268`
and the editor), or reject non-`is_broll` sources at `broll.controller.ts:159-161` (matching
`buildPlayerConfig`). They are NOT equivalent: the first makes existing stored rows start playing,
the second makes new inserts fail while leaving stored rows dark. The first restores what three of
four surfaces already do and requires no migration; the second is a behaviour removal. Both change
what published viewers show, so which one ships is a call for whoever owns D-01's sibling decision.
Query C5 sizes the affected population before either is chosen. Related and in the same family:
C5b, where the viewer alone drops a b-roll whose HLS never completed while the export renders it
from `storage_key`.

**Also confirmed while verifying the above (not in the original claim):** the omission is *silent*
on the viewer path but *narrated* on the export path (`exportPlan.ts:519,537`) — the two readers
disagree about whether an excluded b-roll is worth telling anyone about.

---

## 5. Deliberately NOT done

* **No database connection, and no query was executed.** There is no production DB available here,
  and connecting to one is out of scope and forbidden by the task and by the standing
  "never touch prod from local" rule. Every number this file could produce is a query, not a result.
* **No anchoring change and no migration.** The `duration_sec`-running-sum anchor
  (`buildPlayerConfig.ts:585-588` vs `runVideoTranscode.ts:99`) is D-01 and is blocked on a product
  decision. C2 and C6 *measure* the consequences; nothing here proposes re-anchoring or backfilling.
* **No fix applied.** This phase is read-only; not one source file was modified.
* **The PATCH "omitted fields are cleared" claim is not counted** — it is REFUTED
  (`sections.controller.ts:357,380` builds `{...rest}` and only assigns keys that were sent), so no
  census class exists for it.
* **Main-track rows with a NULL `global_offset_sec` are excluded from C1 by design** — main rows are
  positioned by `start_sec` within their host video and legitimately have no global offset. Counting
  them would manufacture a finding out of correct data.
* **No dedup/repair SQL is included.** Everything here is `SELECT`. Turning C2/C8 into `UPDATE`s
  requires deciding which of two positions a hybrid should keep and which of two duplicate sections
  is canonical — decisions, not cleanups.
