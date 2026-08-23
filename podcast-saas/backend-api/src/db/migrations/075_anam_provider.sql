-- Migration 075: add 'anam' to the provider enum.
--
-- Written during the 2026-08-23 avatar outage. Every other vendor's platform key is managed from
-- Admin -> API Keys (api_keys row with user_id NULL); the avatar could not be, because the enum
-- never listed its vendor -- so rotating the Anam key in the one screen that looks like the source
-- of truth changed nothing, and the avatar kept minting with the container's env var.
--
-- IF NOT EXISTS, same as 003: safe to re-run, and PG12+ allows ADD VALUE inside the runner's
-- transaction as long as the same transaction does not USE the value -- this file only adds it.
ALTER TYPE provider ADD VALUE IF NOT EXISTS 'anam';
