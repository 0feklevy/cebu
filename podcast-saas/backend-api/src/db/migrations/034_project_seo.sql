-- Transcript-derived SEO for a video/project. After captions are generated, the
-- transcript is summarised into an SEO description + keywords that describe what
-- the video is about. These feed the public course/lesson meta tags (preferred
-- over the thumbnail-vision `topic` and used for <meta name="keywords">).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS seo_description TEXT;
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS seo_keywords TEXT;
