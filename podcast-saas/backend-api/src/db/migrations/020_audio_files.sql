-- Audio files table — stores user-uploaded sound files (wav, mp3, m4a, etc.)
CREATE TABLE audio_files (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename      TEXT         NOT NULL,
  storage_key   TEXT         NOT NULL,
  url           TEXT         NOT NULL,
  duration_sec  REAL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Allow timeline_sections to reference an audio file as the clip source (audio-only cutaway)
ALTER TABLE timeline_sections
  ADD COLUMN clip_source_audio_id UUID REFERENCES audio_files(id) ON DELETE SET NULL;
