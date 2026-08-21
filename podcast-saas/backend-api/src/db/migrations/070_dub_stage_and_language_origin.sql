-- 070 — where a dub actually IS, and where a project's source language came FROM.
--
-- Two columns, one screen. The creator's dubbing panel shipped with a progress bar and a
-- source-language exclusion, and both were drawn from data nothing wrote.
--
-- ── video_dubs.stage / stage_entered_at ───────────────────────────────────────────────────────
-- The bar was `done / total videos`. Nearly every project has one video, so it read 0/1 for the
-- whole run and then 1/1 — a boolean drawn as a bar. A dub is really seven steps (slot wait,
-- transcribe, translate, caption, download, mux, package), each a distinct place in DubbingService
-- and each a different length. `stage` records which one is running; `stage_entered_at` is what
-- lets the bar advance inside a step where the vendor gives no signal of its own.
--
-- Both nullable, because a row mid-flight when this deploys has a stage nobody recorded, and the
-- honest reading of that is "unknown", not "step one".
ALTER TABLE video_dubs ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE video_dubs ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ;

-- ── projects.source_language_origin ───────────────────────────────────────────────────────────
-- Migration 068 added `source_language` and the routes refuse to dub a video into it. Nothing ever
-- wrote the column, so it is null everywhere and an English video is still offered English.
-- Detection is the missing half — but a DETECTED value and a DECLARED one must not be stored
-- identically: acting on a guess as if a human had asserted it is how a creator loses a language
-- they wanted with no explanation on screen.
--
--   declared — a person chose it. Nothing overwrites this.
--   vendor   — the dubbing vendor auto-detected it from the audio while doing a real run. It heard
--              the speech, so it outranks anything inferred from text.
--   detected — this product identified it offline from the stored transcript.
--
-- Null alongside a non-null source_language means the value predates this column; it is treated as
-- `declared`, which is the conservative reading — it is never silently overwritten.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_language_origin TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_source_language_origin_chk') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_source_language_origin_chk
      CHECK (source_language_origin IS NULL OR source_language_origin IN ('declared', 'detected', 'vendor'));
  END IF;
END $$;

-- The panel polls this while a dub runs, filtered to the project's videos and the unfinished rows.
-- The existing (status, claimed_at) index does not serve it: the question here is "which of THESE
-- videos is still moving", and the leading column has to be the video.
CREATE INDEX IF NOT EXISTS idx_video_dubs_video_status ON video_dubs (video_file_id, status);
