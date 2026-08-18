-- The frozen execution snapshot, and the columns that keep it frozen.
--
-- An export used to be planned twice: once in the controller to answer the user, and again in the
-- worker, minutes or hours later. The project is fully editable in between, so the video that was
-- described and the video that was produced were only ever probably the same — and consent was worse
-- than that, because the user agreed to one set of substitutions and the worker applied whatever the
-- second plan happened to need.
--
-- `plan_fingerprint` names one exact plan (SHA-256 over a canonical form, domain-separated), so the
-- stored snapshot can be verified before it runs and consent can be bound to it.
--
-- `effective_plan` and `failure` exist so `plan` NEVER has to be rewritten. Runtime results were
-- previously merged into `plan` with a jsonb `||`, which meant the record of what we were asked to
-- make was overwritten by the record of what happened — and after a bad export that is the first
-- question anybody asks. Substitutions, renderer identity and runtime warnings now land in
-- `effective_plan`; the reason a run stopped lands in `failure`.
--
-- Backfill: existing rows have no snapshot and never had one. They are left NULL rather than given a
-- fingerprint over a plan that was not frozen when it ran — a fingerprint that claimed a guarantee
-- retroactively would be worse than an honest absence, because the verifier would believe it.
ALTER TABLE project_exports
  ADD COLUMN IF NOT EXISTS plan_fingerprint text,
  ADD COLUMN IF NOT EXISTS effective_plan jsonb,
  ADD COLUMN IF NOT EXISTS failure jsonb;

ALTER TABLE project_exports
  DROP CONSTRAINT IF EXISTS project_exports_plan_fingerprint_check;
ALTER TABLE project_exports
  ADD CONSTRAINT project_exports_plan_fingerprint_check
  CHECK (plan_fingerprint IS NULL OR plan_fingerprint ~ '^[0-9a-f]{64}$');

-- Answering "is this export already running this exact plan?" is a per-project lookup on every
-- start, and the fingerprint is what consent is checked against.
CREATE INDEX IF NOT EXISTS project_exports_fingerprint_idx
  ON project_exports (project_id, plan_fingerprint);
