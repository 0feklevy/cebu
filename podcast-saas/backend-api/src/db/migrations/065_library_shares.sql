-- 065: one shareable link per project pointing at that project's MATERIALS — its simulations,
-- images, video files and sounds — rendered as a small public page.
--
-- WHY A TABLE AND NOT COLUMNS ON `projects`
-- A share link is created, scoped, optionally expired and revoked, and after revocation you still
-- want to know it existed. `projects` already carries two link lifecycles as loose columns
-- (`share_token` for /v/, `slug` for the permalink) and that is precisely why neither has an audit
-- trail, an expiry or a rotation story. A row gets all three and adds nothing to the hottest row
-- in the schema.
--
-- WHY THE CODE IS IN THE SLUG AND NOT A QUERY PARAM
-- `slug` is `slugify(projects.title) + '-' + code`, so the capability travels inside the path
-- segment. One URL form means ONE ISR cache key per share, which is what makes revocation a
-- complete operation ("purge one tag") rather than a hopeful one. It also decouples the link from
-- `projects.slug`, which the creator may edit or clear at any time through the permalink editor.
--
-- ZERO BUCKET OBJECTS. This feature writes no storage: the page re-emits URLs the materials
-- already have. The only bytes it adds are this row, ~250 of them, cascaded away with the project.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS library_shares (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The public path segment. Carries the code as its suffix, so it IS the capability.
  slug          text NOT NULL,
  -- The 13-char base32 capability (64 bits of entropy), also the slug suffix. Never emitted in a
  -- public response body — the visitor already holds it, in the URL.
  code          text NOT NULL,
  include_types text[] NOT NULL DEFAULT ARRAY['simulation','image','video','audio'],
  expires_at    timestamptz,
  revoked_at    timestamptz,
  -- A CACHE-MISS COUNTER, NOT A VISITOR COUNTER. The public page is ISR-cached for 60 seconds, so
  -- N visitors in a minute produce at most one increment. It undercounts by design; that is the
  -- price of not firing an unbounded per-request UPDATE against a ten-connection pool. Nobody may
  -- read this column as analytics.
  render_count  integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_shares_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT library_shares_types_chk CHECK (
    include_types <@ ARRAY['simulation','image','video','audio']::text[]
    AND array_length(include_types, 1) >= 1)
);

-- The slug is the capability, so it must be globally unique across every share ever minted —
-- including revoked ones, whose slug must never be reissued to a different project.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_library_shares_slug ON library_shares(slug);

-- Phase 1 is one LIVE link per project. Partial, so revoked rows accumulate freely as the audit
-- trail; lifting the one-link limit later (per-recipient scopes) drops this index and needs no
-- second migration.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_library_shares_live ON library_shares(project_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_library_shares_project ON library_shares(project_id);
