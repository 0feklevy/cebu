-- =====================================================================================
-- FlowVid storage/DB volume census  —  READ-ONLY, AGGREGATE-ONLY
-- =====================================================================================
-- Run by the OWNER, against production, e.g.:
--
--     psql "<production connection string>" -v ON_ERROR_STOP=1 -f census.sql > census.out 2>&1
--
-- SAFETY, stated so it can be checked rather than trusted:
--   * The session is put into a READ-ONLY transaction before the first query. Any
--     INSERT/UPDATE/DELETE/DDL in this file — including one added later by mistake —
--     is refused by the server, not by convention.
--   * statement_timeout bounds every query. Nothing here can pin a connection.
--   * NO row identifiers, titles, emails, transcripts, tokens, prompts, URLs or storage
--     keys are selected. Every output is a COUNT, a SUM, a bucket, or a table name.
--     project ids appear only in section E, hashed, and can be turned off (see E0).
--   * Nothing here touches object storage. Sections marked [STORAGE-SIDE] name the
--     reference set the owner must diff against a bucket LIST; SQL alone cannot answer
--     them, and this file does not pretend to.
-- =====================================================================================

\set ON_ERROR_STOP on
\timing on

SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '60s';
BEGIN READ ONLY;

\echo ''
\echo '### A. Per-table bytes: heap + indexes + TOAST, and dead tuples'
\echo '### TOAST is the column to read first: it is where large text/jsonb actually lives.'

SELECT
  c.relname                                              AS table_name,
  pg_size_pretty(pg_total_relation_size(c.oid))          AS total,
  pg_size_pretty(pg_table_size(c.oid)
                 - COALESCE(pg_total_relation_size(c.reltoastrelid), 0)) AS heap,
  pg_size_pretty(COALESCE(pg_total_relation_size(c.reltoastrelid), 0))   AS toast,
  pg_size_pretty(pg_indexes_size(c.oid))                 AS indexes,
  s.n_live_tup                                           AS live_rows,
  s.n_dead_tup                                           AS dead_rows,
  CASE WHEN s.n_live_tup > 0
       THEN round(100.0 * s.n_dead_tup / s.n_live_tup, 1)
       ELSE NULL END                                     AS dead_pct,
  s.last_autovacuum::date                                AS last_autovacuum,
  s.last_autoanalyze::date                               AS last_autoanalyze
FROM pg_class c
JOIN pg_namespace n      ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;

\echo ''
\echo '### A2. Database total, for the denominator every ratio below needs'
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_total;

\echo ''
\echo '### B. Index bytes, and which indexes are never scanned'
\echo '### idx_scan = 0 on a large index is a delete candidate; check it is not a'
\echo '### constraint-backing index (unique/pk) before acting.'

SELECT
  s.relname                                     AS table_name,
  s.indexrelname                                AS index_name,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
  s.idx_scan                                    AS scans,
  i.indisunique                                 AS is_unique,
  i.indisprimary                                AS is_primary,
  (i.indpred IS NOT NULL)                       AS is_partial
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE pg_relation_size(s.indexrelid) > 1024 * 1024
ORDER BY pg_relation_size(s.indexrelid) DESC;

\echo ''
\echo '### C. Wide-column weight: which large text/jsonb columns carry the TOAST bytes.'
\echo '### pg_column_size on the datum, summed. No values are shown.'

SELECT 'video_files.captions_vtt'      AS col, count(*) FILTER (WHERE captions_vtt IS NOT NULL) AS non_null_rows,
       pg_size_pretty(COALESCE(sum(pg_column_size(captions_vtt)), 0)::bigint) AS bytes FROM video_files
