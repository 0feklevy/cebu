DROP INDEX IF EXISTS project_exports_fingerprint_idx;
ALTER TABLE project_exports DROP CONSTRAINT IF EXISTS project_exports_plan_fingerprint_check;
ALTER TABLE project_exports
  DROP COLUMN IF EXISTS plan_fingerprint,
  DROP COLUMN IF EXISTS effective_plan,
  DROP COLUMN IF EXISTS failure;
