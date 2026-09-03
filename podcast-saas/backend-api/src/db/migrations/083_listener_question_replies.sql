-- 083: the creator's half of Raise Your Hand (owner ruling 2026-09-03: the listener-question
-- inbox is the next product priority — "Listener → question → Creator Inbox → answer").
--
-- Migration 072 recorded the listener's question and the MODEL's answer. Nothing recorded what the
-- creator said back, whether the creator had even seen the question, or whether it was typed or
-- spoken. Four additive columns:
--
--   source              'text' | 'voice' — the spoken path stores its transcript as the question
--                       (VoiceQuestionService), and the inbox shows which it was.
--   creator_reply       what the creator wrote back. NULL = unanswered by the creator; the model's
--                       `answer` is a different thing and stays where it is.
--   creator_replied_at  when. Indexed per project so the public audio page can list the replied
--                       questions for a language cheaply.
--   seen_at             when the creator first opened the inbox after this row existed — the
--                       unread count is `seen_at IS NULL`.
--
-- Expand-only: the previous image never selects these columns, and every reader treats NULL as
-- "no reply / not seen / typed". Do not write BEGIN/COMMIT — migrate.ts wraps each file.

ALTER TABLE listener_questions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'text';
ALTER TABLE listener_questions ADD COLUMN IF NOT EXISTS creator_reply text;
ALTER TABLE listener_questions ADD COLUMN IF NOT EXISTS creator_replied_at timestamptz;
ALTER TABLE listener_questions ADD COLUMN IF NOT EXISTS seen_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_listener_questions_source'
  ) THEN
    ALTER TABLE listener_questions
      ADD CONSTRAINT chk_listener_questions_source CHECK (source IN ('text', 'voice'));
  END IF;
END $$;

-- The public audio page asks "which questions at this language have a creator reply" — a partial
-- index over exactly those rows, ordered the way the page reads them.
CREATE INDEX IF NOT EXISTS idx_listener_questions_replied
  ON listener_questions (project_id, language, position_ms)
  WHERE creator_replied_at IS NOT NULL;
