-- 040_generation_limit.sql
-- Admin-controlled per-user generation quota (security-101 cost-DoS guard). Ships DISABLED:
-- generation_limit_enabled defaults false (= unlimited) so behavior is unchanged until an admin
-- turns it on from the Controls page. When enabled, a user is capped at generation_daily_limit
-- billable LLM calls per rolling 24h.
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS generation_limit_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS generation_daily_limit integer NOT NULL DEFAULT 50;
