-- 067: multi-language dubbing — one row per (video, target language, provider).
--
-- NUMBERING: 065 is claimed by feat/library-share-impl (library_shares) and 066 by feat/crop-v2,
-- both in flight at the time this was written. 067 is the first genuinely free number.
--
-- WHY A CHILD TABLE AND NOT MORE COLUMNS ON video_files
-- `video_files.captions_vtt` is a single TEXT column holding one WebVTT document, and there is no
-- language dimension anywhere in that table. The product plan (a /he, /es, /en switcher inside the
-- player) cannot be expressed by adding columns: the cardinality is per-language, not per-video.
-- The shape below follows `hls_retired_runs` (053) — a per-video child table with its own status
-- machine and its own sweep — rather than widening the parent row.
--
-- WHY THE UNIQUE CONSTRAINT IS LOAD-BEARING
-- ElevenLabs' dubbing create endpoints accept NO idempotency key: neither `POST /v1/dubbing` nor
-- `POST /v1/dubbing/project` has one, so a retried create is a NEW, separately-billed job at
-- roughly 3,000 credits per source-minute per language — by a wide margin the most expensive
-- per-unit operation in this product. A crashed worker that retries on restart would double-bill
-- silently, with no error to notice.
--
-- UNIQUE (video_file_id, target_language, provider) is the LAST line of that defence, not the
-- first. The first is the atomic CAS claim plus `source_hash`, copied from CaptionService's
-- `captions_source_hash` pattern; the second is `el_project_id` being persisted so a retry RESUMES
-- an existing project instead of creating another; the third is a pre-create reconciliation that
-- looks the job up on the vendor by its `reference` before spending anything. The constraint is
-- what holds when all three are somehow bypassed at once.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS video_dubs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_file_id      UUID        NOT NULL REFERENCES video_files(id) ON DELETE CASCADE,

  -- BCP-47, and deliberately the SAME check regex `courses.language` already carries, so one
  -- language tag means the same thing in both places. ElevenLabs' v2 project surface documents
  -- `target_language` as BCP-47; the classic surface says ISO-639. For every code this product
  -- ships (he, es, en) the two agree, and the regex accepts both.
  target_language    TEXT        NOT NULL,

  -- 'elevenlabs' (dubbed audio + its own translated captions) or 'whisper+llm' (captions only,
  -- no dubbed audio). These must never be mixed for one language: two independent translations of
  -- the same source diverge, and a viewer would read one wording while hearing another.
  provider           TEXT        NOT NULL DEFAULT 'elevenlabs',

  -- Vendor identifiers. `el_project_id` is the v2 project; `el_language_id` is the language target
  -- inside it. `el_dubbing_id` is the seam for the classic surface — nothing writes it today.
  el_project_id      TEXT,
  el_language_id     TEXT,
  el_dubbing_id      TEXT,

  -- queued | processing | completed | stale | failed — the vendor's own language-target enum, so
  -- the two cannot drift. NB the vendor's PROJECT status uses a different set (…|ready|failed),
  -- and `ready` there means "transcription finished", never "a dub exists".
  status             TEXT        NOT NULL DEFAULT 'queued',

  audio_key          TEXT,       -- dubbed lossless audio, as downloaded
  muxed_video_key    TEXT,       -- source video + dubbed audio, muxed locally (see below)
  hls_master_key     TEXT,       -- per-language HLS rendition built from the muxed file
  captions_vtt       TEXT,       -- translated WebVTT, derived from THIS dub's own segments

  -- Idempotency, mirroring video_files.captions_source_hash exactly.
  source_hash        TEXT,

  -- Staleness (vendor semantics): `revision` counts transcript edits, `output_revision` records
  -- which revision the current output was generated from. A `stale` target KEEPS its old
  -- `outputs`, so "outputs is non-null" does NOT mean fresh — only revision equality does.
  revision           INTEGER,
  output_revision    INTEGER,

  -- What this dub cost, in the same fractional cents `token_usage.cost_cents` uses, plus the
  -- minutes it was billed on. Minutes are kept because per-minute is the number that gets
  -- reconciled against the vendor invoice, and a cents figure alone cannot be re-derived.
  billed_minutes     DOUBLE PRECISION,
  cost_cents         DOUBLE PRECISION,

  -- WATERMARKING IS A PLAN PROPERTY, AND A WATERMARKED DUB IS NOT SHIPPABLE.
  -- The vendor documents dubbing as available on every plan "including the free plan", but dubs
  -- generated on free plans are automatically watermarked. The v2 project surface exposes NO
  -- watermark field on either the create call or the language resource, so this cannot be read
  -- back off a response — it follows from which plan the API key belongs to.
  --
  -- It is therefore a CONFIG fact (see dubbingWatermarkPolicy in services/dubbing/config.ts), not
  -- something code infers. Recording it per row matters because the plan can change underneath a
  -- library of existing dubs, and "was this rendition produced under a watermarking plan?" then
  -- has to be answerable per rendition rather than globally. A row with watermarked = true is
  -- never served to a viewer.
  watermarked        BOOLEAN     NOT NULL DEFAULT false,

  error              TEXT,
  claimed_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT video_dubs_language_format_chk
    CHECK (target_language ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'),
  CONSTRAINT video_dubs_status_chk
    CHECK (status IN ('queued', 'processing', 'completed', 'stale', 'failed')),
  CONSTRAINT video_dubs_provider_chk
    CHECK (provider IN ('elevenlabs', 'whisper+llm')),

  -- The last line of the double-billing defence. See the header.
  CONSTRAINT uniq_video_dubs_video_lang_provider
    UNIQUE (video_file_id, target_language, provider)
);

