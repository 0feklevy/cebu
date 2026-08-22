-- Rollback for 072. Safe against the previous app image: nothing before 072 reads this table.
--
-- Unlike an audio edition, these rows are NOT derived — a listener's question cannot be rebuilt
-- from anything. Dropping the table destroys real user-contributed content and the demand signal
-- A2.5 waits on, so this is a rollback for a migration that failed to apply, not a routine undo.

DROP TABLE IF EXISTS listener_questions;
