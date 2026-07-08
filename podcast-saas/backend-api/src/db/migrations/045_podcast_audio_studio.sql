-- 045: Audio Studio — Premiere-style multitrack editing for podcast episodes.
--
-- Three pillars:
--   podcast_clips         — persisted per-turn takes (content-addressed WAV + peaks).
--                           Takes are immutable and never deleted (undo/restore always
--                           resolves); a re-voice inserts a new take row.
--   podcast_mixes         — ONE mutable draft per episode: the order-preserving
--                           timeline document (clips in script order, per-clip
--                           gap/trim/gain/mute) + optimistic-concurrency `rev`.
--   podcast_mix_snapshots — immutable named versions of the draft (manual save,
--                           auto-freeze on every export, pre-rebuild safety copies).
--
-- Export artifacts reuse podcast_renders (kind='mix') so polling/history/recovery
-- infrastructure is shared with the legacy one-click render (kind='auto').

CREATE TABLE IF NOT EXISTS podcast_clips (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     UUID NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  turn_id        TEXT NOT NULL,                 -- PodcastTurn.id (^[A-Za-z0-9_-]{1,64}$)
  take_hash      TEXT NOT NULL,                 -- sha256 of the exact synth+recut+tempo recipe
  text_hash      TEXT NOT NULL,                 -- sha256(speaker|text) — staleness vs current script
  script_version INTEGER,                       -- informational: version whose text produced this take
  storage_key    TEXT NOT NULL,                 -- podcasts/{episodeId}/clips/{take_hash}.wav
  duration_ms    INTEGER NOT NULL,
  peaks_json     JSONB,                         -- number[] 0..1, ~1 peak / 25ms
  source         TEXT NOT NULL DEFAULT 'batch', -- batch | regen
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (episode_id, turn_id, take_hash)
);
CREATE INDEX IF NOT EXISTS idx_podcast_clips_episode ON podcast_clips(episode_id);

CREATE TABLE IF NOT EXISTS podcast_mixes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     UUID NOT NULL UNIQUE REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  script_version INTEGER,                       -- version the draft was (re)built from
  script_hash    TEXT,                          -- content hash at build time — "script changed" banner
  status         TEXT NOT NULL DEFAULT 'empty', -- empty | generating | ready | failed
  claimed_at     TIMESTAMPTZ,                   -- job CAS claim (runPodcastRender pattern)
  progress       JSONB,                         -- { stage, done, total }
  timeline_json  JSONB,                         -- MixTimeline (shared/src/types/podcastStudio.ts)
  rev            INTEGER NOT NULL DEFAULT 0,    -- optimistic concurrency for autosave
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS podcast_mix_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mix_id         UUID NOT NULL REFERENCES podcast_mixes(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'manual',  -- manual | export | pre_rebuild
  script_version INTEGER,
  timeline_json  JSONB NOT NULL,
  render_id      UUID,                            -- set for kind='export' (FK added below)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_podcast_mix_snapshots_mix ON podcast_mix_snapshots(mix_id);

ALTER TABLE podcast_renders ADD COLUMN IF NOT EXISTS kind            TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE podcast_renders ADD COLUMN IF NOT EXISTS format          TEXT;
ALTER TABLE podcast_renders ADD COLUMN IF NOT EXISTS master_wav_key  TEXT;
ALTER TABLE podcast_renders ADD COLUMN IF NOT EXISTS mix_snapshot_id UUID;

-- Cross-references added after both tables exist (idempotent via constraint name check).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'podcast_mix_snapshots_render_id_fkey') THEN
    ALTER TABLE podcast_mix_snapshots
      ADD CONSTRAINT podcast_mix_snapshots_render_id_fkey
      FOREIGN KEY (render_id) REFERENCES podcast_renders(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'podcast_renders_mix_snapshot_id_fkey') THEN
    ALTER TABLE podcast_renders
      ADD CONSTRAINT podcast_renders_mix_snapshot_id_fkey
      FOREIGN KEY (mix_snapshot_id) REFERENCES podcast_mix_snapshots(id) ON DELETE SET NULL;
  END IF;
END $$;