UNION ALL SELECT 'video_files.waveform_peaks', count(*) FILTER (WHERE waveform_peaks IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(waveform_peaks)), 0)::bigint) FROM video_files
UNION ALL SELECT 'timeline_sections.sim_script', count(*) FILTER (WHERE sim_script IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(sim_script)), 0)::bigint) FROM timeline_sections
UNION ALL SELECT 'timeline_sections.sim_meta', count(*) FILTER (WHERE sim_meta IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(sim_meta)), 0)::bigint) FROM timeline_sections
UNION ALL SELECT 'corpora.extracted_md', count(*) FILTER (WHERE extracted_md IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(extracted_md)), 0)::bigint) FROM corpora
UNION ALL SELECT 'podcast_sources.extracted_md', count(*) FILTER (WHERE extracted_md IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(extracted_md)), 0)::bigint) FROM podcast_sources
UNION ALL SELECT 'project_exports.plan', count(*) FILTER (WHERE plan IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(plan)), 0)::bigint) FROM project_exports
UNION ALL SELECT 'project_exports.effective_plan', count(*) FILTER (WHERE effective_plan IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(effective_plan)), 0)::bigint) FROM project_exports
UNION ALL SELECT 'project_duplications.plan', count(*) FILTER (WHERE plan IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(plan)), 0)::bigint) FROM project_duplications
UNION ALL SELECT 'simulations.guidance', count(*) FILTER (WHERE guidance IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(guidance)), 0)::bigint) FROM simulations
UNION ALL SELECT 'simulations.canary_report', count(*) FILTER (WHERE canary_report IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(canary_report)), 0)::bigint) FROM simulations
UNION ALL SELECT 'sim_revisions.canary_report', count(*) FILTER (WHERE canary_report IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(canary_report)), 0)::bigint) FROM sim_revisions
UNION ALL SELECT 'sim_revisions.metadata', count(*) FILTER (WHERE metadata IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(metadata)), 0)::bigint) FROM sim_revisions
UNION ALL SELECT 'sim_posters.variants', count(*),
       pg_size_pretty(COALESCE(sum(pg_column_size(variants)), 0)::bigint) FROM sim_posters
UNION ALL SELECT 'podcast_scripts.body_json', count(*) FILTER (WHERE body_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(body_json)), 0)::bigint) FROM podcast_scripts
UNION ALL SELECT 'podcast_scripts.materials_json', count(*) FILTER (WHERE materials_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(materials_json)), 0)::bigint) FROM podcast_scripts
UNION ALL SELECT 'podcast_scripts.story_json', count(*) FILTER (WHERE story_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(story_json)), 0)::bigint) FROM podcast_scripts
UNION ALL SELECT 'podcast_scripts.review_json', count(*) FILTER (WHERE review_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(review_json)), 0)::bigint) FROM podcast_scripts
UNION ALL SELECT 'podcast_clips.peaks_json', count(*) FILTER (WHERE peaks_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(peaks_json)), 0)::bigint) FROM podcast_clips
UNION ALL SELECT 'podcast_chunk_audio.segments_json', count(*) FILTER (WHERE segments_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(segments_json)), 0)::bigint) FROM podcast_chunk_audio
UNION ALL SELECT 'podcast_mix_snapshots.timeline_json', count(*),
       pg_size_pretty(COALESCE(sum(pg_column_size(timeline_json)), 0)::bigint) FROM podcast_mix_snapshots
UNION ALL SELECT 'podcast_renders.timeline_json', count(*) FILTER (WHERE timeline_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(timeline_json)), 0)::bigint) FROM podcast_renders
UNION ALL SELECT 'scripts.body_json', count(*) FILTER (WHERE body_json IS NOT NULL),
       pg_size_pretty(COALESCE(sum(pg_column_size(body_json)), 0)::bigint) FROM scripts
UNION ALL SELECT 'avatar_conversations.content', count(*),
       pg_size_pretty(COALESCE(sum(pg_column_size(content)), 0)::bigint) FROM avatar_conversations
ORDER BY 1;

\echo ''
\echo '### D. Unbounded append-only tables: rows by age bucket.'
\echo '### Only sim_rum_events has a retention sweep. A count that keeps rising in the'
\echo '### >365d bucket is the definition of "no retention".'