-- The player's read path: "which languages does this video have ready?"
CREATE INDEX IF NOT EXISTS idx_video_dubs_video ON video_dubs (video_file_id);

-- The reconciliation sweep's read path: "which dubs are mid-flight, and since when?"
CREATE INDEX IF NOT EXISTS idx_video_dubs_status_claimed ON video_dubs (status, claimed_at);

-- Resume-by-vendor-id, used when a crashed worker's project has to be found again.
CREATE INDEX IF NOT EXISTS idx_video_dubs_el_project ON video_dubs (el_project_id)
  WHERE el_project_id IS NOT NULL;

-- ── The workspace concurrency gate ───────────────────────────────────────────────────────────
--
-- ElevenLabs allows 3 concurrent dubbing jobs PER WORKSPACE, and this deployment has exactly one
-- workspace: every tenant's dubs contend for the same three slots, and exceeding the ceiling
-- returns `too_many_concurrent_requests`. That is a property of the vendor account, not of any one
-- worker process, so pg-boss's `localConcurrency` cannot express it — that number is per-process,
-- and two worker containers each running "one at a time" is two concurrent jobs, not one.
--
-- These fixed rows are the cluster-wide bound. A worker claims one with
-- `... FOR UPDATE SKIP LOCKED LIMIT 1`, which is atomic under concurrency in a way that
-- "count the busy ones, then take one if there is room" is not: two transactions cannot select the
-- same row, and a transaction that finds none free knows the pool is genuinely full.
--
-- A slot is a LEASE, not a lock: it expires on its own. Nothing a worker does — including dying
-- mid-job — can hold a slot past `expires_at`, so a crash costs at most one lease period of
-- throughput rather than permanently shrinking the pool. Same reasoning as avatar_session_leases
-- (064), for the same reason: a release that only happens on the happy path is not a release.
CREATE TABLE IF NOT EXISTS dubbing_slots (
  slot_no    INTEGER     PRIMARY KEY,
  holder     TEXT,                    -- the video_dubs.id currently holding it (diagnostics)
  expires_at TIMESTAMPTZ,             -- NULL or in the past ⇒ free
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Three rows because the vendor ceiling is three. Seeded here rather than created on demand so the
-- pool size is a schema fact an operator can read, and so the claim query is a plain UPDATE with
-- nothing to create. Lowering the ceiling is a DELETE; raising it past 3 would exceed the vendor
-- limit and is not something code should do on its own.
INSERT INTO dubbing_slots (slot_no) VALUES (1), (2), (3)
ON CONFLICT (slot_no) DO NOTHING;
