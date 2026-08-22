-- Rollback for 071. Drops the table and every index with it.
--
-- Safe to run against the PREVIOUS app image: nothing before 071 reads or writes this table, so
-- removing it cannot break a rolled-back deploy. The editions themselves are DERIVED artifacts —
-- rebuilding one is a single cheap ffmpeg pass — so the data loss here is recoverable work rather
-- than customer content. The stored objects in the bucket are left alone deliberately: an
-- orphaned m4a costs pennies, and a rollback that deletes storage is a rollback nobody dares run.

DROP TABLE IF EXISTS project_audio_editions;
