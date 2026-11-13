-- Files no longer have a read-only flag of their own (007_read_only.sql):
-- who may write, rename or delete a file is decided by roles alone, like
-- everything else here (a node's or the root's editors, an experiment's
-- author while it isn't archived). Files that were read-only, such as a
-- run's generated models/general_rules.md or an experiment's linked inputs,
-- become ordinary files.
ALTER TABLE files DROP COLUMN read_only;
-- Docker matrix test (#228): migration-only change.
