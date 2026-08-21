-- 068 — the language a project's video is ALREADY in.
--
-- Dubbing offered every supported language as a target, including the one the video is spoken in.
-- Dubbing English into English is not a no-op: it is a full billable vendor run (~$2.20 per source
-- minute) that returns a worse copy of what you started with. The product could not prevent it
-- because it never knew the source language — `DUBBING_SOURCE_LANGUAGE` is a single global env var,
-- which is meaningless for a multi-tenant catalogue where two projects can be in two languages.
--
-- NULL means "not declared", which is a real state and not a missing value: the vendor auto-detects
-- when `source_language` is omitted, so a null here still dubs correctly. What null costs is only
-- the UI's ability to grey out the source, so the column is nullable rather than defaulted to 'en'
-- — guessing English for an existing Hebrew project would be a confident wrong answer, and the
-- creator would then be shown their own language as a paid target.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_language TEXT;

-- Same shape the language columns elsewhere enforce, so a malformed tag is refused here rather
-- than at the vendor after the money is committed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_source_language_shape') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_source_language_shape
      CHECK (source_language IS NULL OR source_language ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$');
  END IF;
END $$;
