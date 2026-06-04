-- Playlists — ordered collections of projects played back-to-back, with their own share link
CREATE TABLE playlists (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES orgs(id),
  created_by        UUID         REFERENCES users(id),
  title             TEXT,
  description       TEXT,
  autoplay          BOOLEAN      NOT NULL DEFAULT true,
  show_sidebar      BOOLEAN      NOT NULL DEFAULT true,
  allow_shuffle     BOOLEAN      NOT NULL DEFAULT true,
  share_token       TEXT         UNIQUE DEFAULT NULL,
  share_enabled_at  TIMESTAMPTZ  DEFAULT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_playlists_share_token
  ON playlists(share_token)
  WHERE share_token IS NOT NULL;

CREATE TABLE playlist_items (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id  UUID         NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  project_id   UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position     INTEGER      NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (playlist_id, project_id)
);

CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id);
