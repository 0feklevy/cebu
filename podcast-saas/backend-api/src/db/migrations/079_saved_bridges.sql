-- 079: "save bridge" — a section's bridge setup, saved under a name, loadable on another sim.
--
-- ── WHAT A SAVED BRIDGE ACTUALLY IS ───────────────────────────────────────────────────────────
-- The work a user does in Edit Section's simulation column has four layers with wildly different
-- portability, and the table stores them in two groups because loading treats them differently:
--
--   THE RECIPE — prompt, the Simple-UI/Auto-Script toggles, the minimal-UI control selection.
--   Pure intent and pure data. Applies to ANY simulation: at worst a selector in the hide-list
--   does not exist on the target and is reported stale (the codebase already treats that as
--   degrade-not-block).
--
--   THE ARTIFACT — the generated script BODY. This is code, not configuration: it binds by NAME
--   to one simulation's DOM ids, label texts and window.* API ("plucking a boid with one button"
--   is a sentence about window.__murmuration). Pointed at different content it finds nothing and
--   no-ops SILENTLY — the exact failure SimBridgeContract.ts exists to prevent. So the artifact
--   is applied only after `verifyContract` proves every anchor it needs exists in the target;
--   otherwise the load falls back to regenerating from the recipe, which still skips all the
--   authoring work — the actual value of the feature.
--
-- ── WHY THE BODY IS COPIED IN, NOT REFERENCED ─────────────────────────────────────────────────
-- The body's home is `package/bridge.js` inside a sim REVISION in object storage, keyed by the
-- timeline section id it was generated for. Revisions get retired and GC'd, sections get deleted,
-- and a preset must outlive both — outliving its source is its purpose. So the save stores the
-- BARE body (dispatch key stripped; applying re-keys it for the target section, the same surgery
-- project duplication already performs), plus the precomputed contract so the load can judge
-- compatibility without re-parsing.
--
-- ── OWNED BY THE USER, NOT A PROJECT ──────────────────────────────────────────────────────────
-- The point is crossing project boundaries. Project-scoped rows would vanish with the project and
-- be invisible elsewhere. ON DELETE CASCADE from users: presets are the account's own authored
-- content and go with it.

CREATE TABLE IF NOT EXISTS saved_bridges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text NOT NULL,

  -- ── THE RECIPE — always applicable ──────────────────────────────────────────────────────────
  sim_prompt   text,
  simple_ui    boolean NOT NULL DEFAULT false,
  auto_script  boolean NOT NULL DEFAULT true,
  -- SimUiSelection ({controls, show, hide}) — validated against SimUiSelectionSchema on write
  -- AND on apply: this table is a new ingress for selectors, and the unsafe-selector guard
  -- (SIM_UI_UNSAFE_SELECTOR_RE) must hold at every ingress or it holds at none.
  ui_controls  jsonb,

  -- ── THE ARTIFACT — applied only when the contract verifies against the target ───────────────
  -- The bare section body (no dispatch key, no wrapper). Null when the source section had no
  -- generated script — a recipe-only preset is a perfectly good preset.
  main_body    text,
  -- extractBridgeContract(main_body), precomputed at save: {ids, selectors, texts, classes,
  -- globals, members}. Stored so a load can render "this preset needs #speed, .controls,
  -- window.__murmuration.pluck — this sim provides none of them" without parsing JS.
  contract     jsonb,

  -- ── PROVENANCE — display and drift detection only, never a hard link ────────────────────────
  source_simulation_id uuid REFERENCES simulations(id) ON DELETE SET NULL,
  source_bridge_hash   text,
  source_hash          text,
  -- Refinement continuity: lets a future generation continue the conversation that produced this.
  conversation_history jsonb,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_bridges_label_len CHECK (char_length(label) BETWEEN 1 AND 120)
);

-- Saving again under the same name is an UPDATE of that preset, not a sibling. Case-sensitive on
-- purpose: renaming is cheap; silently merging "Boids" into "boids" is not.
CREATE UNIQUE INDEX IF NOT EXISTS saved_bridges_owner_label_idx ON saved_bridges (created_by, label);
-- The list screen: a user's presets, newest first.
CREATE INDEX IF NOT EXISTS saved_bridges_owner_idx ON saved_bridges (created_by, created_at DESC);