WITH t AS (
  SELECT 'token_usage'         AS tbl, occurred_at AS ts FROM token_usage
  UNION ALL SELECT 'branch_path_events', created_at FROM branch_path_events
  UNION ALL SELECT 'sim_rum_events',     created_at FROM sim_rum_events
  UNION ALL SELECT 'avatar_conversations', created_at FROM avatar_conversations
  UNION ALL SELECT 'jobs',               created_at FROM jobs
  UNION ALL SELECT 'video_generation_jobs', created_at FROM video_generation_jobs
  UNION ALL SELECT 'podcast_chunk_audio', created_at FROM podcast_chunk_audio
  UNION ALL SELECT 'podcast_clips',      created_at FROM podcast_clips
  UNION ALL SELECT 'podcast_mix_snapshots', created_at FROM podcast_mix_snapshots
  UNION ALL SELECT 'project_exports',    created_at FROM project_exports
  UNION ALL SELECT 'project_duplications', created_at FROM project_duplications
  UNION ALL SELECT 'sim_revisions',      created_at FROM sim_revisions
  UNION ALL SELECT 'sim_posters',        created_at FROM sim_posters
  UNION ALL SELECT 'hls_retired_runs',   retired_at FROM hls_retired_runs
)
SELECT tbl,
       count(*)                                                        AS rows_total,
       count(*) FILTER (WHERE ts >= now() - interval '30 days')         AS last_30d,
       count(*) FILTER (WHERE ts <  now() - interval '90 days')         AS older_90d,
       count(*) FILTER (WHERE ts <  now() - interval '365 days')        AS older_365d,
       min(ts)::date                                                    AS oldest
FROM t GROUP BY tbl ORDER BY rows_total DESC;

\echo ''
\echo '### E. Per-project asset inventory (the reference set for a storage diff).'
\echo '### E0 PRIVACY: the project id is hashed. To include the real id (needed to act on'
\echo '###    a specific project) replace md5(...) with p.id::text. Titles are NEVER'
\echo '###    selected either way.'
\echo '### Only video bytes are known to the database (video_files.file_size). Every'
\echo '### other class reports COUNTS; its bytes require a bucket LIST. Do not multiply'
\echo '### counts by a guessed average size — that is how a fabricated number is born.'

SELECT
  left(md5(p.id::text), 8)                                      AS project_hash,
  (SELECT count(*) FROM video_files v WHERE v.project_id = p.id)                       AS videos,
  pg_size_pretty(COALESCE((SELECT sum(v.file_size) FROM video_files v
                           WHERE v.project_id = p.id), 0)::bigint)                     AS video_source_bytes,
  (SELECT count(*) FROM video_files v WHERE v.project_id = p.id
                                        AND v.hls_master_key IS NOT NULL)              AS hls_trees,
  (SELECT count(*) FROM image_files  i WHERE i.project_id = p.id)                      AS images,
  (SELECT count(*) FROM audio_files  a WHERE a.project_id = p.id)                      AS audios,
  (SELECT count(*) FROM simulations  s WHERE s.project_id = p.id)                      AS sims,
  (SELECT count(*) FROM sim_revisions r JOIN simulations s ON s.id = r.simulation_id
                                       WHERE s.project_id = p.id)                      AS sim_revs,
  (SELECT count(*) FROM sim_posters  q JOIN simulations s ON s.id = q.simulation_id
                                       WHERE s.project_id = p.id)                      AS sim_posters,
  (SELECT count(*) FROM avatar_visuals av WHERE av.project_id = p.id
                                            AND av.image_key IS NOT NULL)              AS avatar_images,
  (SELECT count(*) FROM avatar_visuals av WHERE av.project_id = p.id
                                            AND av.sim_storage_prefix IS NOT NULL)     AS avatar_sim_prefixes,
  (SELECT count(*) FROM corpora c WHERE c.project_id = p.id
                                    AND c.storage_url IS NOT NULL)                     AS corpus_objects,
  (SELECT count(*) FROM project_exports e WHERE e.project_id = p.id)                   AS exports_total,
  (SELECT count(*) FROM project_exports e WHERE e.project_id = p.id
                                            AND e.status = 'ready')                    AS exports_ready,
  (p.thumbnail_key IS NOT NULL)                                                        AS has_thumbnail
FROM projects p
ORDER BY COALESCE((SELECT sum(v.file_size) FROM video_files v WHERE v.project_id = p.id), 0) DESC
LIMIT 200;

\echo ''
\echo '### F. Candidate orphans and redundancies that SQL alone can settle.'
\echo '### Each row is a claim the code review makes; the number says whether to act on it.'

