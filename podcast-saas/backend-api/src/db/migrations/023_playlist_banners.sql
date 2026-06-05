-- Playlist banners for full-screen playlist lobby/watch pages
ALTER TABLE playlists
  ADD COLUMN banner_url TEXT,
  ADD COLUMN banner_storage_key TEXT,
  ADD COLUMN banner_prompt TEXT,
  ADD COLUMN banner_provider TEXT;
