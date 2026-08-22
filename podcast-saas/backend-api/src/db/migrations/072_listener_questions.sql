-- 072 — Raise Your Hand (P3-B / A2.4): a listener's question, at the moment they had it.
--
-- ── WHO PAYS DECIDES THE SHAPE OF THIS TABLE ─────────────────────────────────────────────────
-- The asking surface is PUBLIC and the project owner pays for every answer. An anonymous request
-- that turns into an LLM call is a way to spend someone else's money, so two things are structural
-- rather than policy: a question can exist WITHOUT an answer (costing nothing), and answers are
-- countable per project per day so a cap can be enforced by asking the database rather than by
-- trusting a counter in a process that restarts.
--
-- `answered_at` is the billable event, not `created_at`. A question saved while driving and never
-- answered has no `answered_at`, which is what makes the daily count a count of SPEND.

CREATE TABLE IF NOT EXISTS listener_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Which edition they were listening to. NULL = the source-language one, matching
  -- project_audio_editions' own convention (migration 071).
  language      text,

  -- Where in the lesson the question was asked. This is the whole point of the feature: the same
  -- words mean different questions at minute 2 and minute 40.
  position_ms   integer NOT NULL,

  question      text NOT NULL,
  answer        text,

  -- NULL for an anonymous listener, which is the common case: the audio page is public and asking
  -- must not require an account. The row is still useful to the creator without one.
  asked_by      uuid REFERENCES users(id) ON DELETE SET NULL,

  -- 'saved'    — recorded, never sent to a model, costs nothing. The driving path, and where a
  --              capped or disabled question lands rather than being discarded.
  -- 'answered' — a model was called and the owner was billed.
  -- 'failed'   — a model was called and did not return a usable answer.
  status        text NOT NULL DEFAULT 'saved',

  -- Set only when an answer was actually produced. THE BILLABLE TIMESTAMP: the daily cap counts
  -- rows by this column, so a saved question can never consume budget.
  answered_at   timestamptz,
  cost_cents    integer,

  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The creator's view: everything asked about one lesson, newest first.
CREATE INDEX IF NOT EXISTS idx_listener_questions_project
  ON listener_questions (project_id, created_at DESC);

-- THE CAP'S OWN INDEX. Counting answers for one project in one window is the query that runs
-- before every paid answer, so it must not be a sequential scan over every question ever asked.
-- Partial on `answered_at IS NOT NULL` because saved questions are the majority and none of them
-- can affect the count.
CREATE INDEX IF NOT EXISTS idx_listener_questions_billing
  ON listener_questions (project_id, answered_at)
  WHERE answered_at IS NOT NULL;
