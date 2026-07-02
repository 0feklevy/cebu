-- 042: Collaboration — invite users by email to co-edit a project or playlist.
-- Polymorphic (content_type + content_id), mirroring user_purchases (migration 024).
-- invited_email is stored lowercased; user_id is resolved at invite time when the
-- user already exists, otherwise matched by email at query time after they sign up.

CREATE TABLE IF NOT EXISTS collaborators (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type  TEXT NOT NULL CHECK (content_type IN ('project', 'playlist')),
  content_id    UUID NOT NULL,
  invited_email TEXT NOT NULL,
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  invited_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_type, content_id, invited_email)
);

CREATE INDEX IF NOT EXISTS idx_collaborators_content ON collaborators(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_collaborators_user    ON collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_collaborators_email   ON collaborators(invited_email);
