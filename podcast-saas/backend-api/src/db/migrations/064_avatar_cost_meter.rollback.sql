-- Manual rollback helper for 064. Not run by the migration runner.
--
-- These tables are read and written by nothing except the avatar cost meter, and the meter degrades
-- to its in-process burst shield when they are absent, so a CODE rollback needs no schema change —
-- leave them in place. Dropping them discards the current hour's reservations and every live
-- session lease, which means the concurrency bound restarts from zero. Do that only when the
-- feature is being abandoned, not to roll back a deploy.
DROP TABLE IF EXISTS avatar_budget_state;
DROP TABLE IF EXISTS avatar_session_leases;
DROP TABLE IF EXISTS avatar_cost_ledger;
