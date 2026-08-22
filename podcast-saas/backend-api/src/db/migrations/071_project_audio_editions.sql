-- 071 — Audio editions (P3-B / A2.1): the listenable form of a project that already exists.
--
-- The owner's reframing governs the whole feature: START FROM THE VIDEO THAT ALREADY EXISTS.
-- There is no second generation pipeline here. An edition is DERIVED from a project's existing
-- narration, guidance audio, sections and captions — one ffmpeg pass, cheap, on the ordinary
-- pg-boss queue rather than the GPU export path.
--
-- ONE ROW PER (project, language). A dubbed project's audio edition reuses that dub's mix and ITS
-- captions, which is why `language` is part of the identity rather than a column that gets
-- overwritten: `/{slug}/audio` and `/{slug}/he/audio` are different artifacts a listener may hold
-- links to at the same time.
--
-- NULL LANGUAGE MEANS THE SOURCE TRACK, and it is deliberately not the empty string. Postgres
-- treats NULLs as distinct in a plain UNIQUE index, so the uniqueness has to be expressed as two
-- partial indexes — one for the source edition, one per dubbed language. Written out rather than
-- worked around with a sentinel value, because a sentinel would then have to be honoured by every
-- query that joins on language, and one that forgot would silently read another language's audio.

CREATE TABLE IF NOT EXISTS project_audio_editions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- NULL = the project's source language. Otherwise a BCP-47 code matching a completed dub.
  language         text,

  -- none | processing | ready | failed. Mirrors captions_status/crop_status so the four
  -- derived-artifact pipelines in this schema stay readable as one pattern.
  status           text NOT NULL DEFAULT 'none',

  -- IDEMPOTENCY, the same discipline captions and crop already use. Hashes the inputs that can
  -- change the output — segment media keys, section boundaries, caption text. A re-run whose hash
  -- matches does nothing and costs nothing; a source edit changes the hash and the edition
  -- rebuilds. Without it, "regenerate" is either always-work or never-work and both are wrong.
  source_hash      text,

  m4a_key          text,
  duration_ms      integer,

  -- Chapter marks derived from timeline_sections, stored WITH the artifact rather than recomputed
  -- at read time. The sections can be edited after an edition is built, and a chapter list that
  -- silently disagrees with the audio it labels is worse than no chapter list.
  chapters_json    jsonb,

  -- The edition's own captions, re-emitted from the source VTT with segment offsets applied.
  -- Held here for the same reason as chapters: the source captions may move underneath it.
  captions_vtt     text,

  error            text,

  -- Claimed by the worker; a stale claim is how a crashed job gets recovered rather than
  -- sitting in `processing` forever.
  claimed_at       timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_audio_editions_project
  ON project_audio_editions (project_id);

-- Exactly one SOURCE edition per project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_audio_editions_source
  ON project_audio_editions (project_id)
  WHERE language IS NULL;

-- Exactly one edition per project per dubbed language.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_audio_editions_language
  ON project_audio_editions (project_id, language)
  WHERE language IS NOT NULL;

-- Finding work: the claimer scans by status, and only ever for rows that are not already claimed.
CREATE INDEX IF NOT EXISTS idx_project_audio_editions_status
  ON project_audio_editions (status, claimed_at);
