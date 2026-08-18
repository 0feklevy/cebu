-- 064: a durable, weighted meter for the billable avatar endpoints.
--
-- WHAT WAS WRONG
-- `/avatar/start` minted a billable vendor session, and `/avatar/visual/analyze` and
-- `/avatar/image/analyze` ran billable model calls, for anyone who could POST. The only bound was
-- an in-process fixed-window counter keyed on the raw request IP: private to one replica, reset by
-- every deploy, and blind to what a request actually costs — a no-op reply and a call that runs two
-- gpt-image-1 renders each counted as exactly one.
--
-- These three tables are the half of the fix that cannot live in a process: a limit that means the
-- same thing on every replica and survives a restart, and an emergency stop that does not need one.
--
-- WHY THE SUBJECT COLUMNS HOLD HASHES AND NOT IDS
-- `subject` and `project_subject` are short-retention HMACs (see services/usage/avatarBudget.ts),
-- salted with the UTC day. An IP is personal data and a limiter needs identity, not the value, so
-- no raw IP is written here or anywhere else; rotating the salt daily makes every stored identifier
-- unlinkable to its input after 24h with nothing having to delete it. Project and user ids go
-- through the same helper so one column cannot leak which kind of subject a row describes.
--
-- The same choice is why there is NO foreign key to `projects` or `users`: a hash has nothing to
-- reference. It also keeps the meter free of cascade coupling — deleting a project must not be
-- able to erase the record of what its viewers already spent.

-- Fail fast rather than queue behind a long transaction: a deploy that cannot get its locks
-- promptly should abort and leave the previous version serving. LOCAL so the setting dies with
-- this migration's transaction instead of leaking into the session that follows it.
SET LOCAL lock_timeout = '3s';

-- ── The ledger ───────────────────────────────────────────────────────────────────────────────
--
-- One row per (layer, subject, hour). The primary key is what makes a reservation atomic: the
-- service reserves with a single INSERT … ON CONFLICT … DO UPDATE … WHERE, so Postgres holds the
-- row lock across the read-modify-write and two concurrent reservations cannot both observe the
-- pre-increment total. Application-side "SELECT the total, then UPDATE" cannot do that.
--
-- `units` is WEIGHTED cost, not a request count — one unit is about one minute of vendor avatar
-- session. The weights live with the handlers that spend, in services/usage/avatarBudget.ts.
CREATE TABLE IF NOT EXISTS avatar_cost_ledger (
  dimension    TEXT        NOT NULL,
  subject      TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  units        INTEGER     NOT NULL DEFAULT 0 CHECK (units >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dimension, subject, window_start)
);

-- Serves the sweep only. The reservation path is a primary-key lookup and needs nothing else.
CREATE INDEX IF NOT EXISTS avatar_cost_ledger_window_idx
  ON avatar_cost_ledger (window_start);

-- ── The session leases ───────────────────────────────────────────────────────────────────────
--
-- `/avatar/end` is a no-op that any client may simply never call, so a live vendor session cannot
-- be counted by "starts minus ends". A lease instead EXPIRES ON ITS OWN after the worst-case
-- billable session length; nothing a caller does shortens it.
--
-- Keyed by the capability's jti rather than by a random per-start id, so one popup open that
-- retries its start five times holds one lease rather than five — the same identity the unit
-- ledger meters, which is the point of minting a nonce at all.
CREATE TABLE IF NOT EXISTS avatar_session_leases (
  jti             TEXT        PRIMARY KEY,
  project_subject TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS avatar_session_leases_live_idx
  ON avatar_session_leases (expires_at);
CREATE INDEX IF NOT EXISTS avatar_session_leases_project_idx
  ON avatar_session_leases (project_subject, expires_at);

-- ── The kill switch ──────────────────────────────────────────────────────────────────────────
--
-- One row, flipped by an operator, honoured by every replica on its next billable request. There
-- is an env-var twin (AVATAR_KILL_SWITCH) that costs no query, but an env var needs a deploy to
-- change, and the moment you want a kill switch is the moment you do not want to wait for one.
--
-- This row binds even while the meter runs in shadow mode: shadow means "do not enforce the
-- budgets yet", never "ignore the emergency stop".
CREATE TABLE IF NOT EXISTS avatar_budget_state (
  id         INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  killed     BOOLEAN     NOT NULL DEFAULT false,
  reason     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The singleton must exist before the first request reads it. A missing row would read as "no
-- opinion", which is the right default, but an operator cannot flip a row that is not there.
INSERT INTO avatar_budget_state (id, killed) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;
