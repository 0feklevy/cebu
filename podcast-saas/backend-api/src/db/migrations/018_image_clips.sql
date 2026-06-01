-- Image files table — stores user-uploaded still images for animated overlays
CREATE TABLE image_files (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename      TEXT         NOT NULL,
  storage_key   TEXT         NOT NULL,
  original_url  TEXT         NOT NULL,
  width         INTEGER,
  height        INTEGER,
  -- Crop region as fractions of the original image (0.0–1.0)
  crop_x        REAL         NOT NULL DEFAULT 0,
  crop_y        REAL         NOT NULL DEFAULT 0,
  crop_w        REAL         NOT NULL DEFAULT 1,
  crop_h        REAL         NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Allow timeline_sections to reference an image file as the clip source
ALTER TABLE timeline_sections
  ADD COLUMN clip_source_image_id UUID REFERENCES image_files(id) ON DELETE SET NULL,
  ADD COLUMN camera_movement      TEXT NOT NULL DEFAULT 'zoom_in';
