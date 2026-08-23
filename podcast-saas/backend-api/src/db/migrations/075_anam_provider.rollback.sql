-- Postgres cannot remove an enum value in place. Rolling this back would mean rebuilding the type
-- and every column using it; an unused extra value is harmless, so the rollback is a no-op.
SELECT 1;
