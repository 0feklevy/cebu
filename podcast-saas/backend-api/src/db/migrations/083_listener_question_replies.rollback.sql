-- 083 rollback: drop the creator-reply columns. Safe at any time — the previous image never
-- selected them, and nothing else references the index or the constraint.
DROP INDEX IF EXISTS idx_listener_questions_replied;
ALTER TABLE listener_questions DROP CONSTRAINT IF EXISTS chk_listener_questions_source;
ALTER TABLE listener_questions DROP COLUMN IF EXISTS seen_at;
ALTER TABLE listener_questions DROP COLUMN IF EXISTS creator_replied_at;
ALTER TABLE listener_questions DROP COLUMN IF EXISTS creator_reply;
ALTER TABLE listener_questions DROP COLUMN IF EXISTS source;
