ALTER TABLE project_exports DROP CONSTRAINT IF EXISTS project_exports_degradation_policy_check;
ALTER TABLE project_exports DROP COLUMN IF EXISTS degradation_policy;