-- F1. Export intermediates. sections/*.mp4 under a READY export are redundant (they are
--     spliced into master.mp4). A terminal export with NO output_key left a whole prefix behind.
SELECT 'F1 exports: ready (sections/ redundant)'  AS finding, count(*) AS n
  FROM project_exports WHERE status = 'ready' AND output_key IS NOT NULL
UNION ALL
SELECT 'F1 exports: terminal, no output_key (whole prefix orphaned)', count(*)
  FROM project_exports WHERE status IN ('failed','cancelled') AND output_key IS NULL
UNION ALL
SELECT 'F1 exports: stuck in-flight (reaper fails the row; bytes stay)', count(*)
  FROM project_exports WHERE status NOT IN ('ready','failed','cancelled')
UNION ALL
-- F2. Caption storage backups. The DB column is the source of truth and the reader prefers it,
--     so a row with BOTH has a redundant object. Each regeneration mints a NEW uuid key.
SELECT 'F2 captions: rows with BOTH captions_vtt and captions_vtt_key (key redundant)', count(*)
  FROM video_files WHERE captions_vtt IS NOT NULL AND captions_vtt_key IS NOT NULL
UNION ALL
SELECT 'F2 captions: key-only rows (legacy; key is LOAD-BEARING, do not delete)', count(*)
  FROM video_files WHERE captions_vtt IS NULL AND captions_vtt_key IS NOT NULL
UNION ALL
-- F3. Crop metadata. Deterministic key crop/{videoId}.json — one per video, overwritten.
SELECT 'F3 crop: live crop_key rows (reference set for the crop/ prefix diff)', count(*)
  FROM video_files WHERE crop_key IS NOT NULL
UNION ALL
-- F4. Failed duplications. plan holds every destination key that was written.
SELECT 'F4 duplications: failed WITH a plan (orphan bytes are enumerable from it)', count(*)
  FROM project_duplications WHERE status = 'failed' AND plan IS NOT NULL
UNION ALL
SELECT 'F4 duplications: failed WITHOUT a plan (bytes findable only by prefix diff)', count(*)
  FROM project_duplications WHERE status = 'failed' AND plan IS NULL
UNION ALL
-- F5. Retired HLS trees awaiting / past the grace sweep.
SELECT 'F5 hls_retired_runs: pending (sweep will delete)', count(*)
  FROM hls_retired_runs WHERE deleted_at IS NULL
UNION ALL
SELECT 'F5 hls_retired_runs: overdue >24h past retire_after (sweep is NOT running)', count(*)
  FROM hls_retired_runs WHERE deleted_at IS NULL AND retire_after < now() - interval '24 hours'
UNION ALL
SELECT 'F5 hls_retired_runs: already swept (row prunable)', count(*)
  FROM hls_retired_runs WHERE deleted_at IS NOT NULL
UNION ALL
-- F6. Sim revisions past the gc floor (RevisionService.gc keeps >= 2). No production caller.
SELECT 'F6 sim_revisions: total', count(*) FROM sim_revisions
UNION ALL
SELECT 'F6 sim_revisions: beyond the newest 2 per simulation (gc-eligible packages)', count(*)
  FROM (SELECT id, row_number() OVER (PARTITION BY simulation_id
                                      ORDER BY revision_number DESC) AS rn
        FROM sim_revisions) r WHERE r.rn > 2
UNION ALL
-- F7. Posters from a superseded package revision. PosterService.invalidate / cleanupOrphans
--     have no production caller, so these renditions are unreachable.
SELECT 'F7 sim_posters: package_revision != the active revision manifest (unreachable)', count(*)
  FROM sim_posters q
  JOIN simulations s        ON s.id = q.simulation_id
  LEFT JOIN sim_revisions r ON r.id = s.active_revision_id
  WHERE r.id IS NOT NULL AND q.package_revision IS DISTINCT FROM r.manifest_hash
UNION ALL
-- F8. Podcast media. No delete path touches storage at all, so these are the LIVE set;
--     everything under podcasts/ that is not named here is already orphaned.
SELECT 'F8 podcast: live chunk/preview objects', count(*)
  FROM podcast_chunk_audio WHERE storage_key IS NOT NULL
UNION ALL
SELECT 'F8 podcast: chunk rows of kind=preview (one object per preview click)', count(*)
  FROM podcast_chunk_audio WHERE storage_key IS NOT NULL AND kind = 'preview'
UNION ALL
SELECT 'F8 podcast: live clip takes', count(*) FROM podcast_clips
UNION ALL
SELECT 'F8 podcast: clips whose script_version has no surviving script row', count(*)
  FROM podcast_clips c
  WHERE NOT EXISTS (SELECT 1 FROM podcast_scripts s
                    WHERE s.episode_id = c.episode_id AND s.version = c.script_version)
UNION ALL
SELECT 'F8 podcast: render master objects (mp4 + mp3 + wav keys)',
       count(*) FILTER (WHERE master_mp4_key IS NOT NULL)
     + count(*) FILTER (WHERE master_mp3_key IS NOT NULL)
     + count(*) FILTER (WHERE master_wav_key IS NOT NULL)
  FROM podcast_renders
UNION ALL
SELECT 'F8 podcast: source uploads', count(*) FROM podcast_sources WHERE storage_key IS NOT NULL
UNION ALL
-- F9. Avatar visuals: the rows a project delete cascades away WITHOUT collecting their bytes.
SELECT 'F9 avatar_visuals: project rows with an image_key (leak on project delete)', count(*)
  FROM avatar_visuals WHERE project_id IS NOT NULL AND image_key IS NOT NULL AND source <> 'editor'
UNION ALL
SELECT 'F9 avatar_visuals: project rows with a sim prefix (leak on project delete)', count(*)
  FROM avatar_visuals WHERE project_id IS NOT NULL AND sim_storage_prefix IS NOT NULL AND source <> 'editor'
UNION ALL
-- F10. Reference sets for prefixes that NO code path ever deletes.
SELECT 'F10 reference: projects with a thumbnail (thumbnails/{id}/ should hold exactly 1)', count(*)
  FROM projects WHERE thumbnail_key IS NOT NULL
UNION ALL
SELECT 'F10 reference: playlists with a banner (playlist-banners/{id}/ should hold exactly 1)', count(*)
  FROM playlists WHERE banner_storage_key IS NOT NULL
UNION ALL
SELECT 'F10 reference: corpora with a storage_url (projects/{id}/corpus/)', count(*)
  FROM corpora WHERE storage_url IS NOT NULL
UNION ALL
-- F11. Rows pointing at media whose owning parent is already gone (both should be 0).
SELECT 'F11 video_files with no project row (should be 0 — FK is CASCADE)', count(*)
  FROM video_files v LEFT JOIN projects p ON p.id = v.project_id WHERE p.id IS NULL
UNION ALL
SELECT 'F11 sim_posters whose simulation is gone (should be 0 — FK is CASCADE)', count(*)
  FROM sim_posters q LEFT JOIN simulations s ON s.id = q.simulation_id WHERE s.id IS NULL
ORDER BY 1;

\echo ''
\echo '### G. [STORAGE-SIDE] What SQL cannot answer. Run these against the bucket, not here.'
\echo '###  G1 thumbnails/{projectId}/*        vs projects.thumbnail_key         -> superseded thumbnails'
\echo '###  G2 playlist-banners/{playlistId}/* vs playlists.banner_storage_key   -> superseded banners'
\echo '###  G3 captions/*                      vs video_files.captions_vtt_key   -> superseded VTT backups'
\echo '###  G4 crop/*.json                     vs video_files.id                 -> crop orphans'
\echo '###  G5 exports/*                       vs project_exports id/output_key  -> sections/ + dead prefixes'
\echo '###  G6 videos/{projectId}/*            vs video_files.storage_key        -> unconfirmed uploads'
\echo '###  G7 podcasts/*                      vs the F8 live set                -> deleted-show leftovers'
\echo '###  G8 images/avatar/**, simulations/avatar/** vs avatar_visuals         -> avatar leaks'
\echo '###  G9 S3 ListMultipartUploads (ALL prefixes)                            -> abandoned multipart parts'
\echo '###     G9 is invisible to any object LIST and is billed. Check it first.'

COMMIT;
\echo ''
\echo '### census complete — the transaction was READ ONLY throughout'
