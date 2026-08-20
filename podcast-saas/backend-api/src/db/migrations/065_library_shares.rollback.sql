-- Manual rollback helper for 065. Not run by the migration runner.
--
-- Dropping this table destroys every live share link: the public pages 404 immediately and the
-- slugs cannot be reconstructed, because the code half is 64 random bits held nowhere else. Do
-- that only when the feature is being abandoned. To roll back CODE alone, leave the table in
-- place — nothing else in the schema reads or writes it.
DROP TABLE IF EXISTS library_shares;
